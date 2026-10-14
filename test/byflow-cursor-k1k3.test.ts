import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CangeClient } from "../src/client/http.js";
import { CangeApiError } from "../src/client/errors.js";
import { createProgram } from "../src/cli/index.js";
import { createCardsContracts } from "../src/contracts/cards.js";

/**
 * EXE-K1 e EXE-K3 (E2E do lote F2-F6, 07/10/2026): fluxo V1 com `isLargeData = 'S'`.
 * O `GET /card/by-flow` devolve só a 1ª página (150 por padrão) com `totalIds` e
 * `cursorKey`; as seguintes vêm por `cursorKey` + `offset` (+ `limit`). O kit parava na
 * 1ª página: `cards count` deu 150 num fluxo de 1815 e `card list --engine v1` sumia com
 * 1665 cartões. Mock com o contrato do back (card.routes.ts, GET /by-flow, ramos 1 e 2).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ path: string; query: URLSearchParams }> = [];

const FLOW = {
  id_flow: 16195,
  name: "Prospecção",
  form_init_id: 900,
  flow_steps: [
    { id_step: 90401, name: "Base de Leads", form_id: 901, index: 1 },
    { id_step: 90402, name: "Sequencia 1", form_id: 902, index: 2 }
  ]
};
const FIELDS = [{ id_field: 12, name: "h12", title: "Valor", type: "CURRENCY_FIELD", form_id: 900 }];

const TOTAL = 1815;
const KEY = "flow_cards:67:76:16195:N:N:N:N:N:M:N";
let total = TOTAL;
let cursorKey: string | null = KEY;
/** Página (contando do 1) em que o cursor "vence" (400), como o TTL de 180 s do back. */
let expireAtCursorPage: number | undefined;
let cursorPages = 0;

/** Igual ao SQL do 16195: 1585 em Base de Leads, o resto em Sequencia 1. */
function card(id: number): Record<string, unknown> {
  return {
    id_card: id,
    flow_id: 16195,
    flow_step_id: id <= 1585 ? 90401 : 90402,
    title: `Lead ${id}`,
    form_answers: [{ form_answer_fields: [{ field_id: 12, value: String(id), deleted: "N" }] }]
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function byFlow(query: URLSearchParams): Response {
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  const limit = query.get("limit") ? Number(query.get("limit")) : 150;
  if (query.get("cursorKey")) {
    cursorPages += 1;
    if (query.get("cursorKey") !== cursorKey || (expireAtCursorPage !== undefined && cursorPages >= expireAtCursorPage)) {
      return json({ message: "Cursor inválido ou expirado" }, 400);
    }
    const offset = Number(query.get("offset") ?? 0);
    const slice = ids.slice(offset, offset + limit);
    return json({ mode: "largeData", cursorKey, totalIds: total, pageSize: limit, offset: offset + slice.length, ids: slice, cards: slice.map(card) });
  }
  const first = ids.slice(0, limit);
  return json({ mode: "largeData", cursorKey, totalIds: total, pageSize: limit, offset: first.length, ids: first, cards: first.map(card) });
}

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  total = TOTAL;
  cursorKey = KEY;
  expireAtCursorPage = undefined;
  cursorPages = 0;
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
    requests.push({ path: url.pathname, query: url.searchParams });
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && url.pathname === "/field/by-flow") return json(FIELDS);
    // Motor V2 desligado e fluxo sem a flag: V1, como o 16195.
    if (method === "GET" && url.pathname === "/flow/v2/query-engine-status") return json({ enabled: false });
    if (method === "GET" && url.pathname === "/card/by-flow/") return byFlow(url.searchParams);
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
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

function byFlowCalls() {
  return requests.filter((request) => request.path === "/card/by-flow/");
}

describe("EXE-K1: cards count/sum no V1 seguem o cursor do fluxo grande", () => {
  it("count por etapa = o SQL (1815: 1585 + 230), sem truncated, seguindo cursorKey + offset", async () => {
    const out = await runJson(["cards", "count", "--flow-id", "16195", "--by", "etapa"]);

    expect(out).toEqual({
      total: 1815,
      groups: [
        { key: "Base de Leads", stepId: 90401, count: 1585 },
        { key: "Sequencia 1", stepId: 90402, count: 230 }
      ]
    });
    const calls = byFlowCalls();
    expect(calls[0]?.query.get("flow_id")).toBe("16195");
    expect(calls[0]?.query.get("limit")).toBe("500");
    expect(calls.slice(1).map((call) => [call.query.get("cursorKey"), call.query.get("offset")])).toEqual([
      [KEY, "500"],
      [KEY, "1000"],
      [KEY, "1500"]
    ]);
    // As páginas do cursor levam os mesmos filtros (o back aplica de novo no ramo do cursor).
    expect(calls.every((call) => call.query.get("isArchived") === "false")).toBe(true);
  });

  it("--where etapa e sum também leem tudo", async () => {
    expect(await runJson(["cards", "count", "--flow-id", "16195", "--where", "etapa=Sequencia 1"])).toEqual({ total: 230 });
    // 1 + 2 + ... + 1815
    expect(await runJson(["cards", "sum", "--flow-id", "16195", "--field", "Valor"])).toEqual({ total: 1648020, cards: 1815 });
  });

  it("cursor vencido no meio (400): para e diz truncated, com o que leu", async () => {
    expireAtCursorPage = 2;
    const out = await runJson(["cards", "count", "--flow-id", "16195"]);
    expect(out).toEqual({ total: 1000, truncated: true });
  });

  it("back sem cursor (Redis fora, cursorKey null): só a 1ª página e truncated", async () => {
    cursorKey = null;
    const out = await runJson(["cards", "count", "--flow-id", "16195"]);
    expect(out).toEqual({ total: 500, truncated: true });
    expect(byFlowCalls()).toHaveLength(1);
  });
});

describe("EXE-K3: card list no V1 com fluxo grande", () => {
  it("1ª página: pede só o necessário ao back e devolve o next", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--engine", "v1"]);

    expect(out).toMatchObject({ engine: "v1", total: 20, totalCount: 1815, truncated: true });
    expect(out.next).toBe("cange card list --flow-id 16195 --engine v1 --cursor 20");
    expect(byFlowCalls()).toHaveLength(1);
    expect(byFlowCalls()[0]?.query.get("limit")).toBe("21");
  });

  it("a página que antes era a última (140) agora segue para além dos 150", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--engine", "v1", "--cursor", "140"]);
    expect(out.summaries.map((item: { cardId: number }) => item.cardId)).toEqual(Array.from({ length: 20 }, (_, i) => 141 + i));
    expect(out.next).toBe("cange card list --flow-id 16195 --engine v1 --cursor 160");
    expect(out.truncated).toBe(true);
  });

  it("última página: os 15 que faltam, sem next e sem truncated", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--engine", "v1", "--cursor", "1800"]);
    expect(out.summaries.map((item: { cardId: number }) => item.cardId)).toEqual(Array.from({ length: 15 }, (_, i) => 1801 + i));
    expect(out.next).toBeUndefined();
    expect(out.truncated).toBe(false);
    expect(out.totalCount).toBe(1815);
  });

  it("seguindo o next do começo ao fim: todos os cartões, nenhum repetido", async () => {
    total = 95;
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const args = ["card", "list", "--flow-id", "16195", "--engine", "v1", ...(cursor ? ["--cursor", cursor] : [])];
      const out = await runJson(args);
      seen.push(...out.summaries.map((item: { cardId: number }) => item.cardId));
      cursor = out.next ? String(out.next).split("--cursor ")[1] : undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(95);
    expect(new Set(seen).size).toBe(95);
  });

  it("--step-id (o fluxo grande do back ignora a etapa): filtra aqui e segue o cursor até achar", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--engine", "v1", "--step-id", "90402"]);
    expect(out.summaries.map((item: { cardId: number }) => item.cardId)).toEqual(Array.from({ length: 20 }, (_, i) => 1586 + i));
    expect(out.next).toBe("cange card list --flow-id 16195 --engine v1 --step-id 90402 --cursor 20");
    // Os da etapa só aparecem no fim: a leitura chegou ao total, então o totalCount é exato.
    expect(out.totalCount).toBe(230);
  });

  it("--step-id com a página cheia antes do fim: sem totalCount inventado", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--engine", "v1", "--step-id", "90401"]);
    expect(out.summaries).toHaveLength(20);
    expect(out.totalCount).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(byFlowCalls()).toHaveLength(1);
  });

  it("caminho legado (--with-pre-answer) também segue o cursor e repassa o filtro nas páginas", async () => {
    const out = await runJson(["card", "list", "--flow-id", "16195", "--with-pre-answer", "true", "--cursor", "490"]);
    expect(out.summaries.map((item: { cardId: number }) => item.cardId)).toEqual(Array.from({ length: 20 }, (_, i) => 491 + i));
    const cursorCalls = byFlowCalls().filter((call) => call.query.get("cursorKey"));
    expect(cursorCalls.length).toBeGreaterThan(0);
    expect(cursorCalls.every((call) => call.query.get("isWithPreAnswer") === "true")).toBe(true);
  });
});

describe("listAllCardsByFlow (contrato)", () => {
  function client(get: (path: string, query: Record<string, unknown>) => unknown): CangeClient {
    return {
      get: vi.fn(async (path: string, options?: { query?: Record<string, unknown> }) => get(path, options?.query ?? {})),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      setAccessToken: vi.fn(),
      clearAccessToken: vi.fn(),
      getAccessToken: vi.fn()
    } as unknown as CangeClient;
  }

  function page(from: number, size: number, totalIds: number, offset = from + size): Record<string, unknown> {
    const ids = Array.from({ length: size }, (_, i) => from + i + 1);
    return { mode: "largeData", cursorKey: "k", totalIds, offset, ids, cards: ids.map(card) };
  }

  it("fluxo sem paginação (lista inteira): complete, 1 chamada", async () => {
    const fake = client(() => [card(1), card(2)]);
    const result = await createCardsContracts(fake).listAllCardsByFlow({ flowId: 1 });
    expect(result).toMatchObject({ complete: true });
    expect(result.summaries.map((item) => item.cardId)).toEqual([1, 2]);
  });

  it("teto: para no maxCards e devolve complete false", async () => {
    const fake = client((_path, query) => (query.cursorKey ? page(Number(query.offset), 500, 5000) : page(0, 500, 5000)));
    const result = await createCardsContracts(fake).listAllCardsByFlow({ flowId: 1, maxCards: 1000 });
    expect(result.complete).toBe(false);
    expect(result.summaries).toHaveLength(1000);
    expect(result.totalIds).toBe(5000);
  });

  it("página sem avanço do offset (back estranho): para, sem laço, e não repete cartão", async () => {
    const fake = client(() => page(0, 3, 300, 3));
    const result = await createCardsContracts(fake).listAllCardsByFlow({ flowId: 1 });
    expect(result.complete).toBe(false);
    expect(result.summaries.map((item) => item.cardId)).toEqual([1, 2, 3]);
  });

  it("erro que não é cursor vencido (403) propaga", async () => {
    const fake = client((_path, query) => {
      if (query.cursorKey) throw new CangeApiError("sem acesso", { status: 403 });
      return page(0, 500, 900);
    });
    await expect(createCardsContracts(fake).listAllCardsByFlow({ flowId: 1 })).rejects.toThrow("sem acesso");
  });
});
