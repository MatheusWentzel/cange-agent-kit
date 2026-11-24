import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { createCangeAgentKit } from "../src/index.js";
import {
  CONDITION_SOURCE_TYPES,
  buildConditionItem,
  itemExecution,
  readFlowStructure,
  type ConditionalKind,
  type ConditionLookups
} from "../src/utils/conditionalBuilder.js";
import { inspectExecution } from "../src/utils/conditionalExecution.js";
import { FakeConditionalApi } from "./fixtures/conditional-api.js";
import { DETALHE, PRAZO, STEP_A, STEP_B, TIPO, flow, screenRule, threeConditionRule } from "./fixtures/conditional-flow.js";

type Rec = Record<string, unknown>;

const structure = readFlowStructure(flow())!;
const lookups: ConditionLookups = {
  usersByForm: async () => [{ id: 41, name: "Ana Teste" }],
  registerOfEntry: async () => 70,
  flowOfCard: async () => 80
};
const build = (kind: ConditionalKind, input: Parameters<typeof buildConditionItem>[1]) =>
  buildConditionItem(structure, input, 0, lookups, { kind });

const TEXT = ["Contém", "Não contém", "Igual a", "Não é igual a", "Está em branco", "Não está em branco"];
const OPTION = ["Igual a", "Não é igual a", "É uma das", "Não é uma das", "Está em branco", "Não está em branco"];
const NUMBER = ["Igual a", "Menor que", "Maior que", "Igual a ou maior que", "Igual a ou menor que", "Não é igual a", "Está em branco", "Não está em branco"];
const DATE = ["Igual a", "Antes de", "Depois de", "Igual a ou depois", "Igual a ou antes", "Não é igual a", "Está em branco", "Não está em branco"];

describe("tabela da tela (componente e comparadores por tipo)", () => {
  it("é exatamente esta", () => {
    expect(CONDITION_SOURCE_TYPES).toEqual({
      TEXT_SHORT_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      TEXT_LONG_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      MAIL_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      PHONE_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      DOC_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      LINK_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      ID_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      INPUT_RICH_TEXT_FIELD: { component: "TEXT_FILTER", comparators: TEXT },
      NUMBER_FIELD: { component: "TEXT_FILTER", comparators: NUMBER },
      CURRENCY_FIELD: { component: "TEXT_FILTER", comparators: NUMBER },
      FORMULA_FIELD: { component: "TEXT_FILTER", comparators: NUMBER },
      DATE_PICKER_FIELD: { component: "DATE_FILTER", comparators: DATE },
      DUE_DATE_FIELD: { component: "DATE_FILTER", comparators: DATE },
      COMBO_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      RADIO_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      CHECK_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      CHECK_BOX_ONE_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      INPUT_LIST_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      SWITCH_FIELD: { component: "OPTION_FILTER", comparators: ["Igual a"] },
      COMBO_BOX_USER_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      REQUESTER_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      COMBO_BOX_REGISTER_FIELD: { component: "OPTION_FILTER", comparators: OPTION },
      COMBO_BOX_FLOW_FIELD: { component: "OPTION_FILTER", comparators: OPTION }
    });
  });
});

describe("regra que a tela executa errado é recusada", () => {
  const D = "10/06/2026";
  it.each<[ConditionalKind, Parameters<typeof buildConditionItem>[1], RegExp]>([
    ["step", { field: 2, comparator: "Não é igual a", value: "x" }, /invertido.*"Igual a" com a ação inversa \(permitir/],
    ["step", { field: 20, comparator: "Não é igual a", value: "x" }, /invertido/],
    ["step", { field: 18, comparator: "Não é igual a", value: "x" }, /invertido/],
    ["step", { field: 16, comparator: "Não é igual a", value: "0.5" }, /invertido/],
    ["step", { field: 16, comparator: "Igual a", value: "50%" }, /ponto decimal.*50% é 0\.5/],
    ["step", { field: 16, comparator: "Maior que", value: "0,4" }, /ponto decimal/],
    ["step", { field: 16, comparator: "Igual a", value: "0.50" }, /compara texto.*Use "0\.5"/],
    ["field", { field: -1, comparator: "Igual a", value: D }, /nunca casa.*campo de data/],
    ["field", { field: -1, comparator: "Antes de", value: D }, /nunca casa/],
    ["field", { field: -2, comparator: "Depois de", value: D }, /nunca casa/],
    ["step", { field: -1, comparator: "Igual a ou depois", value: D }, /nunca casa/],
    ["step", { field: -2, comparator: "Igual a ou antes", value: D }, /nunca casa/],
    ["field", { field: -1, comparator: "Não é igual a", value: D }, /ignora o valor/],
    ["step", { field: -2, comparator: "Não é igual a", value: D }, /ignora o valor/],
    ["field", { field: -1, comparator: "Está em branco" }, /nunca casa.*"Não está em branco" com a ação inversa/],
    ["step", { field: -2, comparator: "Está em branco" }, /nunca casa/],
    ["field", { field: 4, comparator: "Não é igual a", value: D }, /sempre casa.*"Igual a" com a ação inversa \(exibir/],
    ["step", { field: 19, comparator: "Não é igual a", value: D }, /sempre casa/],
    ["field", { field: 4, comparator: "Não está em branco" }, /data vazia.*"Está em branco" com a ação inversa/],
    ["field", { field: 18, comparator: "Igual a", value: "texto" }, /HTML.*nunca casa.*"Contém"/],
    ["field", { field: 18, comparator: "Não é igual a", value: "texto" }, /HTML.*sempre casa.*"Não contém"/]
  ])("%s %j", async (kind, input, message) => {
    await expect(build(kind, input)).rejects.toThrow(message);
  });

  it.each<[ConditionalKind, Parameters<typeof buildConditionItem>[1]]>([
    ["field", { field: 2, comparator: "Não é igual a", value: "x" }],
    ["step", { field: 2, comparator: "Igual a", value: "x" }],
    ["step", { field: 2, comparator: "Não contém", value: "x" }],
    ["step", { field: 3, comparator: "Não é igual a", value: "10" }],
    ["field", { field: 16, comparator: "Igual a", value: "50%" }],
    ["field", { field: 16, comparator: "Não é igual a", value: "0,5" }],
    ["step", { field: 16, comparator: "Maior que", value: "0.50" }],
    ["field", { field: -1, comparator: "Não está em branco" }],
    ["step", { field: -2, comparator: "Não está em branco" }],
    ["field", { field: 4, comparator: "Está em branco" }],
    ["step", { field: 4, comparator: "Não está em branco" }],
    ["step", { field: 4, comparator: "Antes de", value: D }],
    ["field", { field: 1, comparator: "Não é uma das", values: ["1", "Externo"] }],
    ["step", { field: 1, comparator: "É uma das", values: ["1", "Externo"] }],
    ["step", { field: -3, comparator: "É uma das", values: ["-1"] }],
    ["step", { field: -4, comparator: "Não é igual a", value: "Análise" }],
    ["step", { field: 7, comparator: "Igual a", value: "41" }]
  ])("passa sem aviso: %s %j", async (kind, input) => {
    expect(itemExecution(kind, await build(kind, input))).toEqual({ issues: [], warnings: [] });
  });

  it.each<[ConditionalKind, Parameters<typeof buildConditionItem>[1], RegExp]>([
    ["field", { field: 4, comparator: "Igual a", value: D }, /data vazia/],
    ["field", { field: 17, comparator: "Não é igual a", value: "Um" }, /mais de um item/],
    ["step", { field: 17, comparator: "Igual a", value: "Um" }, /mais de um item/],
    ["step", { field: 17, comparator: "É uma das", values: ["Um"] }, /nunca casa/],
    ["step", { field: 8, comparator: "Não é uma das", values: ["700"] }, /sempre casa/],
    ["field", { field: 9, comparator: "É uma das", values: ["800"] }, /mais de um item/],
    ["step", { field: 7, comparator: "É uma das", values: ["41"] }, /nunca casa/],
    ["step", { field: 7, comparator: "Não é igual a", value: "41" }, /sempre casa/],
    ["step", { field: 16, comparator: "Igual a", value: "0.5" }, /compara texto/],
    ["field", { field: 18, comparator: "Igual a", value: "<p>x</p>" }, /HTML inteiro/]
  ])("passa com aviso: %s %j", async (kind, input, message) => {
    const execution = itemExecution(kind, await build(kind, input));
    expect(execution.issues).toEqual([]);
    expect(execution.warnings.join(" ")).toMatch(message);
  });

  it("só em regra já gravada: data de conclusão, atalho de data, número ilegível e condição sem valor", () => {
    const check = (extra: Partial<Parameters<typeof inspectExecution>[1]>) =>
      inspectExecution("field", { idField: 4, type: "DATE_PICKER_FIELD", title: "Prazo", comparator: "Igual a", value: "", valueOptions: [], ...extra }).issues.join(" ");
    expect(check({ idField: -9, valueOptions: [D] })).toMatch(/Data de Conclusão/);
    expect(check({ valueOptions: ["-1"] })).toMatch(/atalho relativo/);
    expect(check({ type: "NUMBER_FIELD", value: "1.500,00" })).toMatch(/não é lido como número/);
    expect(check({})).toMatch(/a pula/);
  });
});

describe("CLI: update, releitura e buscas", () => {
  const envBackup = { ...process.env };
  let api: FakeConditionalApi;
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cange-conditional-exec-"));
    process.env.CANGE_ACCESS_TOKEN = "token-de-teste";
    delete process.env.CANGE_FORCE_DRY_RUN;
    process.exitCode = undefined;
    api = new FakeConditionalApi();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch as typeof fetch);
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (...args: string[]): Promise<void> => {
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = undefined;
    await createProgram().parseAsync(["node", "cange", "--output", "json", "flow-build", "conditional", ...args]);
  };
  const out = (): Rec => JSON.parse(stdout.join("")) as Rec;
  const when = (value: Rec): string[] => ["--when", JSON.stringify(value)];
  const items = (raw: unknown): Rec[] => JSON.parse(raw as string) as Rec[];
  const UPDATE = ["update", "--id-flow", "100", "--id-conditional", "321"];
  const ORIGINAL = items(threeConditionRule(321, 2).conditions_items);
  const TIPO_EXTERNO = when({ field: "Tipo", comparator: "Igual a", value: "Externo" });

  it("--rehydrate manda o corpo inteiro: as três condições, valores, ação 2, key e id", async () => {
    api.rules = [threeConditionRule(321, 2)];
    await run(...UPDATE, "--rehydrate");
    expect(process.exitCode ?? 0).toBe(0);
    expect(api.posts()).toHaveLength(1);
    const { conditions_items, ...rest } = api.posts()[0]!.body!;
    expect(rest).toEqual({
      id_conditional: 321,
      flow_id: 100,
      type: "field",
      action: "2",
      key: 777,
      field_id: 2,
      name: "Quando o campo [Detalhe for contém]  + 2 campos"
    });
    expect(items(conditions_items)).toEqual(ORIGINAL);
    expect(items(conditions_items).map((item) => [item.value, item.valueOptions])).toEqual([
      ["abc def", []],
      ["", ["31/12/2026"]],
      ["", ["1", "2"]]
    ]);
    expect(api.rules).toHaveLength(1);
    expect(out()).toMatchObject({ idConditional: 321, verified: true, actionLabel: "Esconder campo" });
  });

  it("--action troca só a ação: as três condições ficam", async () => {
    api.rules = [threeConditionRule(321, 2)];
    await run(...UPDATE, "--action", "exibir");
    const body = api.posts()[0]!.body!;
    expect(body.action).toBe("1");
    expect(body.key).toBe(777);
    expect(items(body.conditions_items)).toEqual(ORIGINAL);
  });

  it("--when sem --action mantém a ação 2 (e não volta para 1) e troca as condições todas", async () => {
    api.rules = [threeConditionRule(321, 2)];
    await run(...UPDATE, ...TIPO_EXTERNO, ...when({ field: "Detalhe", comparator: "Contém", value: "x" }));
    const body = api.posts()[0]!.body!;
    expect(body.action).toBe("2");
    expect(items(body.conditions_items).map((item) => [item.index, item.value, item.valueOptions])).toEqual([
      [0, "", ["2"]],
      [1, "x", []]
    ]);
  });

  it("--payload com só a ação ou só as condições", async () => {
    const path = join(dir, "regra.json");
    api.rules = [threeConditionRule(321, 2)];
    await writeFile(path, JSON.stringify({ action: "exibir" }));
    await run(...UPDATE, "--payload", path);
    expect(api.posts()[0]!.body).toMatchObject({ action: "1" });
    expect(items(api.posts()[0]!.body!.conditions_items)).toEqual(ORIGINAL);
  });

  it("--dry-run e CANGE_FORCE_DRY_RUN não gravam e mostram o corpo com o id", async () => {
    api.rules = [threeConditionRule(321, 2)];
    await run(...UPDATE, "--action", "exibir", "--dry-run");
    expect(out()).toMatchObject({ dryRun: true, executed: false, payload: { body: { id_conditional: 321, action: "1", key: 777 } } });
    process.env.CANGE_FORCE_DRY_RUN = "1";
    await run(...UPDATE, "--rehydrate");
    expect(out()).toMatchObject({ dryRun: true, executed: false });
    expect(api.posts()).toEqual([]);
    expect(api.rules[0]).toEqual(threeConditionRule(321, 2));
  });

  it("etapa: o update manda a key gravada e o par de etapas", async () => {
    api.stepRules = [
      threeConditionRule(321, 2, { type: "step", field_id: null, flow_step_id: STEP_B, flow_step_parent_id: STEP_A })
    ];
    await run(...UPDATE, "--rehydrate");
    expect(api.posts()[0]!.body).toMatchObject({ type: "step", action: "2", key: 777, flow_step_id: STEP_B, flow_step_parent_id: STEP_A });
    expect(items(api.posts()[0]!.body!.conditions_items)).toEqual(ORIGINAL);
    expect(out()).toMatchObject({ verified: true, actionLabel: "Não permitir mover" });
  });

  it.each([
    ["só a 1ª condição guardada", (body: Rec) => ({ ...body, conditions_items: JSON.stringify(items(body.conditions_items).slice(0, 1)) })],
    ["valor de texto perdido", (body: Rec) => ({ ...body, conditions_items: JSON.stringify(items(body.conditions_items).map((i) => ({ ...i, value: "" }))) })],
    ["ação trocada", (body: Rec) => ({ ...body, action: "1" })],
    ["conditions_items ilegível", (body: Rec) => ({ ...body, conditions_items: "{" })]
  ])("releitura acusa: %s", async (_name, persist) => {
    api.rules = [threeConditionRule(321, 2)];
    api.persist = persist;
    await run(...UPDATE, "--rehydrate");
    expect(process.exitCode).toBe(4);
    expect(stderr.join("")).toMatch(/releitura não bate/);
  });

  it("releitura que falha não vira erro: a gravação valeu, verified false", async () => {
    api.failures["GET /conditional/by-field"] = 422;
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out()).toMatchObject({ idConditional: 555, verified: false });
    expect(String(out().note)).toMatch(/conditional list/);
  });

  it("queda de rede no POST: exit 4, uma tentativa só e a dica de conferir antes de repetir", async () => {
    api.failures["POST /conditional"] = "network";
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(process.exitCode).toBe(4);
    expect(api.posts()).toHaveLength(1);
    const error = JSON.parse(stderr.join("")) as { hint?: string };
    expect(JSON.stringify(error)).toMatch(/PODE ter sido gravada/);
    expect(JSON.stringify(error)).toMatch(/conditional list --id-flow 100/);
  });

  it("recusa do back no POST (4xx) não ganha a dica de rede", async () => {
    api.failures["POST /conditional"] = 422;
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(process.exitCode).toBe(4);
    expect(stderr.join("")).not.toMatch(/PODE ter sido gravada/);
  });

  it.each([
    ["sem id", undefined],
    ["id negativo", -5]
  ])("create que responde %s: exit 4", async (_name, newId) => {
    api.newId = newId;
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...TIPO_EXTERNO);
    expect(process.exitCode).toBe(4);
    expect(stderr.join("")).toMatch(/sem id_conditional/);
  });

  it.each([
    ["fluxo 0", ["update", "--id-flow=0", "--id-conditional=321", "--rehydrate"]],
    ["fluxo negativo", ["update", "--id-flow=-100", "--id-conditional=321", "--rehydrate"]],
    ["condicional 0", ["update", "--id-flow=100", "--id-conditional=0", "--rehydrate"]],
    ["condicional negativa", ["update", "--id-flow=100", "--id-conditional=-5", "--rehydrate"]],
    ["campo alvo negativo (padrão não é alvo)", ["create", "--id-flow=100", "--id-field=-4", "--action", "exibir", ...TIPO_EXTERNO]],
    ["etapa negativa", ["create", "--id-flow=100", "--id-step=-4", "--id-step-from=11", "--action", "permitir", ...TIPO_EXTERNO]]
  ])("id inválido recusa com exit 2 sem gravar: %s", async (_name, args) => {
    // Linhas com id 0 e negativo na base: quem aceitar o id as encontra e grava.
    api.rules = [threeConditionRule(321, 2), threeConditionRule(0, 2), threeConditionRule(-5, 2)];
    await run(...args);
    expect(process.exitCode).toBe(2);
    expect(api.posts()).toEqual([]);
  });

  it("contrato: id 0, negativo ou quebrado é recusado antes de qualquer leitura", async () => {
    const { contracts } = createCangeAgentKit({ skipEnvLoad: true });
    for (const bad of [0, -5, "-5", "0", 1.5, "abc"]) {
      const positive = /inteiro positivo/;
      await expect(contracts.listFlowBuildConditionals({ idFlow: bad }), `fluxo ${bad}`).rejects.toThrow(positive);
      await expect(contracts.updateFlowBuildConditional({ idFlow: bad, idConditional: 321 }), `fluxo ${bad}`).rejects.toThrow(positive);
      await expect(contracts.updateFlowBuildConditional({ idFlow: 100, idConditional: bad }), `condicional ${bad}`).rejects.toThrow(positive);
      await expect(
        contracts.createFlowBuildConditional({ idFlow: 100, target: { type: "field", idField: bad }, action: "exibir", conditions: [{ field: 1, comparator: "Igual a", value: "1" }] }),
        `alvo ${bad}`
      ).rejects.toThrow(/Alvo da condicional inválido/);
    }
    expect(api.calls).toEqual([]);
  });

  it.each([
    ["exibir", "1", "field"],
    ["mostrar", "1", "field"],
    ["1", "1", "field"],
    ["esconder", "2", "field"],
    ["ocultar", "2", "field"],
    ["2", "2", "field"],
    ["permitir", "1", "step"],
    ["1", "1", "step"],
    ["bloquear", "2", "step"],
    ["não permitir", "2", "step"],
    ["2", "2", "step"]
  ])("ação %s grava %s em %s", async (action, code, kind) => {
    const target = kind === "field" ? ["--id-field", "2"] : ["--id-step", String(STEP_B), "--id-step-from", String(STEP_A)];
    await run("create", "--id-flow", "100", ...target, "--action", action, ...TIPO_EXTERNO);
    expect(api.posts()[0]!.body!.action).toBe(code);
  });

  it("usuário: lê a lista do formulário do campo e usa id_user, nome e e-mail", async () => {
    for (const value of ["Ana Teste", "ana@example.com", 41]) {
      api.calls = [];
      await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field: 7, comparator: "Igual a", value }));
      expect(api.calls.filter((call) => call.path === "/user/by-flow").map((call) => call.query)).toEqual([{ form_id: "200" }]);
      expect(items(api.posts()[0]!.body!.conditions_items)[0]!.valueOptions).toEqual(["41"]);
    }
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field: 7, comparator: "Igual a", value: 9041 }));
    expect(process.exitCode).toBe(2);
  });

  it("usuário: dois valores numa condição leem a lista uma vez só", async () => {
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field: 7, comparator: "É uma das", values: ["Ana Teste", "Bia Teste"] }));
    expect(api.calls.filter((call) => call.path === "/user/by-flow")).toHaveLength(1);
    expect(items(api.posts()[0]!.body!.conditions_items)[0]!.valueOptions).toEqual(["41", "42"]);
  });

  it("cadastro: confere register_id da entrada; cartão: confere flow_id", async () => {
    const create = (field: number, value: number) =>
      run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field, comparator: "Igual a", value }));
    await create(8, 700);
    expect(api.calls.find((call) => call.path === "/form/answer")?.query).toEqual({ id_form_answer: "700" });
    await create(9, 800);
    expect(api.calls.find((call) => call.path === "/card/locate")?.query).toEqual({ id_card: "800" });
    expect(api.posts()).toHaveLength(2);
    for (const [field, value] of [[8, 701], [8, 999], [9, 801], [9, 999]] as const) {
      await create(field, value);
      expect(process.exitCode, `${field}/${value}`).toBe(2);
    }
    expect(api.posts()).toHaveLength(2);
  });

  it("busca que falha (5xx) não vira 'valor inválido'", async () => {
    api.failures["GET /form/answer"] = 403;
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field: 8, comparator: "Igual a", value: 700 }));
    expect(process.exitCode).toBe(4);
    expect(api.posts()).toEqual([]);
  });

  it("create recusa com exit 2 a regra que a tela executa errado e diz a saída", async () => {
    await run(
      "create", "--id-flow", "100", "--id-step", String(STEP_B), "--id-step-from", String(STEP_A), "--action", "permitir",
      ...when({ field: "Detalhe", comparator: "Não é igual a", value: "x" })
    );
    expect(process.exitCode).toBe(2);
    expect(api.posts()).toEqual([]);
    expect(stderr.join("")).toMatch(/invertido/);
    expect(stderr.join("")).toMatch(/ação inversa/);
    // A mesma condição em campo funciona.
    await run("create", "--id-flow", "100", "--id-field", "3", "--action", "exibir", ...when({ field: "Detalhe", comparator: "Não é igual a", value: "x" }));
    expect(out()).toMatchObject({ verified: true });
    expect(out()).not.toHaveProperty("executionWarnings");
  });

  it("create com aviso devolve executionWarnings junto do verified", async () => {
    await run("create", "--id-flow", "100", "--id-field", "2", "--action", "exibir", ...when({ field: "Prazo", comparator: "Antes de", value: "31/12/2026" }));
    expect(out()).toMatchObject({ verified: true, executionWarnings: [expect.stringMatching(/data vazia/)] });
  });

  describe("regra já existente que a tela executa errado", () => {
    const wrong = (overrides: Rec = {}) => {
      const [item] = items(screenRule(1, 2, DETALHE).conditions_items);
      return screenRule(321, 2, DETALHE, {
        type: "step", field_id: null, key: STEP_B, flow_step_id: STEP_B, flow_step_parent_id: STEP_A,
        conditions_items: JSON.stringify([
          { ...item, selectedComparator: "Não é igual a", value: "x", valueOptions: [], nameComponent: "TEXT_FILTER" }
        ]),
        ...overrides
      });
    };

    it("list sinaliza e não muda nada; em campo a mesma condição está certa", async () => {
      api.stepRules = [wrong()];
      api.rules = [threeConditionRule(400, 2)];
      const before = JSON.stringify([api.rules, api.stepRules]);
      await run("list", "--id-flow", "100");
      expect(out()).toMatchObject({ total: 2, notOpenable: 0, misexecuted: 1 });
      const [fieldRule, stepRule] = out().conditionals as Rec[];
      expect(stepRule).toMatchObject({ idConditional: 321, opensInEditor: true, runsAsConfigured: false });
      expect(stepRule!.executionIssues).toEqual([expect.stringMatching(/invertido/)]);
      expect(fieldRule).toMatchObject({ idConditional: 400, runsAsConfigured: true });
      expect(fieldRule!.executionWarnings).toEqual([expect.stringMatching(/data vazia/)]);
      expect(JSON.stringify([api.rules, api.stepRules])).toBe(before);
      expect(api.posts()).toEqual([]);
    });

    it("--rehydrate regrava o formato, mantém a lógica e avisa que o erro continua", async () => {
      api.stepRules = [wrong({ conditions_items: JSON.stringify([
        { index: 0, fields: [], comparators: [], selectedField: { id_field: 2, name: "hash2", title: "Detalhe", type: "TEXT_LONG_FIELD" }, selectedComparator: "Não é igual a", value: "x", valueOptions: [], nameComponent: "TEXT_FILTER" }
      ]) })];
      await run(...UPDATE, "--rehydrate");
      expect(process.exitCode ?? 0).toBe(0);
      expect(items(api.posts()[0]!.body!.conditions_items)).toEqual([
        expect.objectContaining({ selectedComparator: "Não é igual a", value: "x", selectedField: DETALHE })
      ]);
      expect(out()).toMatchObject({ verified: true, executionIssues: [expect.stringMatching(/invertido/)] });
    });

    it("trocar só a ação (com ou sem --rehydrate) recusa explicando; com --when novo passa", async () => {
      api.stepRules = [wrong()];
      for (const extra of [[], ["--rehydrate"]]) {
        await run(...UPDATE, "--action", "bloquear", ...extra);
        expect(process.exitCode).toBe(2);
        expect(stderr.join("")).toMatch(/trocar só a ação não dá o efeito esperado/);
        expect(stderr.join("")).toMatch(/--when/);
      }
      expect(api.posts()).toEqual([]);
      await run(...UPDATE, "--action", "bloquear", ...when({ field: 2, comparator: "Igual a", value: "x" }));
      expect(out()).toMatchObject({ verified: true });
      expect(api.posts()).toHaveLength(1);
    });

    it("--when que repete a condição errada recusa", async () => {
      api.stepRules = [wrong()];
      await run(...UPDATE, ...when({ field: 2, comparator: "Não é igual a", value: "y" }));
      expect(process.exitCode).toBe(2);
      expect(api.posts()).toEqual([]);
    });
  });

  it("list ignora id_conditional que não é positivo", async () => {
    api.rules = [screenRule(-7, 2, TIPO)];
    await run("list", "--id-flow", "100");
    expect((out().conditionals as Rec[])[0]).not.toHaveProperty("idConditional");
  });

  it("valor de data sobrevive ao update mesmo em regra só com data", async () => {
    const [item] = items(screenRule(1, 2, PRAZO).conditions_items);
    api.rules = [screenRule(321, 2, PRAZO, { conditions_items: JSON.stringify([{ ...item, selectedComparator: "Está em branco", valueOptions: [], nameComponent: "DATE_FILTER" }]) })];
    await run(...UPDATE, ...when({ field: 4, comparator: "Antes de", value: "2026-12-31" }));
    await run(...UPDATE, "--rehydrate");
    expect(items(api.posts()[1]!.body!.conditions_items)[0]!.valueOptions).toEqual(["31/12/2026"]);
  });
});
