import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";

/**
 * K-01 (code review do Alex, lote v9): o gate do runner confere com `--dry-run --validate-fields`
 * e a execução real vem SEM a flag. Antes, só a flag convertia os valores (rótulo de opção vira
 * valor, dd/mm/aaaa vira ISO, R$ vira número): a aprovação mostrava "2" e o PUT gravava
 * "Aprovado". Agora o modo --payload converte sempre: o corpo do dry-run com a flag é igual ao
 * corpo da gravação real sem ela, nos 5 comandos.
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; body?: Record<string, any> }> = [];

const FLOW = {
  id_flow: 316,
  name: "Vendas",
  form_init_id: 900,
  flow_steps: [
    { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
    { id_step: 2, name: "Proposta", form_id: 902, index: 2 }
  ]
};

const OPTIONS = [
  { value: "1", label: "Novo" },
  { value: "2", label: "Aprovado" }
];

function formFields(formId: number, prefix: string, idBase: number) {
  return [
    { id_field: idBase, name: `${prefix}_status`, title: "Status", type: "COMBO_BOX_FIELD", form_id: formId, options: OPTIONS },
    { id_field: idBase + 1, name: `${prefix}_data`, title: "Data", type: "DATE_PICKER_FIELD", form_id: formId },
    { id_field: idBase + 2, name: `${prefix}_valor`, title: "Valor", type: "CURRENCY_FIELD", form_id: formId }
  ];
}

const FIELDS = [...formFields(900, "i", 10), ...formFields(901, "t", 20)];
const REGISTER = { id_register: 183, name: "Clientes", form_id: 950 };
const REGISTER_FIELDS = formFields(950, "r", 60);

const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  flow_step: { id_step: 1, name: "Triagem" },
  form_answers: [{ id_form_answer: 700, form_id: 900, form_answer_fields: [] }]
};

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
    if (method === "GET" && url.pathname === "/field/by-flow") return json(FIELDS);
    if (method === "GET" && url.pathname === "/register") return json(REGISTER);
    if (method === "GET" && url.pathname === "/field/by-register") return json(REGISTER_FIELDS);
    if (method === "GET" && url.pathname === "/card/") return json(CARD);
    if (method === "POST" && url.pathname === "/form/new-answer") return json({ id_card: 7001, flow_id: 316, id_form_answer: 8001 });
    if (method === "PUT" && url.pathname === "/form/answer") return json({ id_card: 55 });
    if (method === "POST" && url.pathname === "/card/v2/move-step") return json({ id_card: 55, flow_step_id: body?.to_step_id });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<Record<string, any> | undefined> {
  stdout.length = 0;
  stderr.length = 0;
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? JSON.parse(out) : undefined;
}

async function payloadFile(content: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-k01-"));
  const file = path.join(dir, "payload.json");
  await fs.writeFile(file, JSON.stringify(content));
  return file;
}

/** Combo por rótulo, data dd/mm/aaaa e moeda R$, todos com a chave hash. */
function rawValues(prefix: string): Record<string, unknown> {
  return {
    [`${prefix}_status`]: "Aprovado",
    [`${prefix}_data`]: "06/10/2026",
    [`${prefix}_valor`]: "R$ 2.500,00"
  };
}

function expectedValues(prefix: string): Record<string, unknown> {
  return {
    [`${prefix}_status`]: "2",
    [`${prefix}_data`]: new Date(2026, 9, 6).toISOString(),
    [`${prefix}_valor`]: 2500
  };
}

/** Dry-run com a flag (o gate) e gravação real sem a flag: o `values` tem de ser o mesmo. */
async function gateVersusReal(args: string[], writePath: string): Promise<{ gate: unknown; real: unknown }> {
  const dry = await run([...args, "--dry-run", "--validate-fields"]);
  expect(process.exitCode ?? 0).toBe(0);
  const gate = dry?.payload?.values;
  requests.length = 0;
  await run(args);
  expect(process.exitCode ?? 0).toBe(0);
  const write = requests.find((request) => request.method !== "GET" && request.path === writePath);
  expect(write, `nenhuma gravação em ${writePath}`).toBeDefined();
  return { gate, real: write!.body?.values };
}

describe("K-01: --payload converte sempre (gate e execução real gravam o mesmo valor)", () => {
  it("card update-values", async () => {
    const file = await payloadFile({ idForm: 901, flowId: 316, cardId: 55, values: rawValues("t") });
    const { gate, real } = await gateVersusReal(["card", "update-values", "--payload", file], "/form/answer");
    expect(gate).toEqual(expectedValues("t"));
    expect(real).toEqual(gate);
  });

  it("card create", async () => {
    const file = await payloadFile({ idForm: 900, flowId: 316, origin: "/cange-agent-kit", values: rawValues("i") });
    const { gate, real } = await gateVersusReal(["card", "create", "--payload", file], "/form/new-answer");
    expect(gate).toEqual(expectedValues("i"));
    expect(real).toEqual(gate);
  });

  it("card move-step-with-values", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: rawValues("t") });
    const { gate, real } = await gateVersusReal(["card", "move-step-with-values", "--payload", file], "/card/v2/move-step");
    expect(gate).toEqual(expectedValues("t"));
    expect(real).toEqual(gate);
  });

  it("register create", async () => {
    const file = await payloadFile({ idForm: 950, registerId: 183, origin: "/cange-agent-kit", values: rawValues("r") });
    const { gate, real } = await gateVersusReal(["register", "create", "--payload", file], "/form/new-answer");
    expect(gate).toEqual(expectedValues("r"));
    expect(real).toEqual(gate);
  });

  it("register update", async () => {
    const file = await payloadFile({ idForm: 950, registerId: 183, formAnswerId: 8812, values: rawValues("r") });
    const { gate, real } = await gateVersusReal(["register", "update", "--payload", file], "/form/answer");
    expect(gate).toEqual(expectedValues("r"));
    expect(real).toEqual(gate);
  });

  it("register update --payload sem o cadastro: erro de uso, nada gravado (não dá para converter)", async () => {
    const file = await payloadFile({ idForm: 950, formAnswerId: 8812, values: rawValues("r") });
    await run(["register", "update", "--payload", file]);
    expect(process.exitCode).toBe(2);
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
    expect(stderr.join("")).toContain("--register-id");
  });
});
