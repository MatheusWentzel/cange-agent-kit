import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { TRUNCATED_VALUE_MARKER } from "../src/utils/valueResolver.js";

/**
 * Achados menores do code review do Alex (lote v9):
 *  - K-04: valor com o marcador de texto cortado da leitura enxuta não é gravado (exit 2).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

const FLOW = { id_flow: 316, name: "Vendas", form_init_id: 900, flow_steps: [{ id_step: 1, name: "Triagem", form_id: 901, index: 1 }] };
const FIELDS = [
  { id_field: 20, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 900 },
  { id_field: 21, name: "h_link", title: "Filhos", type: "COMBO_BOX_FLOW_FIELD", form_id: 900 }
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
