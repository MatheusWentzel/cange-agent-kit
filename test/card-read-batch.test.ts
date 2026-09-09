import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";

const envBackup = { ...process.env };

/**
 * Leitura em lote (`card read --card-ids`): a concorrência de 5 sozinha não
 * respeitava o teto de GET do backend (10 req/s) — e estourar bloqueia a chave
 * por 5 minutos, o mesmo mecanismo que causou a perda silenciosa do achado A4.
 */
describe("card read em lote (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  beforeEach(() => {
    process.env.CANGE_ACCESS_TOKEN = "token";
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

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function cardResponse(cardId: number): Response {
    return new Response(
      JSON.stringify({ id: cardId, flow_id: 22996, flow_step_id: 5, title: `Card ${cardId}`, form_answers: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  async function runRead(args: string[]): Promise<void> {
    const program = createProgram();
    await program.parseAsync(["node", "cange", "--output", "json", "card", "read", ...args]);
  }

  it("espaça as leituras pelo rps em vez de disparar tudo de uma vez", async () => {
    const startedAt: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      startedAt.push(Date.now());
      return cardResponse(1);
    });

    await runRead(["--flow-id", "22996", "--card-ids", "1,2,3,4", "--rps", "10"]);

    expect(startedAt).toHaveLength(4);
    // 4 leituras a 10/s = pelo menos 3 intervalos de 100 ms.
    const span = (startedAt.at(-1) ?? 0) - (startedAt[0] ?? 0);
    expect(span).toBeGreaterThanOrEqual(250);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ count: 4, ok: 4, errors: 0 });
    expect(process.exitCode).toBeUndefined();
  });

  it("card que falha entra na contagem de erros e o lote sai com exit 5", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("id_card=2")) {
        return new Response(JSON.stringify({ message: "não encontrado" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      return cardResponse(1);
    });

    await runRead(["--flow-id", "22996", "--card-ids", "1,2,3", "--rps", "10"]);

    const envelope = JSON.parse(stdout.join(""));
    expect(envelope).toMatchObject({ count: 3, ok: 2, errors: 1 });
    expect(envelope.cards[1]).toMatchObject({ cardId: 2, error: expect.stringContaining("404") });
    expect(process.exitCode).toBe(EXIT_CODES.PARTIAL);
  });

  it("PARA a leitura no 429 e devolve o restante como não tentado", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json" }
      });
    });

    const ids = Array.from({ length: 20 }, (_, index) => index + 1).join(",");
    await runRead(["--flow-id", "22996", "--card-ids", ids, "--rps", "10"]);

    const envelope = JSON.parse(stdout.join(""));
    expect(envelope.count).toBe(20);
    expect(envelope.ok).toBe(0);
    // Só a onda que já estava em voo (concorrência 5) é condenada; o resto nem
    // é tentado. Antes: 20 leituras × 3 tentativas internas = 60 requisições
    // contra uma chave JÁ bloqueada.
    expect(envelope.errors).toBeLessThanOrEqual(5);
    expect(envelope.notAttempted).toBeGreaterThanOrEqual(15);
    expect(calls).toBeLessThanOrEqual(15);
    // Sem Retry-After o piso é o bloqueio padrão do backend (5 min).
    expect(envelope.aborted).toMatchObject({ reason: "RATE_LIMIT_BLOCK", retryAfterSeconds: 300 });
    expect(envelope.cards.at(-1)).toMatchObject({ cardId: 20, notAttempted: true });
    // NADA foi lido → categoria do erro, não PARTIAL.
    expect(process.exitCode).toBe(EXIT_CODES.API);
  });

  it("lote em que NENHUM card foi lido sai com a categoria do erro, não com exit 5", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "não encontrado" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
    );

    await runRead(["--flow-id", "99999", "--card-ids", "1,2", "--rps", "10"]);

    expect(JSON.parse(stdout.join(""))).toMatchObject({ count: 2, ok: 0, errors: 2 });
    // Exit 5 significa "parte passou, parte não" — aqui nada passou.
    expect(process.exitCode).toBe(EXIT_CODES.API);
  });

  it("recusa --rps acima do teto de leitura do backend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runRead(["--flow-id", "22996", "--card-ids", "1,2", "--rps", "50"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.join("")).message).toContain("teto de leitura do backend");
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });
});
