import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeApiError, CangeAuthError } from "../src/client/errors.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { FLOW_FROM_CARD_HINT, normalizeIdOptions } from "../src/cli/resource-ref.js";
import { FORCE_DRY_RUN_ENV } from "../src/utils/forceDryRun.js";

/**
 * F6 (runs 357 e 362 da bancada de custo): o pedido traz só o número do cartão
 * ("comente no cartão 1121343") e o kit exigia o fluxo. Agora, sem --flow-id e sem
 * fluxo no ambiente do run, o kit pergunta ao back (`GET /card/locate`).
 * Tudo com fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];

const FLOW = {
  id_flow: 316,
  name: "CNG CRM",
  form_init_id: 900,
  flow_steps: [
    { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
    { id_step: 2, name: "Agendamento", form_id: 902, index: 2 }
  ]
};

const FIELDS = [
  { id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900 },
  { id_field: 30, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", form_id: 901 }
];

const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  flow_step: { id_step: 1, name: "Triagem" },
  form_answers: [
    { id_form_answer: 700, form_id: 900, form_answer_fields: [{ field_id: 20, value: "Pedido ACME" }] },
    { id_form_answer: 701, form_id: 901, form_answer_fields: [] }
  ]
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resposta do GET /card/locate (padrão: cartão 55 no fluxo 316). */
let locateResponse: { status: number; body: unknown };

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  delete process.env.CANGE_FLOW_ID;
  delete process.env.RUNNER_CARD_ID;
  delete process.env.CANGE_CARD_ID;
  delete process.env[FORCE_DRY_RUN_ENV];
  process.env.CANGE_BUSY_RETRY_MS = "5";
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  locateResponse = { status: 200, body: { id_card: 55, flow_id: 316, flow_name: "CNG CRM" } };
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
    if (method === "GET" && url.pathname === "/card/locate") return json(locateResponse.body, locateResponse.status);
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && url.pathname === "/field/by-flow") return json(FIELDS);
    if (method === "GET" && url.pathname === "/card/") return json(CARD);
    if (method === "PUT" && url.pathname === "/form/answer") return json({ id_card: 55 });
    if (method === "POST" && url.pathname === "/card-comment") return json({ id_card_comment: 901, card_id: body?.card_id });
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

function locateCalls() {
  return requests.filter((request) => request.method === "GET" && request.path === "/card/locate");
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

function errorMessage(): string {
  return String(JSON.parse(stderr.join("")).message);
}

describe("comando de cartão só com o número: o kit descobre o fluxo", () => {
  it("comment create --card-id N sem fluxo: GET /card/locate, comenta no fluxo certo e mostra resolved", async () => {
    const out = await run(["comment", "create", "--card-id", "55", "--text", "Feito"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(locateCalls()).toHaveLength(1);
    expect(locateCalls()[0]?.query.get("id_card")).toBe("55");
    expect(writes()[0]).toMatchObject({ path: "/card-comment", body: { card_id: 55, flow_id: 316 } });
    expect(out).toMatchObject({ ok: true, cardId: 55, resolved: { flow_id: 316, flow_name: "CNG CRM", via: "card-locate" } });
  });

  it("card update-values --card-id N --set sem fluxo: lê o cartão no fluxo descoberto", async () => {
    const out = await run(["card", "update-values", "--card-id", "#55", "--set", "Horas=3"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(locateCalls()).toHaveLength(1);
    expect(requests.find((request) => request.path === "/card/")?.query.get("flow_id")).toBe("316");
    expect(out?.resolved).toEqual({ flow_id: 316, flow_name: "CNG CRM", via: "card-locate" });
  });

  it("CANGE_FORCE_DRY_RUN: o locate é leitura e continua; nada é gravado", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const out = await run(["card", "move", "--card-id", "55", "--to", "Agendamento", "--set", "Horas=1"]);

    expect(locateCalls()).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(out?.resolved).toMatchObject({ flow_id: 316, via: "card-locate" });
  });
});

describe("quando o kit NÃO consulta o cartão", () => {
  it("--flow-id explícito, fluxo no ambiente do run ou link do cartão: sem GET /card/locate e sem resolved", async () => {
    const explicit = await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "a"]);
    expect(explicit?.resolved).toBeUndefined();

    stdout.length = 0;
    process.env.CANGE_CARD_FLOW_ID = "316";
    const fromEnv = await run(["comment", "create", "--card-id", "55", "--text", "b"]);
    expect(fromEnv?.resolved).toBeUndefined();

    stdout.length = 0;
    delete process.env.CANGE_CARD_FLOW_ID;
    await run(["comment", "create", "--card-id", "cange://card/55?flow=316", "--text", "c"]);

    stdout.length = 0;
    process.env.RUNNER_FLOW_ID = "316";
    const runnerEnv = await run(["card", "update-values", "--card-id", "55", "--set", "Horas=2"]);
    expect(runnerEnv?.resolved).toBeUndefined();

    expect(locateCalls()).toEqual([]);
    const comments = writes().filter((write) => write.path === "/card-comment");
    expect(comments.map((write) => write.body?.flow_id)).toEqual([316, 316, 316]);
    expect(requests.find((request) => request.path === "/card/")?.query.get("flow_id")).toBe("316");
  });

  it("--payload traz o próprio flowId: o parser não consulta o cartão", async () => {
    const options: Record<string, unknown> = { cardId: "55", payload: "./x.json" };
    const locate = vi.fn();
    const command = new Command("x").option("--flow-id <id>").option("--card-id <id>").option("--payload <p>");
    await expect(normalizeIdOptions(options, undefined, command, locate)).resolves.toEqual({});
    expect(locate).not.toHaveBeenCalled();
    expect(options.flowId).toBeUndefined();
  });

  it("comando sem --flow-id (ex.: card create não tem --card-id) ou sem locator: nada muda", async () => {
    const locate = vi.fn();
    const noFlowOption = new Command("x").option("--card-id <id>");
    const options: Record<string, unknown> = { cardId: "55" };
    await expect(normalizeIdOptions(options, undefined, noFlowOption, locate)).resolves.toEqual({});
    expect(locate).not.toHaveBeenCalled();

    const withFlow = new Command("y").option("--flow-id <id>").option("--card-id <id>");
    const same: Record<string, unknown> = { cardId: "55" };
    await expect(normalizeIdOptions(same, undefined, withFlow)).resolves.toEqual({});
    expect(same.flowId).toBeUndefined();
  });
});

describe("back antigo ou sem acesso: mantém o erro, com a dica do link", () => {
  it("404 do locate (rota inexistente ou sem acesso): update-values dá o erro de uso de sempre, exit 2", async () => {
    locateResponse = { status: 404, body: "Cannot GET /card/locate" };
    await run(["card", "update-values", "--card-id", "55", "--set", "Horas=3"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(locateCalls()).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toBe(FLOW_FROM_CARD_HINT);
    expect(errorMessage()).toContain("link do cartão");
    expect(errorMessage()).not.toContain("—");
  });

  it("404 no comment create: o erro do contrato pede o link, nada gravado", async () => {
    locateResponse = { status: 404, body: { message: "não encontrado ou sem acesso" } };
    await run(["comment", "create", "--card-id", "55", "--text", "x"]);

    expect(process.exitCode).not.toBe(0);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("o kit descobre pelo número do cartão");
    expect(errorMessage()).toContain("link do cartão");
  });

  it("5xx e 401 do locate sobem (não é o agente que errou); 4xx vira fallback", async () => {
    const command = new Command("x").option("--flow-id <id>").option("--card-id <id>");
    const down = vi.fn(async () => {
      throw new CangeApiError("fora do ar", { status: 503 });
    });
    await expect(normalizeIdOptions({ cardId: "55" }, undefined, command, down)).rejects.toBeInstanceOf(CangeApiError);

    const unauthorized = vi.fn(async () => {
      throw new CangeAuthError("token inválido", { status: 401 });
    });
    await expect(normalizeIdOptions({ cardId: "55" }, undefined, command, unauthorized)).rejects.toBeInstanceOf(
      CangeAuthError
    );

    const throttled = vi.fn(async () => {
      throw new CangeApiError("limite", { status: 429 });
    });
    await expect(normalizeIdOptions({ cardId: "55" }, undefined, command, throttled)).resolves.toEqual({});
  });
});
