import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { pickResponsible, resolveTag } from "../src/cli/commands/card-update.js";
import type { NormalizedField } from "../src/schemas/fields.js";
import { coerceFieldValue, pickByName } from "../src/utils/valueResolver.js";

/**
 * K-02 (code review do Alex, lote v9): a busca por TRECHO gravava a pessoa, a etiqueta ou a
 * entrada errada. `--responsible "Ana"` casava com "Luciana Souza" e podia casar com o bot de
 * um agente (que aciona outro agente). Agora: igualdade ou início de palavra; o resto é erro
 * de uso (exit 2) com os candidatos e o comando pronto, nada gravado. Bot só pelo nome exato.
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

const CARD = { id_card: 55, flow_id: 316, flow_step_id: 1, title: "Pedido", user_id: null, card_flow_tags: [], form_answers: [] };
const FLOW = { id_flow: 316, name: "CNG CRM", form_init_id: 900, flow_steps: [{ id_step: 1, name: "Triagem", form_id: 901 }] };
const TAGS = [
  { id_flow_tag: 12, flow_id: 316, description: "Frio" },
  { id_flow_tag: 13, flow_id: 316, description: "Urgente" }
];
let users: Array<Record<string, unknown>> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of ["CANGE_OUTPUT_PROFILE", "RUNNER_FLOW_ID", "CANGE_CARD_FLOW_ID", "CANGE_FLOW_ID", "RUNNER_SPEAKER_USER_ID", "CANGE_FORCE_DRY_RUN"]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  users = [
    { id_user: 20, name: "Luciana Souza", email: "luciana@acme.com", type: "U", flow_user_type: "M" },
    { id_user: 21, name: "Ana Bot", email: "bot-21@agents.cange.me", type: "AG", flow_user_type: "M" }
  ];
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
    if (method === "GET" && url.pathname === "/card/") return json(CARD);
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && (url.pathname === "/user/by-flow" || url.pathname === "/user/by-company")) return json(users);
    if (method === "GET" && url.pathname === "/flow-tag/by-flow") return json(TAGS);
    if (method === "PUT" && url.pathname === "/card") return json({ id_card: 55, flow_id: 316 });
    if (method === "POST" && url.pathname === "/flow-tag/card") return json({ id_card_flow_tag: 99 });
    if (method === "POST" && url.pathname === "/card-comment") return json({ id_card_comment: 5 });
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

function error(): Record<string, any> {
  return JSON.parse(stderr.join(""));
}

describe("pickByName (régua única)", () => {
  const people = [
    { id: 1, name: "Luciana Souza" },
    { id: 2, name: "Ana-Clara Reis" },
    { id: 3, name: "Agente Comprador", bot: true }
  ];
  const name = (item: { name: string }) => item.name;
  const exactOnly = (item: { bot?: boolean }) => item.bot === true;

  it("igualdade sem acento/caixa e início de palavra valem", () => {
    expect(pickByName("LUCIANA SOUZA", people, name)).toMatchObject({ ok: true, item: { id: 1 } });
    expect(pickByName("souza", people, name)).toMatchObject({ ok: true, item: { id: 1 } });
    expect(pickByName("clara", people, name)).toMatchObject({ ok: true, item: { id: 2 } });
  });

  it("trecho no meio da palavra não escolhe: candidatos", () => {
    expect(pickByName("ana", [people[0]!], name)).toEqual({ ok: false, reason: "partial", candidates: [people[0]] });
  });

  it("bot só pelo nome exato", () => {
    expect(pickByName("comprador", people, name, { exactOnly })).toMatchObject({ ok: false, reason: "partial" });
    expect(pickByName("agente comprador", people, name, { exactOnly })).toMatchObject({ ok: true, item: { id: 3 } });
  });

  it("modo prefix (entrada de cadastro): só o começo do título", () => {
    const entries = [{ id: 5, name: "ACME Comércio" }];
    expect(pickByName("acme", entries, name, { mode: "prefix" })).toMatchObject({ ok: true });
    expect(pickByName("comercio", entries, name, { mode: "prefix" })).toMatchObject({ ok: false, reason: "partial" });
  });
});

describe("card update --responsible e --add-tag", () => {
  const BASE = ["card", "update", "--card-id", "55", "--flow-id", "316"];

  it('"Ana" não grava Luciana Souza nem o bot: exit 2 com os candidatos e o comando de cada um', async () => {
    await run([...BASE, "--responsible", "Ana"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    const message = String(error().message);
    expect(message).toContain("Luciana Souza (id 20");
    expect(message).toContain("Ana Bot (id 21");
    expect(message).toContain("cange card update --card-id 55 --responsible 20");
    expect(message).toContain("cange card update --card-id 55 --responsible 21");
  });

  it("um candidato só (sem ser escolha segura): suggestion com o comando pronto", async () => {
    users = [users[0]!];
    await run([...BASE, "--due", "27/10/2099", "--responsible", "Ana"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(error().suggestion).toBe('cange card update --card-id 55 --due "27/10/2099" --responsible 20');
  });

  it("bot pelo nome exato: grava", async () => {
    await run([...BASE, "--responsible", "ana bot"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()[0]!.body).toMatchObject({ user_id: 21 });
  });

  it("pickResponsible: início de palavra de humano vale; o bot com o mesmo início não", () => {
    const list = [
      { id: 20, name: "Luciana Souza" },
      { id: 21, name: "Souza Bot", userType: "AG" }
    ];
    expect(pickResponsible("souza", list)).toEqual({ ok: true, user: { id: 20, name: "Luciana Souza" } });
  });

  it("etiqueta por trecho no meio do nome: erro com o comando pronto", async () => {
    await run([...BASE, "--add-tag", "gente"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(error().suggestion).toBe('cange card update --card-id 55 --add-tag "13"');
    expect(resolveTag("urg", [{ id: 13, name: "Urgente" }], "F")).toMatchObject({ ok: true });
  });
});

describe("campo de usuário e entrada de cadastro (--set)", () => {
  const field = (partial: Partial<NormalizedField> & { name: string; type: string }): NormalizedField => ({
    required: false,
    raw: {},
    ...partial
  });
  const RESP = field({ id: 15, name: "h_resp", title: "Responsável", type: "USER_FIELD", formId: 902 });
  const CLIENTE = field({ id: 16, name: "h_cliente", title: "Cliente", type: "COMBO_BOX_REGISTER_FIELD", formId: 902, raw: { register_id: 175 } });

  it('usuário "Ana" não vira Luciana: erro com o --set pronto', async () => {
    const listUsers = vi.fn().mockResolvedValue([{ id: 20, name: "Luciana Souza" }]);
    const result = await coerceFieldValue(RESP, "Ana", { listUsers });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--set "Responsável=20"');
  });

  it("bot de agente só pelo nome exato", async () => {
    const listUsers = vi.fn().mockResolvedValue([{ id: 21, name: "Agente Comprador", userType: "AG" }]);
    expect((await coerceFieldValue(RESP, "Comprador", { listUsers })).ok).toBe(false);
    expect(await coerceFieldValue(RESP, "agente comprador", { listUsers })).toEqual({ ok: true, value: 21 });
  });

  it("entrada de cadastro: 1 resultado que não bate o título não é gravado", async () => {
    const searchRegisterEntries = vi.fn().mockResolvedValue([{ id: 4410, title: "ACME Comércio" }]);
    const miss = await coerceFieldValue(CLIENTE, "Mercopar", { searchRegisterEntries });
    expect(miss.ok).toBe(false);
    expect(!miss.ok && miss.error).toContain('--set "Cliente=4410"');
    expect((await coerceFieldValue(CLIENTE, "Comércio", { searchRegisterEntries })).ok).toBe(false);
    expect(await coerceFieldValue(CLIENTE, "acme", { searchRegisterEntries })).toEqual({ ok: true, value: [4410] });
  });
});

describe("N-2: entrada de cadastro com a busca cortada (20 por página)", () => {
  const CLIENTE: NormalizedField = {
    id: 16,
    name: "h_cliente",
    title: "Cliente",
    type: "COMBO_BOX_REGISTER_FIELD",
    formId: 902,
    required: false,
    raw: { register_id: 175 }
  };
  /** 1 entrada que começa por "Ana Clara" e 19 que só têm o texto no meio (a busca do back é "contém"). */
  const page = [
    { id: 500, title: "Ana Clara Souza" },
    ...Array.from({ length: 19 }, (_, index) => ({ id: 600 + index, title: `Mariana Clara ${index}` }))
  ];

  it('prefixo "Ana Clara" com hasMore: ambíguo, com os candidatos (não escolhe a única da página)', async () => {
    const searchRegisterEntries = vi.fn().mockResolvedValue({ entries: page, truncated: true });
    const result = await coerceFieldValue(CLIENTE, "Ana Clara", { searchRegisterEntries });
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : "";
    expect(error).toContain("Ana Clara Souza (id 500)");
    expect(error).toContain('--set "Cliente=500"');
    expect(error).toContain("só o título exato ou o id");
  });

  it("página cheia sem o hasMore (lista solta de 20): também ambíguo", async () => {
    const searchRegisterEntries = vi.fn().mockResolvedValue(page);
    expect((await coerceFieldValue(CLIENTE, "Ana Clara", { searchRegisterEntries })).ok).toBe(false);
  });

  it('o título exato na mesma página cortada resolve ("Ana" entre 19 "Ana ...")', async () => {
    const entries = [
      ...Array.from({ length: 19 }, (_, index) => ({ id: 700 + index, title: `Ana ${index}` })),
      { id: 799, title: "Ana" }
    ];
    const searchRegisterEntries = vi.fn().mockResolvedValue({ entries, truncated: true });
    expect(await coerceFieldValue(CLIENTE, "ana", { searchRegisterEntries })).toEqual({ ok: true, value: [799] });
  });

  it("busca inteira (sem hasMore, página não cheia): o prefixo único segue resolvendo", async () => {
    const searchRegisterEntries = vi.fn().mockResolvedValue({ entries: page.slice(0, 5), truncated: false });
    expect(await coerceFieldValue(CLIENTE, "Ana Clara", { searchRegisterEntries })).toEqual({ ok: true, value: [500] });
  });
});

describe("comment create --mention", () => {
  it('"Ana" não menciona Luciana: exit 2, nada gravado, comando pronto com o id', async () => {
    users = [users[0]!];
    await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "Confere?", "--mention", "Ana"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(error().suggestion).toBe('cange comment create --card-id 55 --text "Confere?" --mention 20');
  });

  it("bot pelo nome exato: menciona", async () => {
    const out = await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "Confere?", "--mention", "Ana Bot", "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out!.payload.mentions).toEqual([21]);
  });
});
