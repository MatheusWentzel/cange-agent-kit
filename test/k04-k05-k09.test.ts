import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { parseDueInput } from "../src/utils/cardState.js";
import { TRUNCATED_VALUE_MARKER } from "../src/utils/valueResolver.js";

/**
 * Achados menores do code review do Alex (lote v9):
 *  - K-04: valor com o marcador de texto cortado da leitura enxuta não é gravado (exit 2).
 *  - K-05: `--due dd/mm` sem ano que já passou pede o ano (antes ia para o ano seguinte calado).
 *  - K-09: falha ao ler os campos da máscara não é engolida na execução real (falha fechado).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

const FLOW = { id_flow: 316, name: "Vendas", form_init_id: 900, flow_steps: [{ id_step: 1, name: "Triagem", form_id: 901, index: 1 }] };
const FIELDS = [
  { id_field: 20, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 900 },
  { id_field: 21, name: "h_link", title: "Filhos", type: "COMBO_BOX_FLOW_FIELD", form_id: 900 },
  { id_field: 22, name: "h_tel", title: "Telefone", type: "PHONE_FIELD", form_id: 900 }
];
const CARD = { id_card: 55, flow_id: 316, flow_step_id: 1, form_answers: [{ id_form_answer: 700, form_id: 900, form_answer_fields: [] }] };
let fieldsStatus = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of ["CANGE_OUTPUT_PROFILE", "RUNNER_FLOW_ID", "CANGE_CARD_FLOW_ID", "CANGE_FLOW_ID", "CANGE_FORCE_DRY_RUN"]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  fieldsStatus = 200;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && url.pathname === "/field/by-flow") {
      return fieldsStatus === 200 ? json(FIELDS) : json({ message: "erro interno" }, fieldsStatus);
    }
    if (method === "GET" && url.pathname === "/card/") return json(CARD);
    if (method === "PUT" && url.pathname === "/form/answer") return json({ id_card: 55 });
    if (method === "POST" && url.pathname === "/form/new-answer") return json({ id_card: 7001, flow_id: 316 });
    if (method === "PUT" && url.pathname === "/card/v2/answer-field") return json({ ok: true });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<Record<string, any> | undefined> {
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? JSON.parse(out) : undefined;
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

async function payloadFile(content: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-k04-"));
  const file = path.join(dir, "payload.json");
  await fs.writeFile(file, JSON.stringify(content));
  return file;
}

const CUT = `Cliente pediu revisão do contrato${TRUNCATED_VALUE_MARKER} use --fields "Observação" para ler inteiro)`;

describe("K-04: texto cortado da leitura enxuta não é gravado", () => {
  it("o marcador é o mesmo que o card read põe", () => {
    expect(TRUNCATED_VALUE_MARKER).toBe("…(cortado:");
  });

  it("--set com o marcador: exit 2, nada gravado, mensagem diz como ler inteiro", async () => {
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", `Observação=${CUT}`]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    const message = String(JSON.parse(stderr.join("")).message);
    expect(message).toContain(TRUNCATED_VALUE_MARKER);
    expect(message).toContain("--fields");
  });

  it("--payload com chave hash e o marcador: dry-run inválido e execução real recusada", async () => {
    const file = await payloadFile({ idForm: 900, flowId: 316, cardId: 55, values: { h_obs: CUT } });
    const dry = await run(["card", "update-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode).toBe(2);
    expect(dry!.validation.valid).toBe(false);
    process.exitCode = undefined;
    stderr.length = 0;
    await run(["card", "update-values", "--payload", file]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
  });

  it("card add-child sem resolução (só hash): também recusa", async () => {
    const file = await payloadFile({
      child: { flowId: 316, idForm: 900, origin: "/x", values: { h_obs: CUT } },
      parent: { flowId: 316, cardId: 55, idForm: 900, linkField: "h_link" }
    });
    await run(["card", "add-child", "--payload", file]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
  });
});

describe("K-05: --due dd/mm sem ano", () => {
  // 08/10/2026 15:00 em Brasília.
  const now = new Date("2026-10-08T18:00:00.000Z");

  it("data futura (ou hoje) sem ano: este ano", () => {
    expect(parseDueInput("27/10", now)).toEqual({ kind: "set", wall: "2026-10-27 00:00" });
    expect(parseDueInput("08/10", now)).toEqual({ kind: "set", wall: "2026-10-08 00:00" });
  });

  it("data que já passou: pede o ano, com o do ano que vem pronto", () => {
    const due = parseDueInput("05/03 18:00", now);
    expect(due).toMatchObject({ kind: "needs_year", text: "05/03 18:00", currentYear: 2026, nextYear: 2027, reason: "passed" });
    expect(due?.kind === "needs_year" && due.withYear(2027)).toBe("05/03/2027 18:00");
  });

  it("29/02 em ano que não é bissexto: pede o ano (o próximo bissexto no comando pronto)", () => {
    expect(parseDueInput("29/02", now)).toMatchObject({ kind: "needs_year", nextYear: 2028, reason: "passed" });
    expect(parseDueInput("29/02", new Date("2026-01-10T15:00:00.000Z"))).toMatchObject({
      kind: "needs_year",
      nextYear: 2028,
      reason: "missing_this_year"
    });
  });

  it("card update --due 05/03: exit 2, nada gravado, suggestion com o ano", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now });
    await run(["card", "update", "--card-id", "55", "--flow-id", "316", "--due", "05/03"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    const error = JSON.parse(stderr.join(""));
    expect(error.message).toContain('Vencimento "05/03" sem ano já passou em 2026: informe o ano (05/03/2027 ou 05/03/2026');
    expect(error.suggestion).toBe('cange card update --card-id 55 --due "05/03/2027"');
  });
});

describe("K-09: campos da máscara (card add-child sem resolução)", () => {
  async function childPayload(): Promise<string> {
    return payloadFile({
      child: { flowId: 316, idForm: 900, origin: "/x", values: { h_tel: "51981740992" } },
      parent: { flowId: 316, cardId: 55, idForm: 900, linkField: "h_link" }
    });
  }

  it("execução real: a leitura dos campos falhou = erro claro, nada gravado", async () => {
    fieldsStatus = 500;
    await run(["card", "add-child", "--payload", await childPayload()]);
    expect(process.exitCode).toBe(4);
    expect(writes()).toEqual([]);
    const error = JSON.parse(stderr.join(""));
    expect(error.code).toBe("FIELDS_READ_FAILED");
    expect(error.message).toContain("Nada foi gravado");
  });

  it("dry-run: segue sem a máscara, com aviso", async () => {
    fieldsStatus = 500;
    const out = await run(["card", "add-child", "--payload", await childPayload(), "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out!.payload.child.values).toEqual({ h_tel: "51981740992" });
    expect(out!.warning).toContain("sem a máscara");
  });

  it("leitura ok: grava mascarado (como antes)", async () => {
    const out = await run(["card", "add-child", "--payload", await childPayload(), "--dry-run"]);
    expect(out!.payload.child.values).toEqual({ h_tel: "(51) 981740992" });
  });
});
