import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { screenMaskOf } from "../src/utils/valueResolver.js";
import type { NormalizedField } from "../src/schemas/fields.js";

/**
 * v9 (h, conversa 858 e run 1011): telefone sem máscara passava na conferência do gate, a
 * pessoa aprovava e o back recusava ("O campo Telefone não está no formato correto! (XX)
 * XXXX-XXXX"), pedindo uma 2ª aprovação. O mesmo com CPF/CNPJ. O valor gravado tem que ser
 * o que a TELA grava (as 2 passadas da máscara do componente), em toda escrita, e o valor
 * final aparece no dry-run (é o que o gate confere e a aprovação prende).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];

const FLOW = {
  id_flow: 316,
  name: "Whatsapp",
  form_init_id: 900,
  flow_steps: [
    { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
    { id_step: 2, name: "Contato", form_id: 902, index: 2 }
  ]
};

const FIELDS = [
  { id_field: 20, name: "h_nome", title: "Nome", type: "TEXT_SHORT_FIELD", form_id: 900 },
  { id_field: 21, name: "h_tel", title: "Telefone", type: "PHONE_FIELD", form_id: 900 },
  { id_field: 22, name: "h_cpf", title: "CPF", type: "DOC_FIELD", variation: "1", form_id: 900 },
  { id_field: 23, name: "h_cnpj", title: "CNPJ", type: "DOC_FIELD", variation: "2", form_id: 900 },
  { id_field: 24, name: "h_doc", title: "Documento", type: "DOC_FIELD", variation: "3", form_id: 900 },
  { id_field: 30, name: "h_tel2", title: "Telefone do contato", type: "PHONE_FIELD", form_id: 901 },
  { id_field: 31, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 901 },
  { id_field: 40, name: "h_tel3", title: "Telefone de retorno", type: "PHONE_FIELD", form_id: 902 }
];

const REGISTER = { id_register: 183, name: "[CNG] - Clientes", form_id: 950 };
const REGISTER_FIELDS = [
  { id_field: 60, name: "r_razao", title: "Razão social", type: "TEXT_SHORT_FIELD", form_id: 950 },
  { id_field: 61, name: "r_cnpj", title: "CNPJ", type: "DOC_FIELD", variation: "2", form_id: 950 },
  { id_field: 62, name: "r_tel", title: "Telefone", type: "PHONE_FIELD", form_id: 950 }
];

/** Cartão 55 na Triagem; o telefone do contato foi gravado SEM máscara por outro caminho. */
const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  flow_step: { id_step: 1, name: "Triagem" },
  form_answers: [
    { id_form_answer: 700, form_id: 900, form_answer_fields: [{ field_id: 20, value: "Mercopar" }] },
    { id_form_answer: 701, form_id: 901, form_answer_fields: [{ field_id: 30, value: "51981740992" }] }
  ]
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
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
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
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? JSON.parse(out) : undefined;
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

function errorMessage(): string {
  return String(JSON.parse(stderr.join("")).message);
}

async function payloadFile(content: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-v9-mask-"));
  const file = path.join(dir, "payload.json");
  await fs.writeFile(file, JSON.stringify(content));
  return file;
}

const field = (type: string, variation?: string): NormalizedField => ({
  name: "h",
  title: "Campo",
  type,
  required: false,
  ...(variation !== undefined ? { variation } : {}),
  raw: {}
});

describe("screenMaskOf (a máscara da tela, idempotente)", () => {
  it.each([
    ["PHONE_FIELD", undefined, "51981740992", "(51) 981740992"],
    ["PHONE_FIELD", undefined, "5132221234", "(51) 32221234"],
    ["PHONE_FIELD", undefined, "(51) 98174-0992", "(51) 981740992"],
    ["DOC_FIELD", "1", "12345678909", "123.456.789-09"],
    ["DOC_FIELD", "2", "11222333000181", "11.222.333/0001-81"],
    ["DOC_FIELD", "2", "12abc34501de35", "12.ABC.345/01DE-35"],
    ["DOC_FIELD", "3", "12345678909", "123.456.789-09"],
    ["DOC_FIELD", "3", "11222333000181", "11.222.333/0001-81"]
  ])("%s (variation %s): %s grava %s", (type, variation, raw, masked) => {
    const out = screenMaskOf(field(type, variation), raw);
    expect(out).toEqual({ value: masked, from: raw });
    // Idempotente: o valor já no formato da tela não muda.
    expect(screenMaskOf(field(type, variation), masked)).toEqual({ value: masked });
  });

  it("valor que a tela recusa volta em issue e não é mexido", () => {
    const phone = screenMaskOf(field("PHONE_FIELD"), "5198174");
    expect(phone.value).toBe("5198174");
    expect(phone.from).toBeUndefined();
    expect(phone.issue?.text).toContain("Telefone inválido");
    expect(screenMaskOf(field("DOC_FIELD", "1"), "12345678900").issue?.text).toContain("CPF inválido");
  });

  it("outros tipos, vazio e não texto: como vieram", () => {
    expect(screenMaskOf(field("TEXT_SHORT_FIELD"), "51981740992")).toEqual({ value: "51981740992" });
    expect(screenMaskOf(field("PHONE_FIELD"), "")).toEqual({ value: "" });
    expect(screenMaskOf(field("PHONE_FIELD"), null)).toEqual({ value: null });
  });
});

describe("card create grava telefone e documento como a tela (conversa 858)", () => {
  it("--set: o POST leva o valor mascarado e a saída diz o que mudou", async () => {
    const out = await run([
      "card", "create", "--flow-id", "316",
      "--set", "Nome=Mercopar",
      "--set", "Telefone=51981740992",
      "--set", "CPF=12345678909",
      "--set", "CNPJ=12abc34501de35"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    const [create] = writes();
    expect(create?.body?.values).toEqual({
      h_nome: "Mercopar",
      h_tel: "(51) 981740992",
      h_cpf: "123.456.789-09",
      h_cnpj: "12.ABC.345/01DE-35"
    });
    expect(out!.formatted).toEqual([
      { field: "Telefone", from: "51981740992", to: "(51) 981740992" },
      { field: "CPF", from: "12345678909", to: "123.456.789-09" },
      { field: "CNPJ", from: "12abc34501de35", to: "12.ABC.345/01DE-35" }
    ]);
  });

  it("--dry-run: o payload que o gate confere já vem mascarado (o que a aprovação prende)", async () => {
    const out = await run(["card", "create", "--flow-id", "316", "--set", "Nome=Mercopar", "--set", "Telefone=5132221234", "--dry-run"]);
    expect(writes()).toEqual([]);
    expect(out!.payload.values.h_tel).toBe("(51) 32221234");
    expect(out!.formatted).toEqual([{ field: "Telefone", from: "5132221234", to: "(51) 32221234" }]);
  });

  it("valor já mascarado: não muda e não sai em formatted", async () => {
    const out = await run(["card", "create", "--flow-id", "316", "--set", "Nome=Mercopar", "--set", "Telefone=(51) 981740992"]);
    expect(writes()[0]!.body!.values).toMatchObject({ h_tel: "(51) 981740992" });
    expect(out).not.toHaveProperty("formatted");
  });

  it("telefone inválido: exit 2, nada gravado", async () => {
    await run(["card", "create", "--flow-id", "316", "--set", "Nome=Mercopar", "--set", "Telefone=5198174"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Telefone inválido");
  });

  it("--payload sem nada com cara de telefone ou documento: nenhuma consulta extra (como antes)", async () => {
    const file = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_nome: "Mercopar 2026" } });
    await run(["card", "create", "--payload", file]);
    expect(requests.filter((request) => request.method === "GET")).toEqual([]);
    expect(writes()[0]!.body!.values).toEqual({ h_nome: "Mercopar 2026" });
  });

  it("--payload com telefone como número: vira texto mascarado", async () => {
    const file = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_tel: 51981740992 } });
    await run(["card", "create", "--payload", file]);
    expect(writes()[0]!.body!.values).toEqual({ h_tel: "(51) 981740992" });
  });

  it("--payload só com hash (sem resolução): o kit lê os campos (1 GET) e grava mascarado", async () => {
    const file = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_nome: "Mercopar", h_tel: "51981740992" } });
    const out = await run(["card", "create", "--payload", file]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(requests.filter((request) => request.path === "/field/by-flow")).toHaveLength(1);
    expect(writes()[0]!.body!.values).toEqual({ h_nome: "Mercopar", h_tel: "(51) 981740992" });
    expect(out!.formatted).toEqual([{ field: "Telefone", from: "51981740992", to: "(51) 981740992" }]);
  });

  it("--payload com telefone que a tela recusa: exit 2 na conferência (antes, só o back recusava, depois da aprovação)", async () => {
    // 12 dígitos: a tela corta, o back recusa o formato; o kit recusa antes de gravar.
    const file = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_tel: "519817409921" } });
    const out = await run(["card", "create", "--payload", file, "--dry-run"]);
    expect(process.exitCode).toBe(2);
    expect(out!.validation.valid).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("lote: 1 GET dos campos por fluxo e cada cartão sai com o seu formatted", async () => {
    const a = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_tel: "51981740992" } });
    const b = await payloadFile({ flowId: 316, idForm: 900, origin: "/x", values: { h_tel: "(51) 32221234" } });
    const out = await run(["card", "create", "--payloads", `${a},${b}`]);
    expect(requests.filter((request) => request.path === "/field/by-flow")).toHaveLength(1);
    const bodies = writes().map((request) => request.body!.values);
    expect(bodies).toEqual([{ h_tel: "(51) 981740992" }, { h_tel: "(51) 32221234" }]);
    expect(out!.cards[0].formatted).toEqual([{ field: "Telefone", from: "51981740992", to: "(51) 981740992" }]);
    expect(out!.cards[1]).not.toHaveProperty("formatted");
  });
});

describe("update-values, mover e cadastro também", () => {
  it("card update-values --set: calls[].payload.values já mascarado no dry-run e no PUT", async () => {
    const dry = await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Telefone do contato=51 98174 0992", "--dry-run"]);
    expect(dry!.calls[0].values).toEqual({ h_tel2: "(51) 981740992" });
    expect(dry!.formatted).toEqual([{ field: "Telefone do contato", from: "51 98174 0992", to: "(51) 981740992" }]);
    stdout.length = 0;
    const out = await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "CPF=12345678909"]);
    expect(writes()[0]!.body).toMatchObject({ id_form: 900, values: { h_cpf: "123.456.789-09" } });
    expect(out!.formatted).toEqual([{ field: "CPF", from: "12345678909", to: "123.456.789-09" }]);
  });

  it("card update-values --payload só com hash: mascarado", async () => {
    const file = await payloadFile({ idForm: 900, flowId: 316, cardId: 55, values: { h_doc: "11222333000181" } });
    const out = await run(["card", "update-values", "--payload", file]);
    expect(writes()[0]!.body).toMatchObject({ values: { h_doc: "11.222.333/0001-81" } });
    expect(out!.formatted).toEqual([{ field: "Documento", from: "11222333000181", to: "11.222.333/0001-81" }]);
  });

  it("card move --set: o valor do --set vai mascarado; o que veio do cartão (rascunho) não é tocado", async () => {
    const out = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Contato",
      "--set", "Observação=retornar", "--set", "Telefone=5132221234", "--dry-run"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    const move = out!.calls.find((call: any) => call.action === "card_move");
    // h_tel2 veio do cartão sem máscara: segue como estava (carryOver não é mexido).
    expect(move.payload.values).toEqual({ h_tel2: "51981740992", h_obs: "retornar" });
    const init = out!.calls.find((call: any) => call.payload.idForm === 900);
    expect(init.payload.values).toEqual({ h_tel: "(51) 32221234" });
    expect(out!.formatted).toEqual([{ field: "Telefone", from: "5132221234", to: "(51) 32221234" }]);
  });

  it("card move-step-with-values --payload só com hash: mascarado (campos já lidos, sem GET extra)", async () => {
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_tel2: "51981740992", h_obs: "ok" }
    });
    const out = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(out!.payload.values).toMatchObject({ h_tel2: "(51) 981740992", h_obs: "ok" });
    expect(out!.formatted).toEqual([{ field: "Telefone do contato", from: "51981740992", to: "(51) 981740992" }]);
    expect(requests.filter((request) => request.path === "/field/by-flow")).toHaveLength(1);
  });

  it("register create --set e --payload: CNPJ e telefone como a tela", async () => {
    const out = await run(["register", "create", "--register-id", "183", "--set", "Razão social=ACME", "--set", "CNPJ=11222333000181", "--set", "Telefone=51981740992"]);
    expect(writes()[0]!.body!.values).toEqual({ r_razao: "ACME", r_cnpj: "11.222.333/0001-81", r_tel: "(51) 981740992" });
    expect(out!.formatted).toHaveLength(2);

    requests.length = 0;
    stdout.length = 0;
    const file = await payloadFile({ idForm: 950, registerId: 183, origin: "/x", values: { r_cnpj: "11222333000181" } });
    const second = await run(["register", "create", "--payload", file]);
    expect(writes()[0]!.body!.values).toEqual({ r_cnpj: "11.222.333/0001-81" });
    expect(second!.formatted).toEqual([{ field: "CNPJ", from: "11222333000181", to: "11.222.333/0001-81" }]);
  });

  it("register update --payload com o cadastro: mascarado; sem o cadastro segue como veio", async () => {
    const file = await payloadFile({ idForm: 950, registerId: 183, formAnswerId: 6507, values: { r_tel: "51981740992" } });
    await run(["register", "update", "--payload", file]);
    expect(writes()[0]!.body).toMatchObject({ values: { r_tel: "(51) 981740992" } });

    requests.length = 0;
    stdout.length = 0;
    const noRegister = await payloadFile({ idForm: 950, formAnswerId: 6507, values: { r_tel: "51981740992" } });
    await run(["register", "update", "--payload", noRegister]);
    expect(writes()[0]!.body).toMatchObject({ values: { r_tel: "51981740992" } });
  });

  it("card add-child: valores do filho mascarados", async () => {
    const file = await payloadFile({
      child: { flowId: 316, idForm: 900, origin: "/x", values: { h_tel: "51981740992" } },
      parent: { flowId: 316, cardId: 55, idForm: 901, linkField: "h_link" }
    });
    const out = await run(["card", "add-child", "--payload", file, "--dry-run"]);
    expect(out!.payload.child.values).toEqual({ h_tel: "(51) 981740992" });
    expect(out!.formatted).toEqual([{ field: "Telefone", from: "51981740992", to: "(51) 981740992" }]);
  });
});
