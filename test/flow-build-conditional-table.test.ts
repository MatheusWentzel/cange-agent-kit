import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { itemExecution } from "../src/utils/conditionalBuilder.js";
import { inspectExecution, type ConditionalKind } from "../src/utils/conditionalExecution.js";
import { FakeConditionalApi } from "./fixtures/conditional-api.js";
import { CPF, DETALHE, PERCENTUAL, STEP_A, STEP_B, TIPO, field, screenRule } from "./fixtures/conditional-flow.js";

type Rec = Record<string, unknown>;

/*
 * Veredito por tipo × comparador × alvo, escrito À MÃO a partir do que os avaliadores reais da
 * tela fazem (nada aqui é lido do código do kit). P = passa, A = passa com aviso, R = recusa.
 */
const TEXT = ["Contém", "Não contém", "Igual a", "Não é igual a", "Está em branco", "Não está em branco"];
const NUMBER = ["Igual a", "Menor que", "Maior que", "Igual a ou maior que", "Igual a ou menor que", "Não é igual a", "Está em branco", "Não está em branco"];
const DATE = ["Igual a", "Antes de", "Depois de", "Igual a ou depois", "Igual a ou antes", "Não é igual a", "Está em branco", "Não está em branco"];
const OPTION = ["Igual a", "Não é igual a", "É uma das", "Não é uma das", "Está em branco", "Não está em branco"];

interface Row {
  type: string;
  value: string;
  comparators: string[];
  field: string;
  step: string;
  variation?: string;
  idField?: number;
  /** O valor vai em `valueOptions` (opção e data). */
  option?: true;
}

const ROWS: Row[] = [
  ...["TEXT_SHORT_FIELD", "TEXT_LONG_FIELD", "MAIL_FIELD", "LINK_FIELD"].map((type) => ({ type, value: "abc", comparators: TEXT, field: "PPPPPP", step: "PPPRPP" })),
  { type: "PHONE_FIELD", value: "(11) 900001111", comparators: TEXT, field: "PPPPPP", step: "PPPRPP" },
  { type: "PHONE_FIELD", value: "11900001111", comparators: TEXT, field: "RRRRPP", step: "RRRRPP" },
  { type: "PHONE_FIELD", value: "9000", comparators: TEXT, field: "AAAAPP", step: "AAARPP" },
  { type: "PHONE_FIELD", value: "(11)", comparators: TEXT, field: "PPAAPP", step: "PPARPP" },
  { type: "DOC_FIELD", variation: "1", value: "529.982.247-25", comparators: TEXT, field: "PPPPPP", step: "PPPRPP" },
  { type: "DOC_FIELD", variation: "1", value: "52998224725", comparators: TEXT, field: "RRRRPP", step: "RRRRPP" },
  { type: "DOC_FIELD", variation: "1", value: "123", comparators: TEXT, field: "AAAAPP", step: "AAARPP" },
  { type: "DOC_FIELD", variation: "2", value: "11.222.333/0001-81", comparators: TEXT, field: "PPPPPP", step: "PPPRPP" },
  { type: "DOC_FIELD", variation: "2", value: "11222333000181", comparators: TEXT, field: "RRRRPP", step: "RRRRPP" },
  { type: "DOC_FIELD", variation: "1", value: "11.222.333/0001-81", comparators: TEXT, field: "PPAAPP", step: "PPARPP" },
  { type: "ID_FIELD", value: "55", comparators: TEXT, field: "AAAAAA", step: "AAARAA" },
  { type: "INPUT_RICH_TEXT_FIELD", value: "abc", comparators: TEXT, field: "AARRPP", step: "AARRPP" },
  { type: "INPUT_RICH_TEXT_FIELD", value: "<p>abc</p>", comparators: TEXT, field: "AAAAPP", step: "AAARPP" },
  ...["NUMBER_FIELD", "CURRENCY_FIELD"].flatMap((type) => [
    { type, value: "10", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
    { type, value: "15", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
    { type, value: "0", comparators: NUMBER, field: "APPAAAPP", step: "APPAAAPP" },
    { type, value: "-1", comparators: NUMBER, field: "PPAAPPPP", step: "PPAAPPPP" },
    { type, value: "1.500,00", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" }
  ]),
  { type: "CURRENCY_FIELD", variation: "2", value: "15", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
  { type: "NUMBER_FIELD", variation: "1", value: "15", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "0.1", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "1", comparators: NUMBER, field: "PAPPAPPP", step: "PAPPAPPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "1.5", comparators: NUMBER, field: "AAAAAAPP", step: "AAAAAAPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "10", comparators: NUMBER, field: "AAAAAAPP", step: "AAAAAAPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "10.5", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "-15", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" },
  { type: "NUMBER_FIELD", variation: "2", value: "10%", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" },
  { type: "FORMULA_FIELD", value: "10", comparators: NUMBER, field: "PAPPAPPP", step: "AAPPARPP" },
  { type: "FORMULA_FIELD", value: "0", comparators: NUMBER, field: "APPAAAPP", step: "APPAARPP" },
  { type: "FORMULA_FIELD", value: "0.50", comparators: NUMBER, field: "PAPPAPPP", step: "RAPPARPP" },
  { type: "FORMULA_FIELD", value: "0,5", comparators: NUMBER, field: "PAPPAPPP", step: "RRRRRRPP" },
  { type: "FORMULA_FIELD", value: "50%", comparators: NUMBER, field: "PAPPAPPP", step: "RRRRRRPP" },
  { type: "FORMULA_FIELD", value: "abc", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" },
  { type: "FORMULA_FIELD", variation: "3", value: "0.5", comparators: NUMBER, field: "PAPPAPPP", step: "AAPPARPP" },
  { type: "FORMULA_FIELD", variation: "3", value: "50", comparators: NUMBER, field: "RRRRRRPP", step: "RRRRRRPP" },
  { type: "FORMULA_FIELD", variation: "3", value: "1500%", comparators: NUMBER, field: "PAPPAPPP", step: "RRRRRRPP" },
  ...["DATE_PICKER_FIELD", "DUE_DATE_FIELD"].flatMap((type): Row[] => [
    { type, value: "10/06/2026", comparators: DATE, field: "AAAAARPR", step: "PPPPPRPP", option: true },
    { type, value: "-1", comparators: DATE, field: "RRRRRRPR", step: "RRRRRRPP", option: true }
  ]),
  ...[-1, -2].map((idField): Row => ({ type: "DATE_PICKER_FIELD", idField, value: "10/06/2026", comparators: DATE, field: "RRRRRRRP", step: "RRRRRRRP", option: true })),
  { type: "DATE_PICKER_FIELD", idField: -9, value: "10/06/2026", comparators: DATE, field: "RRRRRRRR", step: "RRRRRRRR", option: true },
  ...["COMBO_BOX_FIELD", "RADIO_BOX_FIELD"].map((type): Row => ({ type, value: "1", comparators: OPTION, field: "PPPPPP", step: "PPPPPP", option: true })),
  { type: "COMBO_BOX_FIELD", idField: -4, value: "11", comparators: OPTION, field: "PPPPPP", step: "PPPPPP", option: true },
  { type: "CHECK_BOX_FIELD", value: "1", comparators: OPTION, field: "PAPAPP", step: "AAAAPP", option: true },
  ...["COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"].map((type): Row => ({ type, value: "1", comparators: OPTION, field: "AAAAPP", step: "AAAAPP", option: true })),
  ...["COMBO_BOX_USER_FIELD", "REQUESTER_FIELD"].map((type): Row => ({ type, value: "1", comparators: OPTION, field: "PPPPPP", step: "PAAAPP", option: true })),
  { type: "COMBO_BOX_USER_FIELD", idField: -3, value: "1", comparators: OPTION, field: "PPPPPP", step: "PPPPPP", option: true },
  { type: "CHECK_BOX_ONE_FIELD", value: "1", comparators: OPTION, field: "RRRRRR", step: "RRRRRR", option: true },
  { type: "INPUT_LIST_FIELD", value: "1", comparators: OPTION, field: "RRRRPP", step: "RRRRPP", option: true },
  { type: "SWITCH_FIELD", value: "true", comparators: ["Igual a"], field: "P", step: "P", option: true }
];

const CASES = ROWS.flatMap((row) =>
  (["field", "step"] as const).flatMap((kind) =>
    row.comparators.map((comparator, index) => ({
      kind,
      type: row.type,
      id: row.idField ?? 1,
      variation: row.variation ?? "",
      comparator,
      value: row.value,
      option: row.option === true,
      expected: row[kind][index]!
    }))
  )
);

function verdict(kind: ConditionalKind, c: (typeof CASES)[number]): string {
  const blank = c.comparator === "Está em branco" || c.comparator === "Não está em branco";
  const result = inspectExecution(kind, {
    idField: c.id,
    type: c.type,
    variation: c.variation,
    title: "Origem",
    comparator: c.comparator,
    value: blank || c.option ? "" : c.value,
    valueOptions: !blank && c.option ? [c.value] : []
  });
  return result.issues.length > 0 ? "R" : result.warnings.length > 0 ? "A" : "P";
}

describe("tabela literal: o que a tela faz com cada condição", () => {
  it("cada linha tem um veredito por comparador", () => {
    for (const row of ROWS) {
      expect(row.field, row.type).toHaveLength(row.comparators.length);
      expect(row.step, row.type).toHaveLength(row.comparators.length);
    }
  });

  it.each(CASES)("$kind $type($id/$variation) $comparator $value → $expected", (c) => {
    expect(verdict(c.kind, c)).toBe(c.expected);
  });
});

describe("textos que orientam o agente", () => {
  const texts = (kind: ConditionalKind, extra: Partial<Parameters<typeof inspectExecution>[1]>) => {
    const r = inspectExecution(kind, { idField: 1, type: "NUMBER_FIELD", title: "Valor", comparator: "Menor que", value: "1000", valueOptions: [], ...extra });
    return [...r.issues, ...r.warnings].join(" ");
  };

  it("número em branco: o risco na etapa e a condição que resolve", () => {
    expect(texts("step", {})).toMatch(/conta 0.*libera a etapa.*sem o número preenchido.*"Não está em branco"/);
    expect(texts("field", {})).toMatch(/conta 0.*"Não está em branco"/);
    expect(texts("field", {})).not.toMatch(/etapa/);
    expect(texts("field", { comparator: "Não é igual a", value: "0" })).toMatch(/NÃO casa com o campo em branco/);
  });

  it("percentual entre 1 e 10 avisa com a conta; a máscara sugere o valor pronto", () => {
    expect(texts("field", { variation: "2", comparator: "Igual a", value: "10" })).toMatch(/10 vira 1\.000%\. Para 10% mande "10%" ou 0\.1/);
    expect(texts("field", { type: "PHONE_FIELD", comparator: "Igual a", value: "11900001111" })).toMatch(/nunca casa\. Use "\(11\) 900001111"/);
    expect(texts("field", { type: "DOC_FIELD", variation: "1", comparator: "Não contém", value: "52998224725" })).toMatch(/sempre casa\. Use "529\.982\.247-25"/);
  });

  it("a saída com a ação inversa diz quando vale e o que fazer com várias condições", () => {
    for (const [kind, extra] of [
      ["step", { type: "TEXT_SHORT_FIELD", comparator: "Não é igual a", value: "x" }],
      ["step", { type: "DATE_PICKER_FIELD", comparator: "Não é igual a", value: "", valueOptions: ["10/06/2026"] }],
      ["field", { type: "DATE_PICKER_FIELD", comparator: "Não está em branco", value: "" }],
      ["field", { type: "DATE_PICKER_FIELD", idField: -1, comparator: "Está em branco", value: "" }]
    ] as const) {
      expect(texts(kind, extra as never)).toMatch(/se for a última regra do alvo.*Com outras condições na regra: primeiro uma regra só com/);
    }
    const date = { type: "DATE_PICKER_FIELD", comparator: "Não é igual a", value: "", valueOptions: ["10/06/2026"] };
    expect(texts("field", date)).toMatch(/data vazia.*antes uma regra com "Está em branco"/);
    expect(texts("step", date)).not.toMatch(/data vazia/);
  });

  it("comparador de branco ignora valor que sobrou na regra", () => {
    for (const type of ["DOC_FIELD", "PHONE_FIELD", "NUMBER_FIELD", "FORMULA_FIELD", "INPUT_LIST_FIELD"]) {
      for (const comparator of ["Está em branco", "Não está em branco"]) {
        expect(texts("step", { type, variation: "1", comparator, value: "52998224725", valueOptions: ["9"] }), type).toBe("");
      }
    }
  });

  it("comparador com espaço a mais (grafia antiga da tela) é lido igual", () => {
    const item = (selectedComparator: string, selectedField: Rec, value = "") => ({ selectedField, selectedComparator, value, valueOptions: [] });
    expect(itemExecution("step", item("Não  é igual a", DETALHE, "x")).issues.join(" ")).toMatch(/invertido/);
    expect(itemExecution("field", item(" Não  está  em branco ", field(4, "DATE_PICKER_FIELD", "Prazo"))).issues.join(" ")).toMatch(/data vazia/);
  });
});

describe("CLI: conversão do valor e contrato", () => {
  const envBackup = { ...process.env };
  let api: FakeConditionalApi;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
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

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const run = async (...args: string[]): Promise<void> => {
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = undefined;
    await createProgram().parseAsync(["node", "cange", "--output", "json", "flow-build", "conditional", ...args]);
  };
  const out = (): Rec => JSON.parse(stdout.join("")) as Rec;
  const items = (raw: unknown): Rec[] => JSON.parse(raw as string) as Rec[];
  const when = (value: Rec): string[] => ["--when", JSON.stringify(value)];
  const FIELD = ["--id-field", "2", "--action", "exibir"];
  const STEP = ["--id-step", String(STEP_B), "--id-step-from", String(STEP_A), "--action", "permitir"];
  const create = (target: string[], fieldId: number, comparator: string, value: unknown) =>
    run("create", "--id-flow", "100", ...target, ...when({ field: fieldId, comparator, value }));
  const savedValue = (): unknown => items(api.posts().at(-1)!.body!.conditions_items)[0]!.value;
  const textRule = (source: Rec, comparator: string, value: string, overrides: Rec = {}): Rec => {
    const [item] = items(screenRule(1, 2, source).conditions_items);
    return screenRule(321, 2, source, {
      conditions_items: JSON.stringify([{ ...item, selectedComparator: comparator, value, valueOptions: [], nameComponent: "TEXT_FILTER" }]),
      ...overrides
    });
  };

  it.each([
    ["10%", "0.1"],
    ["10,5%", "0.105"],
    ["150%", "1.5"],
    ["-10%", "-0.1"],
    ["7%", "0.07"],
    ["29%", "0.29"],
    ["57%", "0.57"],
    ["0,5%", "0.005"],
    // A conta da tela, sem arredondar: é o que a resposta digitada vira.
    ["1.1%", "0.011000000000000001"],
    ["0.1", "0.1"],
    [0.15, "0.15"]
  ])("percentual %s grava %s, em campo e em etapa", async (input, saved) => {
    for (const target of [FIELD, STEP]) {
      await create(target, 21, "Igual a", input);
      expect(process.exitCode ?? 0).toBe(0);
      expect(savedValue()).toBe(saved);
      expect(out()).toMatchObject({ verified: true });
    }
  });

  it.each([
    [21, "15", /Para 15% mande "15%" ou 0\.15/],
    [21, 11, /Para 11% mande "11%" ou 0\.11/],
    [21, "abc%", /é percentual: use "10%" ou a fração 0\.1/],
    [21, "1.500,00", /percentual \("10%"\) ou a fração/],
    [3, "10%", /número com ponto decimal/]
  ])("campo %s recusa %s com exit 2", async (fieldId, value, message) => {
    for (const target of [FIELD, STEP]) {
      await create(target, fieldId, "Igual a", value);
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(stderr.join("")).message).toMatch(message);
    }
    expect(api.posts()).toEqual([]);
  });

  it("percentual entre 1 e 10 grava com aviso; número comum não muda", async () => {
    await create(FIELD, 21, "Igual a", "10");
    expect(savedValue()).toBe("10");
    expect(out()).toMatchObject({ verified: true, executionWarnings: [expect.stringMatching(/10 vira 1\.000%/)] });
    api.rules = [];
    await create(FIELD, 3, "Maior que", "15");
    expect(savedValue()).toBe("15");
    expect(out()).not.toHaveProperty("executionWarnings");
  });

  it.each([
    [22, "Igual a", "52998224725", "529.982.247-25"],
    [22, "Contém", "52998224725", "529.982.247-25"],
    [22, "Igual a", "529.982.247-25", "529.982.247-25"],
    [23, "Igual a", "11222333000181", "11.222.333/0001-81"],
    [20, "Igual a", "11900001111", "(11) 900001111"],
    [20, "Contém", "(11)", "(11)"],
    [22, "Contém", "529", "529"]
  ])("campo %s %s %s grava %s", async (fieldId, comparator, value, saved) => {
    await create(FIELD, fieldId, comparator, value);
    expect(savedValue()).toBe(saved);
  });

  it("--rehydrate não converte valor gravado: mantém, devolve o problema e list acusa", async () => {
    for (const [source, value, message] of [[CPF, "52998224725", /máscara/], [PERCENTUAL, "15", /15 vira/]] as const) {
      api.rules = [textRule(source, "Igual a", value)];
      await run("list", "--id-flow", "100");
      expect(out()).toMatchObject({ misexecuted: 1, conditionals: [{ runsAsConfigured: false }] });
      await run("update", "--id-flow", "100", "--id-conditional", "321", "--rehydrate");
      expect(process.exitCode ?? 0).toBe(0);
      expect(savedValue()).toBe(value);
      expect(out()).toMatchObject({ verified: true, executionIssues: [expect.stringMatching(message)] });
      const before = api.posts().length;
      await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "esconder");
      expect(process.exitCode).toBe(2);
      expect(api.posts()).toHaveLength(before);
    }
  });

  it("trocar a ação não converte o valor que só tem aviso", async () => {
    api.rules = [textRule(CPF, "Contém", "529")];
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "esconder");
    expect(savedValue()).toBe("529");
  });

  it.each([
    ["data de conclusão", textRule({ id_field: -9, name: "-9", type: "DATE_PICKER_FIELD", title: "Data de Conclusão" }, "Está em branco", "")],
    ["número com vírgula", textRule(field(3, "CURRENCY_FIELD", "Valor"), "Igual a", "1.500,00")],
    ["percentual com %", textRule(PERCENTUAL, "Igual a", "10%")],
    ["condição sem valor", textRule(DETALHE, "Igual a", "")],
    ["atalho de data", textRule(field(4, "DATE_PICKER_FIELD", "Prazo"), "Igual a", "", { conditions_items: JSON.stringify([{ selectedField: field(4, "DATE_PICKER_FIELD", "Prazo"), selectedComparator: "Igual a", value: "", valueOptions: ["-1"], nameComponent: "DATE_FILTER" }]) })]
  ])("--rehydrate recusa com exit 2 (documentado): %s", async (_name, rule) => {
    api.rules = [rule];
    await run("list", "--id-flow", "100");
    expect(out()).toMatchObject({ misexecuted: 1 });
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--rehydrate");
    expect(process.exitCode).toBe(2);
    expect(api.posts()).toEqual([]);
  });

  it("create cuja linha não aparece na releitura: exit 4, nunca verified", async () => {
    api.persist = () => undefined;
    await create(FIELD, 2, "Contém", "x");
    expect(process.exitCode).toBe(4);
    expect(JSON.parse(stderr.join(""))).toMatchObject({ details: { idConditional: 555, found: false } });
  });

  it("releitura compara a regra certa, não outra igual do mesmo alvo", async () => {
    api.rules = [textRule(DETALHE, "Contém", "x", { id_conditional: 999, action: "1" }), textRule(DETALHE, "Contém", "x", { action: "2" })];
    api.persist = () => undefined;
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "exibir");
    expect(process.exitCode).toBe(4);
  });

  it("update devolve o id pedido, mesmo que o back responda outro", async () => {
    api.rules = [textRule(DETALHE, "Contém", "x", { action: "2" })];
    api.updateResponseId = 777;
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--action", "exibir");
    expect(out()).toMatchObject({ idConditional: 321, verified: true });
  });

  it("avisos e problemas de TODAS as condições", async () => {
    await run(
      "create", "--id-flow", "100", ...FIELD,
      ...when({ field: 2, comparator: "Contém", value: "x" }),
      ...when({ field: 3, comparator: "Menor que", value: 10 }),
      ...when({ field: 4, comparator: "Antes de", value: "10/06/2026" })
    );
    expect(out().executionWarnings).toEqual([expect.stringMatching(/conta 0/), expect.stringMatching(/data vazia/)]);

    const [first] = items(textRule(DETALHE, "Contém", "x").conditions_items);
    const [second] = items(textRule(CPF, "Igual a", "52998224725").conditions_items);
    const [third] = items(textRule(PERCENTUAL, "Igual a", "15").conditions_items);
    api.rules = [screenRule(321, 2, TIPO, { conditions_items: JSON.stringify([first, second, third]) })];
    await run("list", "--id-flow", "100", "--id-field", "2");
    expect((out().conditionals as Rec[])[0]!.executionIssues).toHaveLength(2);
    await run("update", "--id-flow", "100", "--id-conditional", "321", "--rehydrate");
    expect(out().executionIssues).toHaveLength(2);
  });
});
