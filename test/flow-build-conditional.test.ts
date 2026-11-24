import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCommandMeta } from "../src/cli/command-metadata.js";
import { createProgram } from "../src/cli/index.js";
import {
  CONDITION_SOURCE_TYPES,
  buildConditionItem,
  buildConditionalName,
  editorIssues,
  readFlowStructure,
  type ConditionItem,
  type ConditionLookups
} from "../src/utils/conditionalBuilder.js";
import {
  ATIVO,
  DETALHE,
  FLOW_ID,
  LEAN_RULE,
  PEDIDO,
  SCREEN_FIELD_KEYS,
  SCREEN_ITEM_KEYS,
  SEM_OPCOES,
  STEP_A,
  STEP_B,
  TIPO,
  field,
  flow,
  options,
  screenRule
} from "./fixtures/conditional-flow.js";

type Rec = Record<string, unknown>;

const envBackup = { ...process.env };
const structure = readFlowStructure(flow())!;

const lookups: ConditionLookups = {
  usersByForm: async () => [
    { id: 41, name: "Ana Teste", email: "ana@example.com" },
    { id: 42, name: "Bia Teste", email: "bia@example.com" }
  ],
  registerOfEntry: async (id) => (id === 700 ? 70 : id === 701 ? 71 : undefined),
  flowOfCard: async (id) => (id === 800 ? 80 : undefined)
};

const build = (input: Parameters<typeof buildConditionItem>[1]): Promise<ConditionItem> =>
  buildConditionItem(structure, input, 0, lookups);

describe("item de condição no formato da tela", () => {
  it("grava exatamente as chaves da tela, com o campo de origem inteiro", async () => {
    const item = await build({ field: 1, comparator: "Igual a", value: "Externo" });
    expect(Object.keys(item).sort()).toEqual(SCREEN_ITEM_KEYS);
    expect(Object.keys(item.selectedField).sort()).toEqual(SCREEN_FIELD_KEYS);
    expect(item.selectedField.options).toEqual(TIPO.options);
    expect(item).toMatchObject({
      index: 0,
      fields: [],
      comparators: [],
      selectedComparator: "Igual a",
      value: "",
      nameComponent: "OPTION_FILTER",
      valueOptions: ["2"]
    });
    expect(editorIssues(item)).toEqual([]);
  });

  it("não aninha as condicionais do próprio campo de origem", async () => {
    const nested = readFlowStructure(flow([screenRule(1, 1, ATIVO)]))!;
    const item = await buildConditionItem(nested, { field: 1, comparator: "Igual a", value: "1" }, 0, lookups);
    expect(item.selectedField.conditionals).toEqual([]);
  });

  it("campo pelo id, hash ou título; opção por código ou rótulo (sem acento e caixa)", async () => {
    for (const ref of [1, "1", "hash1", "tipo"]) {
      expect((await build({ field: ref, comparator: "igual a", value: "externo" })).valueOptions).toEqual(["2"]);
    }
    expect((await build({ field: 1, comparator: "É uma das", values: ["1", "Externo", "1"] })).valueOptions).toEqual(["1", "2"]);
  });

  it("texto que é código de uma opção e rótulo de outra: recusa; code/label explícito resolve", async () => {
    await expect(build({ field: 1, comparator: "Igual a", value: "2" })).rejects.toThrow(/ambíguo/);
    expect((await build({ field: 1, comparator: "Igual a", value: { code: "2" } })).valueOptions).toEqual(["2"]);
    expect((await build({ field: 1, comparator: "Igual a", value: { label: "2" } })).valueOptions).toEqual(["3"]);
  });

  it("texto, número e fórmula vão em value; em branco vai sem valor", async () => {
    expect(await build({ field: 2, comparator: "Contém", value: "abc" })).toMatchObject({ value: "abc", valueOptions: [], nameComponent: "TEXT_FILTER" });
    expect((await build({ field: 3, comparator: "Maior que", value: 1500.5 })).value).toBe("1500.5");
    expect((await build({ field: 16, comparator: "Igual a", value: "50%" })).value).toBe("50%");
    expect(await build({ field: 1, comparator: "Está em branco" })).toMatchObject({ value: "", valueOptions: [] });
  });

  it("data vai em valueOptions como dd/MM/yyyy", async () => {
    expect(await build({ field: 4, comparator: "Antes de", value: "2026-12-31" })).toMatchObject({
      nameComponent: "DATE_FILTER",
      value: "",
      valueOptions: ["31/12/2026"]
    });
    await expect(build({ field: 4, comparator: "Igual a", value: "31/02/2026" })).rejects.toThrow(/dd\/MM\/yyyy/);
    await expect(build({ field: 4, comparator: "Igual a", value: "-1" })).rejects.toThrow(/relativo/);
  });

  it("switch: só Igual a, verdadeiro ou falso", async () => {
    expect((await build({ field: 5, comparator: "Igual a", value: true })).valueOptions).toEqual(["true"]);
    expect((await build({ field: 5, comparator: "Igual a", value: "Falso" })).valueOptions).toEqual(["false"]);
    await expect(build({ field: 5, comparator: "Não é igual a", value: true })).rejects.toThrow(/Comparador/);
  });

  it("usuário por id, nome, e-mail ou usuário logado; fora da lista recusa", async () => {
    for (const value of [41, "ana teste", "ana@example.com"]) {
      expect((await build({ field: 7, comparator: "Igual a", value })).valueOptions).toEqual(["41"]);
    }
    expect((await build({ field: 7, comparator: "Igual a", value: "Usuário logado" })).valueOptions).toEqual(["-1"]);
    await expect(build({ field: 7, comparator: "Igual a", value: 99 })).rejects.toThrow(/não está nas opções/);
  });

  it("cadastro e cartão: id conferido contra o vínculo do campo", async () => {
    expect((await build({ field: 8, comparator: "Igual a", value: 700 })).valueOptions).toEqual(["700"]);
    expect((await build({ field: 9, comparator: "Igual a", value: "800" })).valueOptions).toEqual(["800"]);
    await expect(build({ field: 8, comparator: "Igual a", value: 701 })).rejects.toThrow(/não é do cadastro 70/);
    await expect(build({ field: 8, comparator: "Igual a", value: 999 })).rejects.toThrow(/não é do cadastro 70/);
    await expect(build({ field: 9, comparator: "Igual a", value: 801 })).rejects.toThrow(/não é do fluxo 80/);
    await expect(build({ field: 8, comparator: "Igual a", value: "Empresa X" })).rejects.toThrow(/id numérico/);
  });

  it("campos padrão: responsável leva form_id e etapa leva as etapas como opções", async () => {
    expect(await build({ field: -3, comparator: "Igual a", value: "-1" })).toMatchObject({
      selectedField: { id_field: -3, type: "COMBO_BOX_USER_FIELD", form_id: 200 },
      valueOptions: ["-1"]
    });
    const etapa = await build({ field: "Etapa", comparator: "Igual a", value: "Análise" });
    expect(etapa.valueOptions).toEqual([String(STEP_B)]);
    expect(etapa.selectedField.options).toEqual([
      { id_field_option: STEP_A, field_id: -4, value: "11", label: "Entrada", order: "0" },
      { id_field_option: STEP_B, field_id: -4, value: "12", label: "Análise", order: "1" }
    ]);
    expect((await build({ field: -1, comparator: "Depois de", value: "01/01/2027" })).selectedField).toEqual({
      id_field: -1,
      name: "-1",
      type: "DATE_PICKER_FIELD",
      title: "Data de Vencimento",
      description: "Data de Vencimento",
      index: -1
    });
  });

  it.each([
    ["valor fora das opções", { field: 1, comparator: "Igual a", value: "Outro" }, /não está nas opções/],
    ["campo de opção sem opções", { field: 6, comparator: "Igual a", value: "1" }, /sem options/],
    ["campo de opção sem opções, em branco", { field: 6, comparator: "Está em branco" }, /sem options/],
    ["comparador de outro tipo", { field: 1, comparator: "Contém", value: "Externo" }, /Comparador "Contém" inválido/],
    ["campo de outro fluxo", { field: 5555, comparator: "Igual a", value: "1" }, /não é do fluxo 100/],
    ["título repetido", { field: "Repetido", comparator: "Igual a", value: "x" }, /mais de um campo/],
    ["tipo que quebra o editor", { field: 10, comparator: "Igual a", value: "x" }, /não serve de origem/],
    ["tipo sem resposta", { field: 13, comparator: "Igual a", value: "x" }, /não serve de origem/],
    ["data de conclusão (-9)", { field: -9, comparator: "Está em branco" }, /Data de Conclusão/],
    ["sem valor", { field: 1, comparator: "Igual a" }, /pede um valor/],
    ["valor em comparador de branco", { field: 1, comparator: "Está em branco", value: "1" }, /não aceita valor/],
    ["dois valores em Igual a", { field: 1, comparator: "Igual a", values: ["1", "Externo"] }, /um valor só/],
    ["número com vírgula", { field: 3, comparator: "Igual a", value: "1.500,00" }, /ponto decimal/]
  ])("recusa: %s", async (_name, input, message) => {
    await expect(build(input)).rejects.toThrow(message);
  });

  it("vínculo ausente em campo de lista dinâmica também trava o editor: recusa", async () => {
    const broken = readFlowStructure({
      ...flow(),
      form_init: { id_form: 200, fields: [{ ...PEDIDO, flow_id: null }] }
    })!;
    await expect(
      buildConditionItem(broken, { field: 9, comparator: "Igual a", value: 800 }, 0, lookups)
    ).rejects.toThrow(/sem flow_id/);
  });

  it("todo tipo do mapa tem comparador e componente", () => {
    for (const [type, rule] of Object.entries(CONDITION_SOURCE_TYPES)) {
      expect(rule.comparators.length, type).toBeGreaterThan(0);
      expect(["TEXT_FILTER", "OPTION_FILTER", "DATE_FILTER"], type).toContain(rule.component);
    }
  });
});

describe("nome da regra, igual ao da tela", () => {
  const item = (title: string, selectedComparator = "Igual a"): ConditionItem =>
    ({ selectedField: { title }, selectedComparator }) as unknown as ConditionItem;

  it("um, dois, dois com título contido, três e limite", () => {
    expect(buildConditionalName([item("Tipo")])).toBe("Quando o campo [Tipo for igual a] ");
    expect(buildConditionalName([item("Tipo"), item("Valor", "Maior que")])).toBe(
      "Quando o campo [Tipo for igual a]  e  [Valor for maior que] "
    );
    expect(buildConditionalName([item("Tipo"), item("Tipo")])).toBe("Quando o campo [Tipo for igual a] ");
    expect(buildConditionalName([item("A1"), item("B2"), item("C3")])).toBe("Quando o campo [A1 for igual a]  + 2 campos");
    const long = buildConditionalName([item("x".repeat(200))]);
    expect(long).toHaveLength(133);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("o editor da tela abre a regra?", () => {
  const withField = (selectedField: Rec, extra: Rec = {}): Rec => ({ selectedField, valueOptions: ["2"], ...extra });

  it("abre quando options está presente e os valores estão dentro", () => {
    expect(editorIssues(withField(TIPO))).toEqual([]);
    expect(editorIssues(withField(DETALHE, { valueOptions: [] }))).toEqual([]);
    expect(editorIssues(withField(ATIVO, { valueOptions: ["true"] }))).toEqual([]);
    expect(editorIssues(withField(PEDIDO, { valueOptions: ["800"] }))).toEqual([]);
  });

  it("não abre: sem options, valor fora, opção sem order, sem vínculo, tipo sem filtro, sem selectedField", () => {
    expect(editorIssues(withField({ id_field: 1, type: "COMBO_BOX_FIELD" }))[0]).toMatch(/sem options/);
    expect(editorIssues(withField(SEM_OPCOES))[0]).toMatch(/sem options/);
    expect(editorIssues(withField(TIPO, { valueOptions: ["2", "9"] }))[0]).toMatch(/fora de selectedField.options \(9\)/);
    const noOrder = field(1, "COMBO_BOX_FIELD", "Tipo", {
      options: options(1, [["2", "Externo"]]).map(({ order: _order, ...rest }) => rest)
    });
    expect(editorIssues(withField(noOrder))[0]).toMatch(/sem options/);
    expect(editorIssues(withField({ id_field: 8, type: "COMBO_BOX_REGISTER_FIELD" }))[0]).toMatch(/sem register_id/);
    expect(editorIssues(withField({ id_field: 10, type: "COLOR_PICKER_FIELD" }))[0]).toMatch(/não tem filtro/);
    expect(editorIssues({})).toEqual(["sem selectedField"]);
    expect(editorIssues(null)).toEqual(["sem selectedField"]);
  });
});

describe("CLI flow-build conditional", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  let calls: Array<{ method: string; path: string; query: Record<string, string>; body?: Rec }>;
  let rules: Rec[];
  let stepRules: Rec[];
  /** Deixa o teste simular gravação que não pegou. */
  let persist: (body: Rec) => Rec | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cange-conditional-"));
    process.env.CANGE_ACCESS_TOKEN = "token-de-teste";
    delete process.env.CANGE_FORCE_DRY_RUN;
    stdout = [];
    stderr = [];
    calls = [];
    rules = [];
    stepRules = [];
    persist = (body) => ({ ...body });
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const query = Object.fromEntries(url.searchParams);
      const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : undefined;
      calls.push({ method, path: url.pathname, query, ...(body ? { body } : {}) });
      const json = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      const route = `${method} ${url.pathname}`;
      if (route === "GET /flow") return json(flow(rules, query.removeStepsCondicionals === "false" ? stepRules : []));
      if (route === "GET /conditional/by-field") return json(rules.filter((r) => String(r.field_id) === query.field_id));
      if (route === "GET /conditional/by-step") {
        return json(
          stepRules.filter(
            (r) => String(r.flow_step_id) === query.flow_step_id && String(r.flow_step_parent_id) === query.flow_step_parent_id
          )
        );
      }
      if (route === "POST /conditional") {
        const stored = persist(body!);
        const list = body!.type === "step" ? stepRules : rules;
        if (stored && body!.id_conditional !== undefined) {
          const at = list.findIndex((r) => r.id_conditional === body!.id_conditional);
          if (at >= 0) list[at] = { ...list[at], action: stored.action, conditions_items: stored.conditions_items, name: stored.name };
          return json(stored);
        }
        const row = { id_conditional: 555, index: null, ...(stored ?? body!) };
        if (stored) list.push(row);
        return json(row);
      }
      return json({ message: `rota inesperada ${route}` }, 404);
    });
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (...args: string[]): Promise<void> => {
    await createProgram().parseAsync(["node", "cange", "--output", "json", "flow-build", "conditional", ...args]);
  };
  const out = (): Rec => JSON.parse(stdout.join("")) as Rec;
  const posts = () => calls.filter((call) => call.method !== "GET");
  const when = (value: Rec): string[] => ["--when", JSON.stringify(value)];
  const TIPO_EXTERNO = when({ field: "Tipo", comparator: "Igual a", value: "Externo" });

  it("create grava o body da tela e relê para conferir", async () => {
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(process.exitCode ?? 0).toBe(0);
    const body = posts()[0]!.body!;
    expect(Object.keys(body).sort()).toEqual(["action", "conditions_items", "field_id", "flow_id", "key", "name", "type"]);
    expect(body).toMatchObject({
      flow_id: FLOW_ID,
      type: "field",
      action: "1",
      key: 2,
      field_id: 2,
      name: "Quando o campo [Tipo for igual a] "
    });
    expect(typeof body.conditions_items).toBe("string");
    const [item] = JSON.parse(body.conditions_items as string) as Rec[];
    const [screen] = JSON.parse(screenRule(1, 2, TIPO).conditions_items as string) as Rec[];
    expect(item).toEqual(screen);
    expect(Object.keys(item!)).toEqual(Object.keys(screen!));
    expect(out()).toMatchObject({ idConditional: 555, verified: true, actionLabel: "Exibir campo" });
  });

  it("create com duas condições e ação esconder, por --payload", async () => {
    const path = join(dir, "regra.json");
    await writeFile(
      path,
      JSON.stringify({
        action: "esconder",
        conditions: [
          { field: 1, comparator: "É uma das", values: ["Interno", "Externo"] },
          { field: "Valor", comparator: "Maior que", value: 1000 }
        ]
      })
    );
    await run("create", "--id-flow", "100", "--id-field", "2", "--payload", path);
    const body = posts()[0]!.body!;
    expect(body.action).toBe("2");
    expect((JSON.parse(body.conditions_items as string) as Rec[]).map((i) => [i.index, i.value, i.valueOptions])).toEqual([
      [0, "", ["1", "2"]],
      [1, "1000", []]
    ]);
  });

  it("--dry-run lê e valida, mostra o body e não grava", async () => {
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO, "--dry-run");
    expect(posts()).toEqual([]);
    expect(out()).toMatchObject({ dryRun: true, executed: false, payload: { request: "POST /conditional", body: { field_id: 2 } } });
  });

  it("CANGE_FORCE_DRY_RUN não grava mesmo sem --dry-run", async () => {
    process.env.CANGE_FORCE_DRY_RUN = "1";
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(posts()).toEqual([]);
    expect(out()).toMatchObject({ dryRun: true, executed: false });
  });

  it.each([
    ["valor fora das opções", ["--id-field", "2", "--action", "exibir", ...when({ field: 1, comparator: "Igual a", value: "X" })]],
    ["campo sem opções", ["--id-field", "2", "--action", "exibir", ...when({ field: 6, comparator: "Igual a", value: "1" })]],
    ["comparador inválido", ["--id-field", "2", "--action", "exibir", ...when({ field: 1, comparator: "Maior que", value: "1" })]],
    ["origem fora do fluxo", ["--id-field", "2", "--action", "exibir", ...when({ field: 999, comparator: "Igual a", value: "1" })]],
    ["alvo fora do fluxo", ["--id-field", "999", "--action", "exibir", ...TIPO_EXTERNO]],
    ["segunda condição ruim", ["--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO, ...when({ field: 1, comparator: "Igual a", value: "X" })]],
    ["ação de etapa em campo", ["--id-field", "2", "--action", "permitir", ...TIPO_EXTERNO]],
    ["sem ação", ["--id-field", "2", ...TIPO_EXTERNO]],
    ["sem condição", ["--id-field", "2", "--action", "exibir"]],
    ["sem alvo", ["--action", "exibir", ...TIPO_EXTERNO]],
    ["campo e etapa juntos", ["--id-field", "2", "--id-step", "11", "--id-step-from", "12", "--action", "exibir", ...TIPO_EXTERNO]],
    ["etapa sem origem", ["--id-step", "11", "--action", "permitir", ...TIPO_EXTERNO]],
    ["etapa fora do fluxo", ["--id-step", "77", "--id-step-from", "11", "--action", "permitir", ...TIPO_EXTERNO]],
    ["mesma etapa", ["--id-step", "11", "--id-step-from", "11", "--action", "permitir", ...TIPO_EXTERNO]],
    ["--when que não é JSON", ["--id-field", "2", "--action", "exibir", "--when", "Tipo=Externo"]],
    ["chave montada à mão", ["--id-field", "2", "--action", "exibir", ...when({ field: 1, comparator: "Igual a", value: "1", selectedField: {} })]]
  ])("create recusa com exit 2 e não grava: %s", async (_name, args) => {
    await run("create", "--id-flow", "100", ...args);
    expect(process.exitCode).toBe(2);
    expect(posts()).toEqual([]);
  });

  it("etapa: destino em flow_step_id, origem em flow_step_parent_id, como a tela", async () => {
    await run(
      "create", "--id-flow", "100", "--id-step", String(STEP_B), "--id-step-from", String(STEP_A),
      "--action", "bloquear", ...TIPO_EXTERNO
    );
    const body = posts()[0]!.body!;
    expect(Object.keys(body).sort()).toEqual([
      "action", "conditions_items", "flow_id", "flow_step_id", "flow_step_parent_id", "key", "name", "type"
    ]);
    expect(body).toMatchObject({ type: "step", action: "2", key: STEP_B, flow_step_id: STEP_B, flow_step_parent_id: STEP_A });
    expect(out()).toMatchObject({ verified: true, actionLabel: "Não permitir mover" });
  });

  it("update por id, no lugar: só a ação muda e as condições ficam", async () => {
    rules = [screenRule(321, 2, TIPO)];
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "esconder");
    const body = posts()[0]!.body!;
    expect(body).toMatchObject({ id_conditional: 321, action: "2", field_id: 2, key: 2 });
    expect(JSON.parse(body.conditions_items as string)).toEqual(JSON.parse(screenRule(1, 2, TIPO).conditions_items as string));
    expect(rules).toHaveLength(1);
    expect(out()).toMatchObject({ idConditional: 321, verified: true });
  });

  it("update --rehydrate conserta a regra que o editor não abre, sem recriar", async () => {
    rules = [{ ...LEAN_RULE }];
    await run("list", "--id-flow", "100");
    expect(out()).toMatchObject({ total: 1, notOpenable: 1, conditionals: [{ idConditional: 900, opensInEditor: false }] });

    stdout = [];
    await run("update", "--id-flow", "100", "--id-conditional", "900", "--rehydrate");
    expect(posts()[0]!.body).toMatchObject({ id_conditional: 900, action: "1" });

    stdout = [];
    await run("list", "--id-flow", "100");
    expect(out()).toMatchObject({ total: 1, notOpenable: 0, conditionals: [{ idConditional: 900, opensInEditor: true }] });
  });

  it("update --when troca todas as condições", async () => {
    rules = [screenRule(321, 2, TIPO)];
    await run("update", "--id-flow", "100", "--id-conditional", "321", ...when({ field: "Ativo", comparator: "Igual a", value: true }));
    const items = JSON.parse(posts()[0]!.body!.conditions_items as string) as Rec[];
    expect(items.map((item) => item.valueOptions)).toEqual([["true"]]);
    expect(posts()[0]!.body!.action).toBe("1");
  });

  it("update de etapa mantém o par de etapas", async () => {
    stepRules = [
      screenRule(444, 2, TIPO, { type: "step", field_id: null, key: STEP_B, flow_step_id: STEP_B, flow_step_parent_id: STEP_A })
    ];
    await run("update", "--id-flow", "100", "--id-conditional", "444", "--action", "bloquear");
    expect(posts()[0]!.body).toMatchObject({
      id_conditional: 444, type: "step", action: "2", flow_step_id: STEP_B, flow_step_parent_id: STEP_A
    });
    expect(posts()[0]!.body).not.toHaveProperty("field_id");
  });

  it.each([
    ["condicional que não é do fluxo", ["--id-conditional", "9999", "--action", "esconder"]],
    ["nada para alterar", ["--id-conditional", "321"]],
    ["rehydrate com condições novas", ["--id-conditional", "321", "--rehydrate", ...TIPO_EXTERNO]]
  ])("update recusa com exit 2 e não grava: %s", async (_name, args) => {
    rules = [screenRule(321, 2, TIPO)];
    await run("update", "--id-flow", "100", ...args);
    expect(process.exitCode).toBe(2);
    expect(posts()).toEqual([]);
  });

  it("update recusa valor antigo que saiu das opções e regra ilegível", async () => {
    const gone = JSON.parse(screenRule(1, 2, TIPO).conditions_items as string) as Rec[];
    gone[0]!.valueOptions = ["9"];
    rules = [screenRule(321, 2, TIPO, { conditions_items: JSON.stringify(gone) }), screenRule(322, 2, TIPO, { conditions_items: "{" })];
    for (const id of ["321", "322"]) {
      await run("update", "--id-flow", "100", "--id-conditional", id, "--rehydrate");
      expect(process.exitCode).toBe(2);
    }
    expect(posts()).toEqual([]);
  });

  it("gravação que não pegou (o back responde 200 no update sem achar a linha): exit 4", async () => {
    rules = [screenRule(321, 2, TIPO)];
    persist = () => undefined;
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "esconder");
    expect(process.exitCode).toBe(4);
    expect(stderr.join("")).toMatch(/releitura não bate/);
  });

  it("releitura aceita as chaves em outra ordem (coluna JSON do MySQL)", async () => {
    persist = (body) => ({
      ...body,
      conditions_items: JSON.stringify(
        (JSON.parse(body.conditions_items as string) as Rec[]).map((item) => Object.fromEntries(Object.entries(item).reverse()))
      )
    });
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(out()).toMatchObject({ verified: true });
  });

  it("list por campo usa by-field, por etapa usa by-step, por fluxo traz os dois tipos; nada grava", async () => {
    rules = [screenRule(321, 2, TIPO)];
    stepRules = [
      screenRule(444, 2, TIPO, { type: "step", field_id: null, key: STEP_B, flow_step_id: STEP_B, flow_step_parent_id: STEP_A })
    ];
    await run("list", "--id-flow", "100", "--id-field", "2");
    expect(calls.some((call) => call.path === "/conditional/by-field" && call.query.field_id === "2")).toBe(true);
    expect(out()).toMatchObject({
      total: 1,
      conditionals: [
        {
          idConditional: 321,
          target: { idField: 2, title: "Detalhe" },
          actionLabel: "Exibir campo",
          opensInEditor: true,
          conditions: [{ field: { id: 1, title: "Tipo" }, comparator: "Igual a", values: [{ code: "2", label: "Externo" }] }]
        }
      ]
    });

    stdout = [];
    await run("list", "--id-flow", "100", "--id-step", String(STEP_B), "--id-step-from", String(STEP_A));
    expect(calls.some((call) => call.path === "/conditional/by-step")).toBe(true);
    expect(out()).toMatchObject({ total: 1, conditionals: [{ idConditional: 444, type: "step", target: { idStep: STEP_B, idStepFrom: STEP_A, title: "Análise" } }] });

    stdout = [];
    await run("list", "--id-flow", "100");
    expect((out().conditionals as Rec[]).map((rule) => rule.idConditional)).toEqual([321, 444]);
    expect(posts()).toEqual([]);
  });

  it("list não cai com conditions_items quebrado", async () => {
    rules = [screenRule(1, 2, TIPO, { conditions_items: "{" }), screenRule(2, 2, TIPO, { conditions_items: "[]" })];
    await run("list", "--id-flow", "100");
    expect(process.exitCode ?? 0).toBe(0);
    expect(out()).toMatchObject({ total: 2, notOpenable: 2 });
  });

  it("manifest: create e update marcados como mutação, list não", () => {
    const command = createProgram().commands.find((c) => c.name() === "flow-build")!.commands.find((c) => c.name() === "conditional")!;
    const meta = (name: string) => getCommandMeta(command.commands.find((c) => c.name() === name)!);
    expect(meta("create")?.mutates).toBe(true);
    expect(meta("update")?.mutates).toBe(true);
    expect(meta("list")?.mutates).toBeUndefined();
  });
});
