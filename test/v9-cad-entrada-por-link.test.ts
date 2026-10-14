import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeCliUsageError } from "../src/client/errors.js";
import { parseEntryRef } from "../src/cli/commands/register-entries.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram, runCli } from "../src/cli/index.js";
import { parseCangeLink, parseResourceRef } from "../src/cli/resource-ref.js";

/**
 * v9-cad (10/10): menção de ENTRADA de cadastro no chat dos agentes.
 * O chat manda `[título](cange://register/<cadastro>/entry/<entrada>)` e o runner cita a
 * entrada em foco no kickoff. O agente pode colar o link inteiro em `--entry-id`: o kit
 * tira a entrada e o cadastro do link (sem localizar a entrada). Fetch mockado, nada real.
 */

const HASH = "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901";
const MENTION = "cange://register/183/entry/6507";

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];
let routes: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of ["CANGE_OUTPUT_PROFILE", "CANGE_OUTPUT_FORMAT", "RUNNER_FLOW_ID", "RUNNER_CARD_ID", "CANGE_CARD_FLOW_ID"]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  routes = {};
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
    const path = url.pathname.replace(/\/+$/, "");
    requests.push({ method, path, query: url.searchParams });
    const key = `${method} ${path}`;
    if (!(key in routes)) return json({ message: `rota não mockada: ${key}` }, 404);
    return json(routes[key]);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function runJson(args: string[]): Promise<Record<string, any>> {
  stdout.length = 0;
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  return JSON.parse(stdout.join("")) as Record<string, any>;
}

const FIELDS_183 = [
  { id_field: 9803, name: "h-razao", title: "Razão social", type: "TEXT_SHORT_FIELD", form_id: 500 },
  { id_field: 9802, name: "h-doc", title: "CNPJ/CPF", type: "DOC_FIELD", form_id: 500 }
];

function entryRoutes(): void {
  routes["GET /form/answer"] = [{ id_form_answer: 6507, register_id: 183, card_id: null, form_id: 500 }];
  routes["GET /field/by-register"] = FIELDS_183;
  routes["GET /register/v2/query-engine-status"] = { use_query_v2: "S" };
  routes["GET /register/v2/query-single"] = {
    item: {
      "form_answer.id_form_answer": 6507,
      "form_answer.register_id": 183,
      "field:9803": { display_value: "CONSTRUTORA ZAGONEL LTDA" }
    }
  };
}

describe("link da entrada de cadastro (sem rede)", () => {
  it("cange://register/<cadastro>/entry/<entrada> dá o cadastro e a entrada", () => {
    expect(parseCangeLink(MENTION)).toEqual({ register: { kind: "id", id: "183" }, entryId: "6507" });
    expect(parseResourceRef(MENTION, "register")).toEqual({ kind: "id", id: "183" });
  });

  it("o link da tela (…/register/<hash>/register/<entrada>) também dá a entrada; cartão e cadastro sem entrada não", () => {
    expect(parseCangeLink(`https://app.cange.me/register/${HASH}/register/55`)).toEqual({
      register: { kind: "hash", hash: HASH },
      entryId: "55"
    });
    expect(parseCangeLink(`https://app.cange.me/register/${HASH}`)?.entryId).toBeUndefined();
    expect(parseCangeLink("cange://card/1121230?flow=192")).toEqual({ cardId: "1121230", flow: { kind: "id", id: "192" } });
  });

  it("parseEntryRef: número, #número e link; link sem entrada é erro de uso", () => {
    expect(parseEntryRef("6507")).toEqual({ entryId: "6507" });
    expect(parseEntryRef(" #6507 ")).toEqual({ entryId: "6507" });
    expect(parseEntryRef(MENTION)).toEqual({ entryId: "6507", registerId: "183" });
    expect(parseEntryRef(`/register/${HASH}/register/55`)).toEqual({ entryId: "55" });
    expect(() => parseEntryRef(`https://app.cange.me/register/${HASH}`)).toThrow(CangeCliUsageError);
    expect(() => parseEntryRef("cange://card/1?flow=2")).toThrow(/o link não traz uma entrada de cadastro/);
    expect(() => parseEntryRef("abc")).toThrow(/--entry-id precisa do número da entrada/);
  });
});

describe("register entries --entry-id com a menção do chat", () => {
  it("lê a entrada pelo cadastro do link, sem localizar a entrada", async () => {
    entryRoutes();
    const out = await runJson(["register", "entries", "--entry-id", MENTION]);
    expect(out.registerId).toBe(183);
    expect(out.entry.id).toBe(6507);
    expect(out.entry.fields).toMatchObject({ "Razão social": "CONSTRUTORA ZAGONEL LTDA", "CNPJ/CPF": null });
    expect(requests.some((r) => r.path === "/form/answer")).toBe(false);
    const single = requests.find((r) => r.path === "/register/v2/query-single");
    expect(single?.query.get("id_register")).toBe("183");
    expect(single?.query.get("id_form_answer")).toBe("6507");
    expect(process.exitCode).toBeUndefined();
  });

  it("pelo apelido `register entry` e com o link da tela (hash): a entrada localiza o cadastro", async () => {
    entryRoutes();
    const out = await runJson(["register", "entry", "--entry-id", `https://app.cange.me/register/${HASH}/register/6507`]);
    expect(out.registerId).toBe(183);
    const locate = requests.find((r) => r.path === "/form/answer");
    expect(locate?.query.get("id_form_answer")).toBe("6507");
  });

  it("valor solto com a menção vira --entry-id (não --register-id)", async () => {
    stderr.length = 0;
    await runCli(["node", "cange", "register", "entries", MENTION]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const error = JSON.parse(stderr.join("")) as Record<string, any>;
    expect(error.suggestion).toBe(`cange register entries --entry-id ${MENTION}`);
    expect(requests).toHaveLength(0);
  });
});
