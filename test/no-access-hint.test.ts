import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeApiError } from "../src/client/errors.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { noAccessHintFor } from "../src/cli/no-access-hint.js";
import { FORCE_DRY_RUN_ENV } from "../src/utils/forceDryRun.js";

/**
 * Bancada F2-F6 (t06, rodada etapa1-frio-5m, run 444): `card list` num fluxo sem
 * acesso deu o 404 do back (exit 4), o agente procurou no catálogo, não achou e
 * perguntou ao usuário em vez de pedir acesso. O erro passa a trazer `hint` com o
 * `cange access request` certo. Tudo com fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string }> = [];

const FLOW_NO_ACCESS =
  "Parâmetro inválido! Não foi possivel encontrar o fluxo ou você não possuí acesso para realizar esta ação!";
const REGISTER_NO_ACCESS =
  "Parâmetro inválido! Não foi possivel encontrar o cadastro ou você não possuí acesso para realizar esta ação!";
const RECORD_NO_ACCESS =
  "Parâmetro inválido! Não foi possivel encontrar o registro ou você não possuí acesso para realizar esta ação!";
const CARD_NO_ACCESS =
  "Parâmetro inválido! Não foi possivel encontrar o cartão ou você não possuí acesso para realizar esta ação!";

const FLOW_HINT = 'Se o recurso existe e você não tem acesso, peça: cange access request --flow 316 --reason "<por que precisa>"';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Rota → resposta. Rota sem entrada: `fallback` (padrão: 404 do fluxo sem acesso). */
let routes: Record<string, { status: number; body: unknown }>;
let fallback: { status: number; body: unknown };
let tempDir: string | undefined;

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  for (const name of ["RUNNER_FLOW_ID", "CANGE_CARD_FLOW_ID", "CANGE_FLOW_ID", "RUNNER_CARD_ID", "CANGE_CARD_ID"]) {
    delete process.env[name];
  }
  delete process.env[FORCE_DRY_RUN_ENV];
  process.env.CANGE_BUSY_RETRY_MS = "5";
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  routes = {};
  fallback = { status: 404, body: { status: "error", message: FLOW_NO_ACCESS } };
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
    requests.push({ method, path: url.pathname });
    const route = routes[`${method} ${url.pathname}`] ?? fallback;
    return json(route.body, route.status);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
}

function errorJson(): Record<string, unknown> {
  return JSON.parse(stderr.join("")) as Record<string, unknown>;
}

describe("erro sem acesso de recurso do comando: hint com o access request certo", () => {
  it("run 444: card list --flow-id 316 sem acesso → hint --flow 316, exit 4, mensagem e campos de antes", async () => {
    await run(["card", "list", "--flow-id", "316"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    const error = errorJson();
    expect(error.hint).toBe(FLOW_HINT);
    expect(error.message).toBe(FLOW_NO_ACCESS);
    expect(error).toMatchObject({ name: "CangeApiError", status: 404, method: "GET" });
    expect(Object.keys(error).at(-1)).toBe("hint");
    expect(Object.keys(error).filter((key) => key !== "hint").sort()).toEqual(
      ["details", "endpoint", "message", "method", "name", "status"].sort()
    );
    // Uma linha a mais no stderr (o JSON de erro é indentado), sem travessão.
    expect(stderr.join("").split("\n").filter((line) => line.includes('"hint"'))).toHaveLength(1);
    expect(String(error.hint)).not.toContain("—");
    expect(stdout.join("")).toBe("");
  });

  it("cadastro: register entries --register-id 7946 → hint --register 7946", async () => {
    fallback = { status: 404, body: { message: REGISTER_NO_ACCESS } };
    await run(["register", "entries", "--register-id", "7946"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBe(
      'Se o recurso existe e você não tem acesso, peça: cange access request --register 7946 --reason "<por que precisa>"'
    );
  });

  it("cartão com o fluxo descoberto pelo locate: pede o fluxo dele", async () => {
    routes["GET /card/locate"] = { status: 200, body: { id_card: 55, flow_id: 316, flow_name: "CNG CRM" } };
    fallback = { status: 404, body: { message: CARD_NO_ACCESS } };
    await run(["comment", "create", "--card-id", "55", "--text", "Feito"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBe(
      'Se o cartão existe e você não tem acesso, peça acesso ao fluxo dele: cange access request --flow 316 --reason "<por que precisa>"'
    );
  });

  it("\"registro\" (o back usa para fluxo e cartão) com --flow-id e --card-id: pede o fluxo do comando", async () => {
    fallback = { status: 404, body: { message: RECORD_NO_ACCESS } };
    await run(["card", "get", "--flow-id", "316", "--card-id", "55"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBe(FLOW_HINT);
  });

  it("fluxo e cartão do ambiente do run (sem as opções): usa o fluxo do run", async () => {
    process.env.RUNNER_FLOW_ID = "316";
    process.env.RUNNER_CARD_ID = "55";
    fallback = { status: 404, body: { message: RECORD_NO_ACCESS } };
    await run(["card", "get"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBe(FLOW_HINT);
  });

  it("403 do Flow Query V2 (\"Flow sem acesso\") também ganha o hint", async () => {
    fallback = { status: 403, body: { message: "[Flow V2 Query] Flow sem acesso" } };
    await run(["card", "list", "--flow-id", "316", "--engine", "v2"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson()).toMatchObject({ status: 403, hint: FLOW_HINT });
  });

  it("--payload (avançado) traz o flowId: o hint usa o do payload", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cange-no-access-"));
    const payloadPath = path.join(tempDir, "card.json");
    writeFileSync(payloadPath, JSON.stringify({ idForm: 900, flowId: 316, origin: "/cange-agent-kit", values: {} }));
    await run(["card", "create", "--payload", payloadPath]);

    expect(process.exitCode, stderr.join("")).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBe(FLOW_HINT);
  });
});

describe("sem hint: outro erro, outro recurso ou comando de acesso", () => {
  it.each([
    ["etapa (outro recurso)", 404, "Parâmetro inválido! Não foi possivel encontrar a etapa ou você não possuí acesso para realizar esta ação!"],
    ["404 sem frase de acesso (rota inexistente)", 404, "Cannot GET /card/by-flow/"],
    ["403 de regra da etapa, não de acesso", 403, "Você não pode mover este cartão, pois não é o responsável por ele!"],
    ["vínculo relacionado", 404, "Não foi encontrado o Fluxo relacionado! Você não possui acesso ou o Fluxo não existe!"],
    ["exige administrador (Flow Build)", 404, "Fluxo não encontrado ou sem permissão de administrador."],
    ["500 com a frase", 500, FLOW_NO_ACCESS],
    ["400", 400, FLOW_NO_ACCESS]
  ])("%s", async (_label, status, message) => {
    fallback = { status, body: { message } };
    await run(["card", "list", "--flow-id", "316", "--engine", "v1"]);

    expect(process.exitCode).toBeTruthy();
    expect(errorJson().hint).toBeUndefined();
    expect(errorJson().message).toBe(message);
  });

  it("CARD_NOT_FOUND: o fluxo passou na checagem de acesso, o cartão é que não está nele", async () => {
    fallback = {
      status: 404,
      body: {
        status: "error",
        message: "Cartão excluído ou sem acesso: não foi possível encontrar o cartão neste fluxo.",
        complement: { code: "CARD_NOT_FOUND", card_id: 999 }
      }
    };
    await run(["card", "get", "--flow-id", "316", "--card-id", "999"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBeUndefined();
  });

  it("404 sem corpo (mensagem padrão do kit) não ganha hint", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(null, { status: 404 }));
    await run(["card", "list", "--flow-id", "316", "--engine", "v1"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBeUndefined();
  });

  it("access request mantém as dicas próprias, sem hint", async () => {
    fallback = {
      status: 404,
      body: { message: "Fluxo não encontrado ou sem acesso.", complement: { code: "ACCESS_TARGET_NOT_FOUND" } }
    };
    await run(["access", "request", "--flow", "316", "--reason", "ler os cartões"]);

    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorJson().hint).toBeUndefined();
    expect(String(errorJson().message)).toContain("cange catalog --q");
  });
});

describe("noAccessHintFor (sem rede)", () => {
  const notFound = (message: string, status = 404) => new CangeApiError(message, { status });

  it("cartão sem fluxo conhecido: o comando com <id do fluxo> e o caminho do catálogo", () => {
    const hint = noAccessHintFor(notFound("Card não encontrado ou você não tem acesso a ele", 403), { card: "55" });
    expect(hint).toBe(
      'Se o cartão existe e você não tem acesso, peça acesso ao fluxo dele: cange access request --flow <id do fluxo> --reason "<por que precisa>" (ache o id em cange catalog --q <nome do fluxo>)'
    );
  });

  it("frase do fluxo sem o id do fluxo e sem cartão: nada (não inventa id)", () => {
    expect(noAccessHintFor(notFound(FLOW_NO_ACCESS), { register: "7946" })).toBeUndefined();
    expect(noAccessHintFor(notFound(FLOW_NO_ACCESS), {})).toBeUndefined();
  });

  it("Register Query V2 (\"Register não encontrado ou sem acesso direto\"): pede o cadastro", () => {
    expect(
      noAccessHintFor(notFound("[V2 Query] Register não encontrado ou sem acesso direto (sem parent)"), { register: "4" })
    ).toBe('Se o recurso existe e você não tem acesso, peça: cange access request --register 4 --reason "<por que precisa>"');
  });

  it("frase do cadastro com só o fluxo no comando: nada", () => {
    expect(noAccessHintFor(notFound(REGISTER_NO_ACCESS), { flow: "316" })).toBeUndefined();
  });

  it("erro que não é de API, ou que já tem hint: nada", () => {
    expect(noAccessHintFor(new Error(FLOW_NO_ACCESS), { flow: "316" })).toBeUndefined();
    expect(
      noAccessHintFor(new CangeApiError(FLOW_NO_ACCESS, { status: 404, hint: "outro" }), { flow: "316" })
    ).toBeUndefined();
  });
});
