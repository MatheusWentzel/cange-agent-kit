import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { EXIT_CODES, exitCodeForBatch } from "../src/cli/exit-codes.js";
import { CangeApiError, CangeValidationError } from "../src/client/errors.js";
import { runBatch } from "../src/utils/batchRunner.js";

const envBackup = { ...process.env };
const noSleep = async () => {};

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("runBatch", () => {
  it("devolve um desfecho por item quando tudo passa", async () => {
    const report = await runBatch(["a", "b", "c"], { rps: 1000, maxRetries: 0, sleep: noSleep }, async (item) => `card-${item}`);

    expect(report.aborted).toBeUndefined();
    expect(report.results.map((result) => result.value)).toEqual(["card-a", "card-b", "card-c"]);
    expect(report.results.every((result) => result.ok && result.attempted)).toBe(true);
  });

  it("PARA o lote no 429 e marca o restante como não tentado", async () => {
    const seen: string[] = [];
    const report = await runBatch(
      ["a", "b", "c", "d"],
      { rps: 1000, maxRetries: 0, sleep: noSleep },
      async (item) => {
        seen.push(item);
        if (item === "b") {
          throw new CangeApiError("limite atingido", { status: 429, retryAfterSeconds: 300 });
        }
        return `card-${item}`;
      }
    );

    // Não pode martelar uma chave bloqueada: "c" e "d" nem são tentados.
    expect(seen).toEqual(["a", "b"]);
    expect(report.aborted).toMatchObject({ reason: "RATE_LIMIT_BLOCK", retryAfterSeconds: 300 });
    expect(report.results.map((result) => ({ ok: result.ok, attempted: result.attempted }))).toEqual([
      { ok: true, attempted: true },
      { ok: false, attempted: true },
      { ok: false, attempted: false },
      { ok: false, attempted: false }
    ]);
  });

  it("segue o lote quando o erro é do payload (4xx), sem abortar", async () => {
    const report = await runBatch(
      ["a", "b", "c"],
      { rps: 1000, maxRetries: 2, sleep: noSleep },
      async (item) => {
        if (item === "b") {
          throw new CangeApiError("campo obrigatório ausente", { status: 400 });
        }
        return `card-${item}`;
      }
    );

    expect(report.aborted).toBeUndefined();
    expect(report.results.map((result) => result.ok)).toEqual([true, false, true]);
    // 4xx definitivo não gasta retry.
    expect(report.results[1]?.attempts).toBe(1);
  });

  it("repete erro transitório e conta as tentativas gastas", async () => {
    let calls = 0;
    const report = await runBatch(["a"], { rps: 1000, maxRetries: 3, sleep: noSleep }, async () => {
      calls += 1;
      if (calls < 3) {
        throw new CangeApiError("instabilidade", { status: 503 });
      }
      return "card-a";
    });

    expect(report.results[0]).toMatchObject({ ok: true, attempts: 3, value: "card-a" });
  });
});

describe("exitCodeForBatch", () => {
  it("0 quando nada falhou", () => {
    expect(exitCodeForBatch({ succeeded: 3, failed: 0 })).toBe(EXIT_CODES.SUCCESS);
  });

  it("5 (PARTIAL) quando parte passou e parte não", () => {
    expect(exitCodeForBatch({ succeeded: 20, failed: 8, firstError: new CangeApiError("429", { status: 429 }) })).toBe(
      EXIT_CODES.PARTIAL
    );
  });

  it("categoria do erro quando NADA passou", () => {
    expect(exitCodeForBatch({ succeeded: 0, failed: 2, firstError: new CangeApiError("api", { status: 429 }) })).toBe(
      EXIT_CODES.API
    );
    expect(exitCodeForBatch({ succeeded: 0, failed: 1, firstError: new CangeValidationError("payload") })).toBe(
      EXIT_CODES.USAGE
    );
  });
});

describe("card create em lote (CLI)", () => {
  let dir: string;
  const stdout: string[] = [];
  const stderr: string[] = [];

  beforeEach(async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    dir = await mkdtemp(join(tmpdir(), "cange-batch-"));
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePayload(name: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      join(dir, name),
      JSON.stringify({
        idForm: 662,
        flowId: 22996,
        origin: "/cange-agent-kit",
        values: { item_name: name },
        ...overrides
      }),
      "utf8"
    );
  }

  function cardResponse(cardId: number): Response {
    return new Response(
      JSON.stringify({ id: cardId, flow_id: 22996, flow_step_id: 5, dt_created: "2026-09-08T10:00:00Z" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function rateLimitResponse(): Response {
    return new Response(JSON.stringify({ message: "Too many requests" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "300" }
    });
  }

  it("reporta criados x falhos e sai com exit 5 quando o lote fica incompleto", async () => {
    for (const name of ["item-01.json", "item-02.json", "item-03.json", "item-04.json"]) {
      await writePayload(name);
    }

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      return call <= 2 ? cardResponse(1281630 + call) : rateLimitResponse();
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "card",
      "create",
      "--payload-dir",
      dir,
      "--rps",
      "20",
      "--max-retries",
      "0"
    ]);

    const summary = JSON.parse(stdout.join(""));
    expect(summary).toMatchObject({
      requested: 4,
      created: 2,
      failed: 1,
      notAttempted: 1,
      cardIds: [1281631, 1281632]
    });
    expect(summary.failures[0]).toMatchObject({ payload: expect.stringContaining("item-03.json"), status: 429 });
    expect(summary.notAttemptedPayloads).toEqual([expect.stringContaining("item-04.json")]);
    expect(summary.aborted).toMatchObject({ reason: "RATE_LIMIT_BLOCK", retryAfterSeconds: 300 });
    expect(summary.warning).toContain("NÃO foram criados");
    // O contrato que impede o agente de seguir achando que deu certo.
    expect(process.exitCode).toBe(EXIT_CODES.PARTIAL);
    // A rajada PARA: 3 requisições (2 ok + 1 bloqueada), não 4.
    expect(call).toBe(3);
  });

  it("sai com exit 0 e a lista de ids quando o lote inteiro passa", async () => {
    await writePayload("item-01.json");
    await writePayload("item-02.json");

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      return cardResponse(1281640 + call);
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "card",
      "create",
      "--payloads",
      `${join(dir, "item-01.json")},${join(dir, "item-02.json")}`,
      "--rps",
      "20"
    ]);

    const summary = JSON.parse(stdout.join(""));
    expect(summary).toMatchObject({ requested: 2, created: 2, failed: 0, notAttempted: 0, cardIds: [1281641, 1281642] });
    expect(summary.warning).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it("valida TODOS os payloads antes de mutar: um arquivo inválido não deixa o lote sair pela metade", async () => {
    await writePayload("item-01.json");
    await writePayload("item-02.json", { values: undefined });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(cardResponse(1));

    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "card",
      "create",
      "--payload-dir",
      dir
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.join("")).toBe("");
    const error = JSON.parse(stderr.join(""));
    expect(error.message).toContain("NADA foi criado");
    expect(error.details.invalidPayloads).toHaveLength(1);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("recusa origens de payload combinadas", async () => {
    await writePayload("item-01.json");

    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "card",
      "create",
      "--payload",
      join(dir, "item-01.json"),
      "--payload-dir",
      dir
    ]);

    expect(JSON.parse(stderr.join("")).message).toContain("apenas uma origem de payload");
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("--dry-run em lote mostra o plano sem mutar", async () => {
    await writePayload("item-01.json");
    await writePayload("item-02.json");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(cardResponse(1));

    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "card",
      "create",
      "--payload-dir",
      dir,
      "--dry-run"
    ]);

    const result = JSON.parse(stdout.join(""));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, executed: false });
    expect(result.payload).toMatchObject({ batch: true, requested: 2, rps: 8, maxRetries: 3 });
  });
});
