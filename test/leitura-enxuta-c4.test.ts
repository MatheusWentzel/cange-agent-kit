import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { encodeToon, listOutput, resolveOutputFormat } from "../src/utils/toon.js";

import { BIG_MY_FLOWS, bigCardRaw, bigFlow, bigFlowFields } from "./fixtures/big-fixtures.js";

/**
 * C4 (card #1367459, onda F2c): saídas de leitura menores. `card read --fields`,
 * corte de 600 caracteres, `cards count/sum`, listagens paginadas, `map` resumido
 * e TOON experimental. Toda a API é mockada no `fetch`.
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
let routes: Record<string, unknown> = {};
/** Respostas dinâmicas por rota (ex.: paginação do V2 pelo cursor). */
let handlers: Record<string, (body: Record<string, unknown> | undefined, query: URLSearchParams) => unknown> = {};

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.CANGE_OUTPUT_FORMAT;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  routes = {};
  handlers = {};
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
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
    const key = `${method} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler && !(key in routes)) {
      return new Response(JSON.stringify({ message: `rota não mockada: ${key}` }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    const payload = handler ? handler(body, url.searchParams) : routes[key];
    // Resposta de erro: `{ __status: 429, message }` (o resto vira o corpo).
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
    if (record && typeof record.__status === "number") {
      const { __status, ...rest } = record;
      return new Response(JSON.stringify(rest), { status: __status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<string> {
  stdout.length = 0;
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  return stdout.join("");
}

async function runJson(args: string[]): Promise<Record<string, any>> {
  return JSON.parse(await run(args)) as Record<string, any>;
}

const FLOW = {
  id_flow: 316,
  name: "CRM",
  form_init_id: 900,
  flow_steps: [
    { id_step: 485, name: "Priorizados", form_id: 658, index: 1 },
    { id_step: 486, name: "Em execução", form_id: 659, index: 2 }
  ]
};

const FIELDS = [
  { id_field: 10, name: "h10", title: "Resumo", type: "INPUT_RICH_TEXT_FIELD", form_id: 900 },
  { id_field: 12, name: "h12", title: "Valor do Negócio", type: "CURRENCY_FIELD", form_id: 900 },
  {
    id_field: 13,
    name: "h13",
    title: "Prioridade",
    type: "COMBO_BOX_FIELD",
    form_id: 900,
    options: [
      { id_field_option: 1, value: "a", label: "Alta" },
      { id_field_option: 2, value: "b", label: "Baixa" }
    ]
  },
  { id_field: 14, name: "h14", title: "Data da ligação", type: "DATE_PICKER_FIELD", form_id: 659 }
];

// ---------------------------------------------------------------------------
// 1. card read --fields e corte de 600 caracteres
// ---------------------------------------------------------------------------

describe("card read: --fields e corte do valor longo", () => {
  const longText = `<p>${"ata da reunião com o cliente ".repeat(60)}</p>`;
  function cardRaw(): Record<string, unknown> {
    return {
      id_card: 1001,
      flow_id: 316,
      flow_step_id: 486,
      title: "Pedido ACME",
      form_answers: [
        {
          id_form_answer: 1,
          deleted: "N",
          form_answer_fields: [
            { field_id: 10, field: { id_field: 10, title: "Resumo", type: "INPUT_RICH_TEXT_FIELD" }, value: longText, valueString: longText, deleted: "N" },
            { field_id: 12, field: { id_field: 12, title: "Valor do Negócio", type: "CURRENCY_FIELD" }, value: "2500", valueString: "R$ 2.500,00", deleted: "N" },
            { field_id: 13, field: { id_field: 13, title: "Prioridade", type: "COMBO_BOX_FIELD" }, value: "a", valueString: "Alta", deleted: "N" }
          ]
        }
      ]
    };
  }

  it("sem --fields: valor acima de 600 caracteres sai cortado com a dica do --fields", async () => {
    routes["GET /card/"] = cardRaw();
    const out = await runJson(["card", "read", "--flow-id", "316", "--card-id", "1001"]);
    const resumo = out.fields.find((field: { id: number }) => field.id === 10);
    expect(resumo.format).toBe("markdown");
    expect(resumo.value.length).toBeLessThan(700);
    expect(resumo.value).toMatch(/…\(cortado: use --fields "Resumo" para ler inteiro\)$/);
    expect(out.fields.find((field: { id: number }) => field.id === 12).value).toBe("R$ 2.500,00");
  });

  it("--fields pelo título (sem acento/maiúscula) devolve SÓ esses campos, inteiros e legíveis", async () => {
    routes["GET /card/"] = cardRaw();
    routes["GET /field/by-flow"] = FIELDS;
    const out = await runJson(["card", "read", "--flow-id", "316", "--card-id", "1001", "--fields", "resumo, valor do negocio"]);
    expect(out.fields.map((field: { id: number }) => field.id)).toEqual([10, 12]);
    const resumo = out.fields[0];
    expect(resumo.value).not.toContain("cortado");
    expect(resumo.value).not.toContain("<p>");
    expect(resumo.value.length).toBeGreaterThan(1000);
  });

  it("--fields com campo vazio no cartão traz o título do fluxo e value nulo some no enxuto", async () => {
    routes["GET /card/"] = cardRaw();
    routes["GET /field/by-flow"] = FIELDS;
    const out = await runJson(["card", "read", "--flow-id", "316", "--card-id", "1001", "--fields", "Data da ligação,13"]);
    expect(out.fields).toEqual([{ id: 14, title: "Data da ligação" }, { id: 13, title: "Prioridade", value: "Alta" }]);
  });

  it("--fields com campo que não existe: erro de uso (exit 2) listando os campos, sem ler o cartão", async () => {
    routes["GET /card/"] = cardRaw();
    routes["GET /field/by-flow"] = FIELDS;
    await run(["card", "read", "--flow-id", "316", "--card-id", "1001", "--fields", "Cliente"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain('Campo \\"Cliente\\" não existe no fluxo 316');
    expect(stderr.join("")).toContain("Valor do Negócio");
    expect(requests.some((request) => request.path === "/card/")).toBe(false);
  });

  it("--fields e --field-ids juntos: erro de uso", async () => {
    routes["GET /card/"] = cardRaw();
    await run(["card", "read", "--flow-id", "316", "--card-id", "1001", "--fields", "Resumo", "--field-ids", "10"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("--fields vale no lote (--card-ids) com UMA leitura dos campos do fluxo", async () => {
    routes["GET /card/"] = cardRaw();
    routes["GET /field/by-flow"] = FIELDS;
    const out = await runJson(["card", "read", "--flow-id", "316", "--card-ids", "1001,1002", "--fields", "Prioridade", "--rps", "10"]);
    expect(out.ok).toBe(2);
    expect(out.cards[0].fields).toEqual([{ id: 13, title: "Prioridade", value: "Alta" }]);
    expect(requests.filter((request) => request.path === "/field/by-flow")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. cards count / cards sum
// ---------------------------------------------------------------------------

function v2Item(id: number, step: number, fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { card: { id_card: id, flow_id: 316, flow_step_id: step, title: `Cartão ${id}` }, fields };
}

const V2_ITEMS = [
  v2Item(1, 485, { "field:13": { valueString: "Alta" }, "field:12": { valueString: "R$ 1.000,00", valueNumber: 1000 } }),
  v2Item(2, 485, { "field:13": { valueString: "Baixa" }, "field:12": { valueString: "R$ 250,50", valueNumber: 250.5 } }),
  v2Item(3, 486, { "field:13": { valueString: "Alta" }, "field:12": { valueString: "R$ 2.000,00", valueNumber: 2000 } }),
  v2Item(4, 486, { "field:12": { valueString: "a combinar" } })
];

describe("cards count / cards sum", () => {
  beforeEach(() => {
    routes["GET /flow"] = FLOW;
    routes["GET /field/by-flow"] = FIELDS;
  });

  it("count --by etapa no motor V2: o back agrega (1 chamada, só ativos), saída {total, groups}", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/aggregations"] = {
      filtered_scope: { "COUNT:card:": 7 },
      step_counts: { "485": 4, "486": 3 },
      execution_stats: { duration_ms: 3 }
    };
    const out = await runJson(["cards", "count", "--flow-id", "316", "--by", "etapa"]);
    expect(out).toEqual({
      total: 7,
      groups: [
        { key: "Priorizados", stepId: 485, count: 4 },
        { key: "Em execução", stepId: 486, count: 3 }
      ]
    });
    const agg = requests.filter((request) => request.path === "/flow/v2/aggregations");
    expect(agg).toHaveLength(1);
    expect(agg[0]!.body).toMatchObject({
      flow_id: 316,
      flags: { isArchived: false },
      agg: [{ fn: "COUNT", target: "card", key: "", by_step: true }]
    });
    expect(requests.some((request) => request.path === "/flow/v2/query")).toBe(false);
  });

  it("count --where por campo: lê paginado (V2, só o campo do filtro, sem arquivados) e conta aqui", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    handlers["POST /flow/v2/query"] = (body) =>
      body?.cursor === undefined
        ? { items: V2_ITEMS.slice(0, 2), page_info: { has_more: true, next_cursor: "c2" } }
        : { items: V2_ITEMS.slice(2), page_info: { has_more: false } };
    const out = await runJson(["card", "count", "--flow-id", "316", "--where", "prioridade=alta", "--by", "etapa"]);
    expect(out).toEqual({
      total: 2,
      groups: [
        { key: "Priorizados", stepId: 485, count: 1 },
        { key: "Em execução", stepId: 486, count: 1 }
      ]
    });
    const queries = requests.filter((request) => request.path === "/flow/v2/query");
    expect(queries).toHaveLength(2);
    expect(queries[0]!.body).toMatchObject({ flow_id: 316, page_size: 500, flags: { isArchived: false } });
    expect((queries[0]!.body!.fields as Array<{ id_field: number }>).map((field) => field.id_field)).toEqual([13]);
    expect(queries[1]!.body).toMatchObject({ cursor: "c2" });
  });

  it("count --by campo e --where etapa / !=: agrupa pelo valor, vazio vira (vazio)", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { items: V2_ITEMS, page_info: { has_more: false } };
    const byField = await runJson(["cards", "count", "--flow-id", "316", "--by", 'campo:"Prioridade"']);
    expect(byField).toEqual({
      total: 4,
      groups: [
        { key: "Alta", count: 2 },
        { key: "Baixa", count: 1 },
        { key: "(vazio)", count: 1 }
      ]
    });
    const notAlta = await runJson(["cards", "count", "--flow-id", "316", "--where", "Prioridade!=Alta", "--where", "etapa=Em execução"]);
    expect(notAlta).toEqual({ total: 1 });
  });

  it("count sem V2: lê o /card/by-flow sem arquivados e conta as etapas", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: false };
    routes["GET /card/by-flow/"] = [
      { id_card: 1, flow_id: 316, flow_step_id: 485, form_answers: [] },
      { id_card: 2, flow_id: 316, flow_step_id: 486, form_answers: [] },
      { id_card: 3, flow_id: 316, flow_step_id: 486, form_answers: [] }
    ];
    const out = await runJson(["cards", "count", "--flow-id", "316", "--by", "etapa"]);
    expect(out.total).toBe(3);
    expect(out.groups).toEqual([
      { key: "Priorizados", stepId: 485, count: 1 },
      { key: "Em execução", stepId: 486, count: 2 }
    ]);
    const list = requests.find((request) => request.path === "/card/by-flow/");
    expect(list?.query.get("isArchived")).toBe("false");
  });

  it("sum sem filtro no V2: SUM do campo no agregador; --by etapa faz 1 chamada por etapa", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    handlers["POST /flow/v2/aggregations"] = (body) => {
      const step = body?.flow_step_id;
      if (step === 485) return { filtered_scope: { "SUM:field:12": 1250.5, "COUNT:card:": 2 }, execution_stats: {} };
      if (step === 486) return { filtered_scope: { "SUM:field:12": 2000, "COUNT:card:": 2 }, execution_stats: {} };
      return { filtered_scope: { "SUM:field:12": 3250.5, "COUNT:card:": 4 }, execution_stats: {} };
    };
    expect(await runJson(["cards", "sum", "--flow-id", "316", "--field", "Valor do Negócio"])).toEqual({ total: 3250.5, cards: 4 });
    const byStep = await runJson(["cards", "sum", "--flow-id", "316", "--field", "12", "--by", "etapa"]);
    expect(byStep).toEqual({
      total: 3250.5,
      cards: 4,
      groups: [
        { key: "Priorizados", stepId: 485, sum: 1250.5 },
        { key: "Em execução", stepId: 486, sum: 2000 }
      ]
    });
  });

  it("sum com --where: soma aqui, valor que não é número entra em ignored", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { items: V2_ITEMS, page_info: { has_more: false } };
    const out = await runJson(["cards", "sum", "--flow-id", "316", "--field", "Valor do Negócio", "--where", "etapa=486"]);
    expect(out).toEqual({ total: 2000, cards: 2, ignored: 1 });
    const byField = await runJson(["cards", "sum", "--flow-id", "316", "--field", "Valor do Negócio", "--by", "campo:Prioridade"]);
    expect(byField.total).toBe(3250.5);
    expect(byField.groups).toEqual([
      { key: "Alta", sum: 3000 },
      { key: "Baixa", sum: 250.5 },
      { key: "(vazio)", sum: 0 }
    ]);
  });

  it("agregador recusou (ex.: 404): cai na leitura paginada com o mesmo resultado", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { items: V2_ITEMS, page_info: { has_more: false } };
    const out = await runJson(["cards", "count", "--flow-id", "316", "--by", "etapa"]);
    expect(out.total).toBe(4);
    expect(out.groups).toEqual([
      { key: "Priorizados", stepId: 485, count: 2 },
      { key: "Em execução", stepId: 486, count: 2 }
    ]);
  });

  it("campo inexistente, ambíguo ou sum sem --field: erro de uso (exit 2)", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    await run(["cards", "count", "--flow-id", "316", "--where", "Cliente=ACME"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    process.exitCode = undefined;
    await run(["cards", "sum", "--flow-id", "316"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    process.exitCode = undefined;
    routes["GET /field/by-flow"] = [...FIELDS, { id_field: 99, name: "h99", title: "Prioridade", type: "COMBO_BOX_FIELD", form_id: 659 }];
    await run(["cards", "count", "--flow-id", "316", "--by", "campo:Prioridade"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("Use o id");
  });

  it("--format toon: grupos em tabela (cabeçalho uma vez)", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/aggregations"] = { filtered_scope: {}, step_counts: { "485": 4, "486": 3 }, execution_stats: {} };
    const out = await run(["--format", "toon", "cards", "count", "--flow-id", "316", "--by", "etapa"]);
    expect(out).toBe("total: 7\ngroups[2]{key,stepId,count}:\n  Priorizados,485,4\n  Em execução,486,3\n");
  });
});

// ---------------------------------------------------------------------------
// 3. Listagens paginadas e map resumido
// ---------------------------------------------------------------------------

describe("listagens: página padrão menor, total e próxima página", () => {
  it("card list (V2): pede 20 por padrão, traz totalCount e o comando da próxima página", async () => {
    routes["GET /flow"] = FLOW;
    routes["POST /flow/v2/query"] = {
      items: Array.from({ length: 20 }, (_, i) => v2Item(i + 1, 485, {})),
      page_info: { has_more: true, next_cursor: "abc" },
      execution_stats: { total_count: 57 }
    };
    const out = await runJson(["card", "list", "--flow-id", "316", "--engine", "v2"]);
    const query = requests.find((request) => request.path === "/flow/v2/query");
    expect(query?.body).toMatchObject({ page_size: 20 });
    expect(out).toMatchObject({ total: 20, totalCount: 57, truncated: true, next: "cange card list --flow-id 316 --cursor abc" });

    await runJson(["card", "list", "--flow-id", "316", "--engine", "v2", "--cursor", "abc"]);
    const second = requests.filter((request) => request.path === "/flow/v2/query").at(-1);
    expect(second?.body).toMatchObject({ cursor: "abc", page_size: 20 });
  });

  it("card list --full continua trazendo tudo (sem página padrão)", async () => {
    routes["POST /flow/v2/query"] = { items: [v2Item(1, 485, {})], page_info: { has_more: false } };
    await run(["--full", "card", "list", "--flow-id", "316", "--engine", "v2"]);
    const query = requests.find((request) => request.path === "/flow/v2/query");
    expect(query?.body).not.toHaveProperty("page_size");
  });

  it("my-flows: 20 por página, total de todos e next com o cursor", async () => {
    routes["GET /flow/my-flows"] = Array.from({ length: 25 }, (_, i) => ({ id_flow: i + 1, name: `Fluxo ${i + 1}`, form_init_id: 100 + i }));
    const first = await runJson(["my-flows"]);
    expect(first.summaries).toHaveLength(20);
    expect(first.total).toBe(25);
    expect(first.next).toBe("cange my-flows --cursor 20");
    const second = await runJson(["my-flows", "--cursor", "20"]);
    expect(second.summaries.map((flow: { id: number }) => flow.id)).toEqual([21, 22, 23, 24, 25]);
    expect(second).not.toHaveProperty("next");
  });

  it("register entries: sem raw, página de 20 na v2 e next com o cursor do back", async () => {
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "S", isLargeData: "N" };
    routes["GET /field/by-register"] = [{ id_field: 1, name: "h1", title: "Nome", type: "TEXT_SHORT_FIELD", form_id: 50 }];
    routes["POST /register/v2/query"] = {
      items: [{ "form_answer.id_form_answer": 7, "form_answer.title": "ACME", "field:1": { display_value: "ACME Ltda" } }],
      page_info: { has_more: true, next_cursor: "n2" },
      execution_stats: { total_count: 120 }
    };
    const out = await runJson(["register", "entries", "--register-id", "175"]);
    expect(out).toEqual({
      registerId: 175,
      engine: "v2",
      total: 120,
      count: 1,
      next: "cange register entries --register-id 175 --cursor n2",
      // v9 (run 1131): os títulos do cadastro, uma vez no topo (campo que falta na entrada está vazio).
      fieldTitles: ["Nome"],
      entries: [{ id: 7, title: "ACME", fields: { Nome: "ACME Ltda" } }]
    });
    expect(requests.find((request) => request.path === "/register/v2/query")?.body).toMatchObject({ page_size: 20 });
  });

  it("register entries na v1: pagina a lista aqui (cursor = deslocamento)", async () => {
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "N", isLargeData: "N" };
    routes["GET /register"] = {
      id_register: 175,
      form_answers: Array.from({ length: 23 }, (_, i) => ({
        id_form_answer: i + 1,
        form_answer_fields: [{ field_id: 1, field: { title: "Nome" }, valueString: `Cliente ${i + 1}` }]
      }))
    };
    const first = await runJson(["register", "entries", "--register-id", "175"]);
    expect(first).toMatchObject({ engine: "v1", total: 23, count: 20, next: "cange register entries --register-id 175 --cursor 20" });
    const second = await runJson(["register", "entries", "--register-id", "175", "--cursor", "20"]);
    expect(second.entries.map((entry: { id: number }) => entry.id)).toEqual([21, 22, 23]);
    expect(second).not.toHaveProperty("next");
  });

  it("register entries --full mantém o formato de antes (com raw)", async () => {
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "N" };
    routes["GET /register"] = { id_register: 175, form_answers: [] };
    const out = await runJson(["--full", "register", "entries", "--register-id", "175"]);
    expect(out).toHaveProperty("raw");
    expect(out).toHaveProperty("pageInfo");
  });

  it("map: opções em linha só até 8; acima disso, só a contagem", async () => {
    routes["GET /flow/my-flows"] = BIG_MY_FLOWS;
    routes["GET /flow"] = bigFlow();
    routes["GET /field/by-flow"] = bigFlowFields();
    const out = await runJson(["map", "--flow-id", "316"]);
    const flow = out.flows[0];
    expect(flow.steps).toHaveLength(6);
    expect(Object.keys(flow.steps[0]).sort()).toEqual(["fields", "id", "name"]);
    const all = [...flow.startFields, ...flow.steps.flatMap((step: { fields?: unknown[] }) => step.fields ?? [])];
    expect(all).toHaveLength(72);
    const withOptions = all.filter((field: { options?: string[] }) => field.options);
    const withCount = all.filter((field: { optionsCount?: number }) => field.optionsCount);
    expect(withOptions.length).toBeGreaterThan(0);
    expect(withCount.length).toBeGreaterThan(0);
    for (const field of withOptions) expect(field.options.length).toBeLessThanOrEqual(8);
    for (const field of withCount) expect(field.optionsCount).toBeGreaterThan(8);
    expect(all.every((field: { required?: boolean }) => field.required === undefined || field.required === true)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('"formId"');
  });
});

// ---------------------------------------------------------------------------
// 4. TOON experimental
// ---------------------------------------------------------------------------

describe("TOON (experimental)", () => {
  it("encodeToon: cabeçalho uma vez, vazio para ausente, aspas para vírgula, aspas e quebra", () => {
    const text = encodeToon(
      listOutput(
        {
          total: 3,
          items: [
            { id: 1, name: "Simples" },
            { id: 2, name: "Com, vírgula", extra: true },
            { id: 3, name: 'Com "aspas"\ne quebra', tags: ["a", "b"] }
          ]
        },
        "items"
      )
    );
    expect(text).toBe(
      [
        "total: 3",
        "items[3]{id,name,extra,tags}:",
        "  1,Simples,,",
        '  2,"Com, vírgula",true,',
        '  3,"Com \\"aspas\\"\\ne quebra",,"[\\"a\\",\\"b\\"]"'
      ].join("\n")
    );
  });

  it("resolveOutputFormat: padrão json; --format vence o ambiente; valor inválido é erro de uso", () => {
    expect(resolveOutputFormat(undefined, {})).toBe("json");
    expect(resolveOutputFormat(undefined, { CANGE_OUTPUT_FORMAT: "TOON" })).toBe("toon");
    expect(resolveOutputFormat("json", { CANGE_OUTPUT_FORMAT: "toon" })).toBe("json");
    expect(() => resolveOutputFormat("yaml", {})).toThrow(/json ou toon/);
  });

  const MY_FLOWS = [
    { id_flow: 316, name: "CNG CRM", form_init_id: 900, total_cards: 42, typeUserAccess: "A" },
    { id_flow: 317, name: "Compras, Suprimentos", form_init_id: 901, total_cards: 0 }
  ];

  it("JSON padrão NÃO muda: sem --format é o mesmo texto de --format json (e de antes)", async () => {
    routes["GET /flow/my-flows"] = MY_FLOWS;
    const plain = await run(["my-flows"]);
    expect(await run(["--format", "json", "my-flows"])).toBe(plain);
    expect(plain).toBe(
      `${JSON.stringify({
        summaries: [
          { id: 316, title: "CNG CRM", formInitId: 900, totalCards: 42, access: "A" },
          { id: 317, title: "Compras, Suprimentos", formInitId: 901, totalCards: 0 }
        ],
        total: 2
      })}\n`
    );
  });

  it("--format toon e CANGE_OUTPUT_FORMAT=toon: my-flows em tabela", async () => {
    routes["GET /flow/my-flows"] = MY_FLOWS;
    const expected = 'total: 2\nsummaries[2]{id,title,formInitId,totalCards,access}:\n  316,CNG CRM,900,42,A\n  317,"Compras, Suprimentos",901,0,\n';
    expect(await run(["--format", "toon", "my-flows"])).toBe(expected);
    process.env.CANGE_OUTPUT_FORMAT = "toon";
    expect(await run(["my-flows"])).toBe(expected);
  });

  it("comando que não é lista ignora o toon (card read segue JSON); --full ignora o toon", async () => {
    routes["GET /card/"] = { id_card: 1001, flow_id: 316, title: "X", form_answers: [] };
    const read = await run(["--format", "toon", "card", "read", "--flow-id", "316", "--card-id", "1001"]);
    expect(() => JSON.parse(read)).not.toThrow();
    routes["GET /flow/my-flows"] = MY_FLOWS;
    const full = await run(["--format", "toon", "--full", "my-flows"]);
    expect(JSON.parse(full)).toHaveProperty("raw");
  });
});

// ---------------------------------------------------------------------------
// 5. Tamanho: map e card read padrão menores que antes num fixture grande
// ---------------------------------------------------------------------------

describe("tamanho da saída padrão (fixture grande)", () => {
  /**
   * Medido no kit ANTES do C4 (branch F2b, 06/10), com os mesmos fixtures:
   * `map --flow-id 316` = 7.638 caracteres; `card read` = 13.742 caracteres.
   */
  const BEFORE = { map: 7_638, cardRead: 13_742 };

  beforeEach(() => {
    routes["GET /flow/my-flows"] = BIG_MY_FLOWS;
    routes["GET /flow"] = bigFlow();
    routes["GET /field/by-flow"] = bigFlowFields();
    routes["GET /card/"] = bigCardRaw();
  });

  it("map resumido < antes (mesmo trazendo as opções curtas)", async () => {
    const out = await run(["map", "--flow-id", "316"]);
    expect(out.length).toBeLessThan(BEFORE.map);
    expect(out.length).toBeLessThan(BEFORE.map * 0.9);
  });

  it("card read padrão < metade de antes (rich text cortado em 600)", async () => {
    const out = await run(["card", "read", "--flow-id", "316", "--card-id", "1001"]);
    expect(out.length).toBeLessThan(BEFORE.cardRead * 0.6);
    const parsed = JSON.parse(out);
    expect(parsed.fields).toHaveLength(48);
  });

  it("card read --fields de 2 campos é uma fração do padrão", async () => {
    const all = await run(["card", "read", "--flow-id", "316", "--card-id", "1001"]);
    const two = await run(["card", "read", "--flow-id", "316", "--card-id", "1001", "--fields", "Campo 0 Informação,Campo 2 Informação"]);
    expect(two.length).toBeLessThan(all.length / 10);
  });
});

// ---------------------------------------------------------------------------
// 3ª revisão da F2c (K1 a K5): continuar a página, não cair no V1 à toa, soma do banco
// ---------------------------------------------------------------------------

function v1Card(id: number, step: number, value?: string): Record<string, unknown> {
  return {
    id_card: id,
    flow_id: 316,
    flow_step_id: step,
    title: `Cartão ${id}`,
    form_answers:
      value === undefined ? [] : [{ form_answer_fields: [{ field_id: 12, value, deleted: "N" }] }]
  };
}

describe("F2c revisão 3: paginação e fallback V2→V1", () => {
  beforeEach(() => {
    routes["GET /flow"] = FLOW;
    routes["GET /field/by-flow"] = FIELDS;
  });

  it("K1: --limit 700 pede 500 + 200 e devolve o cursor que continua (sem corte no meio da página)", async () => {
    handlers["POST /flow/v2/query"] = (body) => {
      const size = Number(body?.page_size);
      const start = body?.cursor === undefined ? 0 : 500;
      return {
        items: Array.from({ length: size }, (_, i) => v2Item(start + i + 1, 485, {})),
        page_info: { has_more: true, next_cursor: body?.cursor === undefined ? "c1" : "c2" }
      };
    };
    const out = await runJson(["card", "list", "--flow-id", "316", "--engine", "v2", "--limit", "700"]);
    const sizes = requests.filter((request) => request.path === "/flow/v2/query").map((request) => request.body?.page_size);
    expect(sizes).toEqual([500, 200]);
    expect(out.total).toBe(700);
    expect(out.truncated).toBe(true);
    expect(out.next).toBe("cange card list --flow-id 316 --limit 700 --cursor c2");
  });

  it("K2: motor auto com --cursor e V2 em falha NÃO cai no V1 (propaga o erro)", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { __status: 500, message: "boom" };
    routes["GET /card/by-flow/"] = [v1Card(1, 485)];
    await run(["card", "list", "--flow-id", "316", "--cursor", "eyJpZCI6MX0="]);
    expect(process.exitCode).toBeTruthy();
    expect(requests.some((request) => request.path === "/card/by-flow/")).toBe(false);
  });

  it("K2: sem cursor, falha do motor cai no V1 e o next da página do V1 fixa --engine v1", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { __status: 503, message: "fora" };
    routes["GET /card/by-flow/"] = Array.from({ length: 25 }, (_, i) => v1Card(i + 1, 485));
    const out = await runJson(["card", "list", "--flow-id", "316"]);
    expect(out.engine).toBe("v1");
    expect(out.next).toBe("cange card list --flow-id 316 --engine v1 --cursor 20");
  });

  it("K2: cursor que não é número no V1 é erro de uso (exit 2), não recomeça do zero", async () => {
    routes["GET /card/by-flow/"] = Array.from({ length: 25 }, (_, i) => v1Card(i + 1, 485));
    await run(["card", "list", "--flow-id", "316", "--engine", "v1", "--cursor", "eyJpZCI6MX0="]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("não é deste motor");
    process.exitCode = undefined;
    await run(["card", "list", "--flow-id", "316", "--with-pre-answer", "true", "--cursor", "abc"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("K2: falha de uso do V2 (403) também não cai no V1 em card list", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { __status: 403, message: "Flow sem acesso" };
    routes["GET /card/by-flow/"] = [v1Card(1, 485)];
    await run(["card", "list", "--flow-id", "316"]);
    expect(process.exitCode).toBeTruthy();
    expect(requests.some((request) => request.path === "/card/by-flow/")).toBe(false);
  });

  it.each([401, 403, 429, 400])("K3: cards count com V2 em %i propaga, sem cair no /card/by-flow", async (status) => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { __status: status, message: "recusado" };
    routes["GET /card/by-flow/"] = [v1Card(1, 485)];
    await run(["cards", "count", "--flow-id", "316", "--where", "Prioridade=Alta"]);
    expect(process.exitCode).toBeTruthy();
    expect(requests.some((request) => request.path === "/card/by-flow/")).toBe(false);
  });

  it("K3: agregador em 429 propaga (não vira leitura paginada)", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/aggregations"] = { __status: 429, message: "limite" };
    routes["POST /flow/v2/query"] = { items: V2_ITEMS, page_info: { has_more: false } };
    await run(["cards", "count", "--flow-id", "316", "--by", "etapa"]);
    expect(process.exitCode).toBeTruthy();
    expect(requests.some((request) => request.path === "/flow/v2/query")).toBe(false);
  });

  it("K3: falha do motor (500) cai no V1; fluxo grande no V1 sai truncated:true", async () => {
    routes["GET /flow/v2/query-engine-status"] = { enabled: true };
    routes["POST /flow/v2/query"] = { __status: 500, message: "boom" };
    routes["GET /card/by-flow/"] = {
      mode: "largeData",
      cursorKey: "k",
      totalIds: 300,
      pageSize: 150,
      offset: 3,
      ids: [1, 2, 3],
      cards: [v1Card(1, 485), v1Card(2, 486), v1Card(3, 486)]
    };
    const out = await runJson(["cards", "count", "--flow-id", "316", "--where", "etapa=486"]);
    expect(out).toEqual({ total: 2, truncated: true });
  });
});

describe("F2c revisão 3: soma com o número do banco (K4)", () => {
  beforeEach(() => {
    routes["GET /flow"] = FLOW;
    routes["GET /field/by-flow"] = FIELDS;
    routes["GET /flow/v2/query-engine-status"] = { enabled: false };
  });

  it("K4: no V1, '1.500' e '12,345' do banco entram na soma (1,5 e 12,345), sem 'ambíguo'", async () => {
    routes["GET /card/by-flow/"] = [
      v1Card(1, 485, "1.500"),
      v1Card(2, 485, "12,345"),
      v1Card(3, 486, "1.234,56"),
      v1Card(4, 486, "2500"),
      v1Card(5, 486, "a combinar")
    ];
    const out = await runJson(["cards", "sum", "--flow-id", "316", "--field", "Valor do Negócio"]);
    expect(out).toEqual({ total: 3748.405, cards: 5, ignored: 1 });
  });

  it("K4: parseStoredNumber espelha o back; parseLocaleNumber (entrada humana) segue recusando o ambíguo", async () => {
    const { parseLocaleNumber, parseStoredNumber } = await import("../src/utils/valueResolver.js");
    expect(parseStoredNumber("1.500")).toBe(1.5);
    expect(parseStoredNumber("12,345")).toBe(12.345);
    expect(parseStoredNumber("1.234,56")).toBe(1234.56);
    expect(parseStoredNumber("1,234.56")).toBe(1234.56);
    expect(parseStoredNumber("R$ 2.000,00")).toBe(2000);
    expect(parseStoredNumber("-3.5")).toBe(-3.5);
    expect(parseStoredNumber("15%")).toBe(0.15);
    expect(parseStoredNumber(42)).toBe(42);
    expect(parseStoredNumber("a combinar")).toBeUndefined();
    expect(parseStoredNumber("")).toBeUndefined();
    expect(parseLocaleNumber("1.500").ok).toBe(false);
  });
});

describe("F2c revisão 3: truncated também no V1 (K5)", () => {
  beforeEach(() => {
    routes["GET /flow"] = FLOW;
  });

  it("K5: card list --engine v1 com mais de 20 traz truncated:true; com menos, false", async () => {
    routes["GET /card/by-flow/"] = Array.from({ length: 25 }, (_, i) => v1Card(i + 1, 485));
    const out = await runJson(["card", "list", "--flow-id", "316", "--engine", "v1"]);
    expect(out).toMatchObject({ engine: "v1", total: 20, totalCount: 25, truncated: true });
    const last = await runJson(["card", "list", "--flow-id", "316", "--engine", "v1", "--cursor", "20"]);
    expect(last).toMatchObject({ total: 5, truncated: false });
    expect(last.next).toBeUndefined();
  });

  it("K5: caminho legado (--with-pre-answer) também traz truncated e o next com os mesmos --with-*", async () => {
    routes["GET /card/by-flow/"] = Array.from({ length: 25 }, (_, i) => v1Card(i + 1, 485));
    const out = await runJson(["card", "list", "--flow-id", "316", "--with-pre-answer", "true"]);
    expect(out).toMatchObject({ engine: "v1", total: 20, truncated: true });
    expect(out.next).toBe("cange card list --flow-id 316 --engine v1 --with-pre-answer true --cursor 20");
  });
});
