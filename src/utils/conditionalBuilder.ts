import { CangeValidationError } from "../client/errors.js";
import type { ConditionInput, ConditionValueInput } from "../schemas/conditionals.js";

import { inspectExecution, type ConditionExecution, type ConditionalKind } from "./conditionalExecution.js";
import { screenFormattedValue, typedFormatError } from "./screenFormat.js";
import { isPercentField, normalizeText, parseLocaleNumber } from "./valueResolver.js";

/**
 * Condicional de campo e de etapa, no formato EXATO que a tela grava.
 *
 * A tela é a fonte da verdade (`dialogs/AutomationField/AddConditionalField` e
 * `dialogs/AutomationStep/AddConditionalStep` no front): `conditions_items` guarda o OBJETO
 * INTEIRO do campo de origem em `selectedField`, e o editor monta a lista de valores a partir
 * de `selectedField.options`. Regra gravada só com id/nome/tipo é avaliada certo no cartão,
 * mas abre no editor com a lista carregando para sempre. Por isso ninguém monta
 * `conditions_items` à mão: este módulo hidrata, valida e só então o contrato grava.
 *
 * Aqui é tudo puro (sem rede): quem busca o fluxo e os valores dinâmicos é o contrato.
 */

export type RawRecord = Record<string, unknown>;

export type { ConditionalKind } from "./conditionalExecution.js";

export type FilterComponentName = "TEXT_FILTER" | "OPTION_FILTER" | "DATE_FILTER";

const BLANK = "Está em branco";
const NOT_BLANK = "Não está em branco";

const TEXT_COMPARATORS = ["Contém", "Não contém", "Igual a", "Não é igual a", BLANK, NOT_BLANK] as const;

const OPTION_COMPARATORS = ["Igual a", "Não é igual a", "É uma das", "Não é uma das", BLANK, NOT_BLANK] as const;

const DATE_COMPARATORS = [
  "Igual a",
  "Antes de",
  "Depois de",
  "Igual a ou depois",
  "Igual a ou antes",
  "Não é igual a",
  BLANK,
  NOT_BLANK
] as const;

const NUMBER_COMPARATORS = [
  "Igual a",
  "Menor que",
  "Maior que",
  "Igual a ou maior que",
  "Igual a ou menor que",
  "Não é igual a",
  BLANK,
  NOT_BLANK
] as const;

interface SourceTypeRule {
  component: FilterComponentName;
  comparators: readonly string[];
}

/**
 * `getFilterNameComponent` (tipo → componente) + `getComponentComparationType` (tipo →
 * comparadores) da tela. Tipo fora deste mapa não serve de origem: ou a tela não o oferece
 * (`onFilter: false`), ou oferece e quebra ao abrir (cor e ícone não têm componente).
 */
export const CONDITION_SOURCE_TYPES: Readonly<Record<string, SourceTypeRule>> = {
  TEXT_SHORT_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  TEXT_LONG_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  MAIL_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  PHONE_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  DOC_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  LINK_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  ID_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  INPUT_RICH_TEXT_FIELD: { component: "TEXT_FILTER", comparators: TEXT_COMPARATORS },
  NUMBER_FIELD: { component: "TEXT_FILTER", comparators: NUMBER_COMPARATORS },
  CURRENCY_FIELD: { component: "TEXT_FILTER", comparators: NUMBER_COMPARATORS },
  FORMULA_FIELD: { component: "TEXT_FILTER", comparators: NUMBER_COMPARATORS },
  DATE_PICKER_FIELD: { component: "DATE_FILTER", comparators: DATE_COMPARATORS },
  DUE_DATE_FIELD: { component: "DATE_FILTER", comparators: DATE_COMPARATORS },
  COMBO_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  RADIO_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  CHECK_BOX_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  CHECK_BOX_ONE_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  INPUT_LIST_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  SWITCH_FIELD: { component: "OPTION_FILTER", comparators: ["Igual a"] },
  COMBO_BOX_USER_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  REQUESTER_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  COMBO_BOX_REGISTER_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS },
  COMBO_BOX_FLOW_FIELD: { component: "OPTION_FILTER", comparators: OPTION_COMPARATORS }
};

/** Tipos cuja lista de valores a tela busca na API pelo vínculo do campo (não por `options`). */
const DYNAMIC_OPTION_LINK: Readonly<Record<string, "form_id" | "register_id" | "flow_id">> = {
  COMBO_BOX_USER_FIELD: "form_id",
  REQUESTER_FIELD: "form_id",
  COMBO_BOX_REGISTER_FIELD: "register_id",
  COMBO_BOX_FLOW_FIELD: "flow_id"
};

const LINK_LABEL = { form_id: "formulário", register_id: "cadastro", flow_id: "fluxo" } as const;

const MULTI_COMPARATORS = new Set(["É uma das", "Não é uma das"]);
const BLANK_COMPARATORS = new Set<string>([BLANK, NOT_BLANK]);

/** "Usuário logado" na lista de usuários da tela. */
const LOGGED_USER = { value: "-1", label: "Usuário logado" } as const;

const NUMERIC_TYPES = new Set(["NUMBER_FIELD", "CURRENCY_FIELD"]);

function fail(message: string, details?: unknown): never {
  throw new CangeValidationError(message, details === undefined ? {} : { details });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function fieldIdOf(field: RawRecord): number | undefined {
  const id = Number(field.id_field);
  return Number.isInteger(id) && id !== 0 ? id : undefined;
}

function describeField(field: RawRecord): string {
  return `"${asText(field.title) || asText(field.name)}" (id ${asText(field.id_field)}, ${asText(field.type)})`;
}

// ---------------------------------------------------------------------------
// Estrutura do fluxo
// ---------------------------------------------------------------------------

export interface FlowStructure {
  idFlow: number;
  formInitId?: number;
  steps: RawRecord[];
  /** Campos do formulário inicial e das etapas, na ordem da tela. */
  fields: RawRecord[];
}

/** `GET /flow` → a mesma leitura que a tela faz (`form_init.fields` + `flow_steps[].form.fields`). */
export function readFlowStructure(raw: unknown): FlowStructure | undefined {
  if (!isRecord(raw)) return undefined;
  const idFlow = Number(raw.id_flow);
  if (!Number.isInteger(idFlow) || idFlow <= 0) return undefined;
  const formInit = isRecord(raw.form_init) ? raw.form_init : undefined;
  const formInitId = Number(formInit?.id_form ?? raw.form_init_id);
  const steps = records(raw.flow_steps);
  const fields = [
    ...records(formInit?.fields),
    ...steps.flatMap((step) => (isRecord(step.form) ? records(step.form.fields) : []))
  ];
  return {
    idFlow,
    ...(Number.isInteger(formInitId) && formInitId > 0 ? { formInitId } : {}),
    steps,
    fields
  };
}

/** Campos padrão que a tela oferece E o avaliador do cartão conhece. */
export function standardFields(structure: FlowStructure): RawRecord[] {
  return [
    {
      id_field: -1,
      name: "-1",
      type: "DATE_PICKER_FIELD",
      title: "Data de Vencimento",
      description: "Data de Vencimento",
      index: -1
    },
    {
      id_field: -2,
      name: "-2",
      type: "DATE_PICKER_FIELD",
      title: "Data de Criação",
      description: "Data de Criação",
      index: -2
    },
    {
      id_field: -3,
      name: "-3",
      type: "COMBO_BOX_USER_FIELD",
      title: "Responsável",
      description: "Responsável",
      index: -3,
      ...(structure.formInitId !== undefined ? { form_id: structure.formInitId } : {})
    },
    {
      id_field: -4,
      name: "-4",
      type: "COMBO_BOX_FIELD",
      title: "Etapa",
      description: "Etapa",
      index: -4,
      options: structure.steps.map((step, index) => ({
        id_field_option: step.id_step,
        field_id: -4,
        value: String(step.id_step),
        label: step.name,
        order: String(index)
      }))
    }
  ];
}

export function findFlowField(structure: FlowStructure, idField: number): RawRecord | undefined {
  return structure.fields.find((field) => fieldIdOf(field) === idField);
}

export function findFlowStep(structure: FlowStructure, idStep: number): RawRecord | undefined {
  return structure.steps.find((step) => Number(step.id_step) === idStep);
}

/** Campo de origem pelo id, hash (`name`) ou título; fora do fluxo ou ambíguo = recusa. */
export function resolveSourceField(structure: FlowStructure, ref: number | string): RawRecord {
  const selectable = [...standardFields(structure), ...structure.fields];
  const text = String(ref).trim();

  if (text === "-9" || normalizeText(text) === normalizeText("Data de Conclusão")) {
    const custom = text === "-9" ? [] : structure.fields.filter((f) => normalizeText(asText(f.title)) === normalizeText(text));
    if (custom.length === 0) {
      fail(
        "O campo padrão Data de Conclusão (-9) não serve de origem de condicional: a tela não o oferece e o avaliador do cartão o ignora (a regra nunca dispararia certo)."
      );
    }
  }

  let matches: RawRecord[] = [];
  if (/^-?\d+$/.test(text)) {
    matches = selectable.filter((field) => fieldIdOf(field) === Number(text));
  }
  if (matches.length === 0) {
    matches = selectable.filter((field) => asText(field.name) === text);
  }
  if (matches.length === 0) {
    matches = selectable.filter((field) => normalizeText(asText(field.title)) === normalizeText(text));
  }

  if (matches.length === 0) {
    fail(`O campo de origem "${text}" não é do fluxo ${structure.idFlow}. Confira com \`cange fields by-flow --flow-id ${structure.idFlow}\`.`);
  }
  if (matches.length > 1) {
    fail(`Há mais de um campo de origem para "${text}" no fluxo ${structure.idFlow}. Informe o id.`, {
      candidates: matches.map((field) => ({ id: field.id_field, title: field.title, type: field.type, formId: field.form_id }))
    });
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Comparador, ação e nome
// ---------------------------------------------------------------------------

export function sourceRule(field: RawRecord): SourceTypeRule {
  const rule = CONDITION_SOURCE_TYPES[asText(field.type)];
  if (!rule) {
    fail(`O campo ${describeField(field)} não serve de origem de condicional: a tela não tem filtro para esse tipo.`);
  }
  return rule;
}

export function resolveComparator(field: RawRecord, input: string): string {
  const { comparators } = sourceRule(field);
  const found = comparators.find((comparator) => normalizeText(comparator) === normalizeText(input));
  if (!found) {
    fail(`Comparador "${input}" inválido para o campo ${describeField(field)}. Válidos: ${comparators.join(", ")}.`, {
      comparators: [...comparators]
    });
  }
  return found;
}

const ACTIONS: Readonly<Record<ConditionalKind, Readonly<Record<string, "1" | "2">>>> = {
  field: { exibir: "1", mostrar: "1", "1": "1", esconder: "2", ocultar: "2", "2": "2" },
  step: { permitir: "1", "1": "1", bloquear: "2", "nao permitir": "2", "nao-permitir": "2", "2": "2" }
};

const ACTION_HELP: Readonly<Record<ConditionalKind, string>> = {
  field: "exibir (1) ou esconder (2)",
  step: "permitir (1) ou bloquear (2)"
};

const ACTION_LABELS: Readonly<Record<ConditionalKind, Readonly<Record<string, string>>>> = {
  field: { "1": "Exibir campo", "2": "Esconder campo" },
  step: { "1": "Permitir mover", "2": "Não permitir mover" }
};

export function resolveAction(kind: ConditionalKind, input: string | number): "1" | "2" {
  const action = ACTIONS[kind][normalizeText(String(input))];
  if (!action) {
    fail(`Ação "${input}" inválida para condicional de ${kind === "field" ? "campo" : "etapa"}. Use ${ACTION_HELP[kind]}.`);
  }
  return action;
}

export function actionLabel(kind: ConditionalKind, action: unknown): string | undefined {
  return ACTION_LABELS[kind][asText(action)];
}

/** Mesmo texto que a tela grava em `conditional.name` (limite e espaços inclusive). */
export function buildConditionalName(items: readonly ConditionItem[]): string {
  let message = "Quando o campo ";
  const titles = items.map((item) => asText(item.selectedField.title));
  titles.forEach((title, index) => {
    const containsInMessage = message.includes(title);
    if (index === 0) {
      message += `[${title} for ${items[0]!.selectedComparator.toLowerCase()}] `;
    } else if (index === 1 && titles.length > 2) {
      message += ` + ${titles.length - 1} campos`;
    } else if (index === 1 && titles.length > 1 && !containsInMessage) {
      message += ` e  [${title} for ${items[1]!.selectedComparator.toLowerCase()}] `;
    }
  });
  return message.length > 130 ? `${message.substring(0, 130)}...` : message;
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

/** Valor que o editor da tela consegue mostrar (código gravado + rótulo). */
export interface EditorChoice {
  value: string;
  label: string;
}

/** Buscas que só a API responde (a mesma fonte da lista da tela). */
export interface ConditionLookups {
  /** `GET /user/by-flow?form_id=` */
  usersByForm: (formId: number) => Promise<Array<{ id: number; name?: string; email?: string }>>;
  /** Cadastro da entrada, ou `undefined` quando ela não existe. */
  registerOfEntry: (entryId: number) => Promise<number | undefined>;
  /** Fluxo do cartão, ou `undefined` quando ele não existe ou não é visível. */
  flowOfCard: (cardId: number) => Promise<number | undefined>;
}

/** O editor só lista a opção que traz `order` (`FilterSelect`: `opt.order !== undefined`). */
function staticChoices(field: RawRecord): EditorChoice[] {
  return records(field.options)
    .filter((option) => option.order !== undefined)
    .map((option) => ({ value: asText(option.value), label: asText(option.label) }));
}

function positiveLink(field: RawRecord): number | undefined {
  const key = DYNAMIC_OPTION_LINK[asText(field.type)];
  if (!key) return undefined;
  const id = Number(field[key]);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Motivo pelo qual o editor NÃO consegue montar a lista de valores do campo (ou `undefined`). */
function optionListProblem(field: RawRecord): string | undefined {
  const type = asText(field.type);
  if (CONDITION_SOURCE_TYPES[type]?.component !== "OPTION_FILTER" || type === "SWITCH_FIELD") return undefined;
  const link = DYNAMIC_OPTION_LINK[type];
  if (link) {
    return positiveLink(field) === undefined
      ? `sem ${link} (vínculo com o ${LINK_LABEL[link]}): a lista de valores carrega para sempre`
      : undefined;
  }
  return staticChoices(field).length === 0 ? "sem options: a lista de valores carrega para sempre" : undefined;
}

function describeChoices(choices: readonly EditorChoice[]): string {
  const shown = choices.slice(0, 20).map((choice) => `${choice.value} = ${choice.label}`);
  return choices.length > shown.length ? `${shown.join("; ")}; e mais ${choices.length - shown.length}` : shown.join("; ");
}

function pickChoice(field: RawRecord, choices: readonly EditorChoice[], input: ConditionValueInput): string {
  const mode = typeof input === "object" ? ("code" in input ? "code" : "label") : "any";
  const text = asText(typeof input === "object" ? ("code" in input ? input.code : input.label) : input).trim();

  const byCode = mode === "label" ? [] : choices.filter((choice) => choice.value === text);
  const byLabel = mode === "code" ? [] : choices.filter((choice) => normalizeText(choice.label) === normalizeText(text));
  const codes = [...new Set([...byCode, ...byLabel].map((choice) => choice.value))];

  if (codes.length === 1) return codes[0]!;
  if (codes.length > 1) {
    fail(
      `O valor "${text}" é ambíguo no campo ${describeField(field)}: use {"code": "..."} ou {"label": "..."}.`,
      { candidates: [...byCode, ...byLabel] }
    );
  }
  return fail(`O valor "${text}" não está nas opções do campo ${describeField(field)}. Opções: ${describeChoices(choices)}.`, {
    options: choices.slice(0, 50)
  });
}

function plainText(field: RawRecord, input: ConditionValueInput): string {
  if (typeof input === "object") {
    fail(`O campo ${describeField(field)} não tem opções: informe o valor direto, sem code/label.`);
  }
  return asText(input).trim();
}

function entryId(field: RawRecord, input: ConditionValueInput, noun: string): number {
  const text = asText(typeof input === "object" ? ("code" in input ? input.code : input.label) : input).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    fail(`O campo ${describeField(field)} pede o id numérico ${noun}; recebi "${text}".`);
  }
  return Number(text);
}

/** `dd/MM/yyyy` (o que o DatePicker da tela grava). Aceita `yyyy-MM-dd` e converte. */
function dateValue(field: RawRecord, input: ConditionValueInput): string {
  const text = plainText(field, input);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const [year, month, day] = iso ? [iso[1]!, iso[2]!, iso[3]!] : dmy ? [dmy[3]!, dmy[2]!, dmy[1]!] : ["", "", ""];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const valid =
    year !== "" &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  if (!valid) {
    fail(
      `A condição do campo ${describeField(field)} pede uma data dd/MM/yyyy; recebi "${text}". Atalho relativo (hoje, esta semana) não é avaliado em condicional.`
    );
  }
  return `${day}/${month}/${year}`;
}

/** Normaliza como `parseFormulaConditionValue` da tela ("0,5", "1.500,00", "50%"). */
function isFormulaNumber(text: string): boolean {
  let normalized = text.replace(/\s/g, "");
  if (normalized.endsWith("%")) normalized = normalized.slice(0, -1);
  if (normalized.includes(",")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  return normalized !== "" && Number.isFinite(Number(normalized));
}

/**
 * "10%" num campo percentual → a fração, com a MESMA conta da tela (`InputNumber`:
 * `Number(texto) / 100`). Sem arredondar de propósito: 1.1% na tela vira 0.011000000000000001, e o
 * avaliador compara com `===`; o 0.011 "bonito" nunca casaria com o que a pessoa digitou.
 */
function percentFraction(field: RawRecord, text: string): string {
  const parsed = parseLocaleNumber(text.slice(0, -1));
  if (!parsed.ok) {
    return fail(`O campo ${describeField(field)} é percentual: use "10%" ou a fração 0.1; recebi "${text}".`);
  }
  return String(parsed.value / 100);
}

/** `preserve`: valor de regra já gravada, que é conferido mas nunca convertido. */
function textValue(field: RawRecord, input: ConditionValueInput, preserve: boolean): string {
  const text = plainText(field, input);
  if (text === "") fail(`A condição do campo ${describeField(field)} pede um valor não vazio.`);
  const type = asText(field.type);
  const percent = isPercentField({ type, variation: asText(field.variation) });
  if (percent && !preserve && text.endsWith("%")) return percentFraction(field, text);
  if (NUMERIC_TYPES.has(type) && !Number.isFinite(Number(text))) {
    const expected = percent ? 'um percentual ("10%") ou a fração (0.1)' : "um número com ponto decimal (ex.: 1500.5)";
    fail(`O campo ${describeField(field)} pede ${expected}; recebi "${text}".`);
  }
  if (type === "FORMULA_FIELD" && !isFormulaNumber(text)) {
    fail(`O campo ${describeField(field)} pede um número (ex.: 0,5 ou 50%); recebi "${text}".`);
  }
  // Documento e telefone completos: a resposta é sempre mascarada, então o valor também é.
  if (!preserve && typedFormatError(type, field.variation, text) === undefined) {
    return screenFormattedValue(type, field.variation, text);
  }
  return text;
}

async function optionCode(field: RawRecord, input: ConditionValueInput, lookups: ConditionLookups): Promise<string> {
  const type = asText(field.type);

  if (type === "SWITCH_FIELD") {
    return pickChoice(
      field,
      [
        { value: "true", label: "Verdadeiro" },
        { value: "false", label: "Falso" }
      ],
      input
    );
  }

  if (type === "COMBO_BOX_USER_FIELD" || type === "REQUESTER_FIELD") {
    const users = await lookups.usersByForm(positiveLink(field)!);
    const named = users.map((user) => ({ value: String(user.id), label: user.name ?? "" }));
    const emails = users
      .filter((user) => user.email !== undefined)
      .map((user) => ({ value: String(user.id), label: user.email! }));
    const text = asText(typeof input === "object" ? ("code" in input ? input.code : input.label) : input);
    return pickChoice(field, text.includes("@") ? emails : [...named, LOGGED_USER], input);
  }

  if (type === "COMBO_BOX_REGISTER_FIELD") {
    const id = entryId(field, input, "da entrada do cadastro");
    const register = await lookups.registerOfEntry(id);
    if (register !== positiveLink(field)) {
      fail(`A entrada ${id} não é do cadastro ${positiveLink(field)}, vinculado ao campo ${describeField(field)}.`);
    }
    return String(id);
  }

  if (type === "COMBO_BOX_FLOW_FIELD") {
    const id = entryId(field, input, "do cartão");
    const flow = await lookups.flowOfCard(id);
    if (flow !== positiveLink(field)) {
      fail(`O cartão ${id} não é do fluxo ${positiveLink(field)}, vinculado ao campo ${describeField(field)}.`);
    }
    return String(id);
  }

  return pickChoice(field, staticChoices(field), input);
}

// ---------------------------------------------------------------------------
// Item de condição
// ---------------------------------------------------------------------------

/** Um item de `conditions_items`, com as chaves que a tela grava (nem mais, nem menos). */
export interface ConditionItem {
  index: number;
  fields: never[];
  comparators: never[];
  selectedField: RawRecord;
  selectedComparator: string;
  value: string;
  nameComponent: FilterComponentName;
  valueOptions: string[];
}

/**
 * `selectedField` inteiro, com `conditionals: []`. O `GET /flow` traz as condicionais do
 * próprio campo de origem; copiá-las aninharia `conditions_items` dentro de
 * `conditions_items` a cada gravação, e ninguém as lê de lá.
 */
function hydrateSelectedField(field: RawRecord): RawRecord {
  const id = fieldIdOf(field);
  return id !== undefined && id < 0 ? { ...field } : { ...field, conditionals: [] };
}

/** O que o avaliador da tela faz com um item (novo ou já gravado), quando difere do que ele diz. */
export function itemExecution(kind: ConditionalKind, item: unknown): ConditionExecution {
  const selected = isRecord(item) && isRecord(item.selectedField) ? item.selectedField : undefined;
  if (!isRecord(item) || !selected) return { issues: [], warnings: [] };
  const id = fieldIdOf(selected);
  return inspectExecution(kind, {
    ...(id !== undefined ? { idField: id } : {}),
    type: asText(selected.type),
    variation: asText(selected.variation),
    title: asText(selected.title) || asText(selected.name),
    comparator: asText(item.selectedComparator).replace(/\s+/g, " ").trim(),
    value: asText(item.value),
    valueOptions: Array.isArray(item.valueOptions) ? item.valueOptions.map(asText) : []
  });
}

export interface BuildConditionOptions {
  /** O avaliador de campo e o de etapa erram em casos diferentes. */
  kind: ConditionalKind;
  /**
   * Só para regravar uma regra que já existe SEM mudar o que ela faz (`--rehydrate`): não
   * recusa a condição que a tela executa errado, porque a recusa não a consertaria.
   */
  keepMisexecuted?: boolean;
  /** Valores vindos de regra já gravada: conferidos, nunca convertidos (percentual, máscara). */
  preserveValues?: boolean;
}

export async function buildConditionItem(
  structure: FlowStructure,
  input: ConditionInput,
  index: number,
  lookups: ConditionLookups,
  options: BuildConditionOptions
): Promise<ConditionItem> {
  const field = resolveSourceField(structure, input.field);
  const { component } = sourceRule(field);
  const comparator = resolveComparator(field, input.comparator);

  const problem = optionListProblem(field);
  if (problem) {
    fail(`O campo de origem ${describeField(field)} está ${problem} no editor da tela. Corrija o campo antes de criar a regra.`);
  }

  const inputs = input.values ?? (input.value !== undefined ? [input.value] : []);
  let value = "";
  let valueOptions: string[] = [];

  if (BLANK_COMPARATORS.has(comparator)) {
    if (inputs.length > 0) fail(`O comparador "${comparator}" não aceita valor (campo ${describeField(field)}).`);
  } else if (inputs.length === 0) {
    fail(`O comparador "${comparator}" pede um valor (campo ${describeField(field)}).`);
  } else if (inputs.length > 1 && !MULTI_COMPARATORS.has(comparator)) {
    const multi = component === "OPTION_FILTER" ? ' Para vários valores use "É uma das" ou "Não é uma das".' : "";
    fail(`O comparador "${comparator}" aceita um valor só; recebi ${inputs.length} (campo ${describeField(field)}).${multi}`);
  } else if (component === "TEXT_FILTER") {
    value = textValue(field, inputs[0]!, options.preserveValues === true);
  } else if (component === "DATE_FILTER") {
    valueOptions = [dateValue(field, inputs[0]!)];
  } else {
    for (const item of inputs) {
      const code = await optionCode(field, item, lookups);
      if (!valueOptions.includes(code)) valueOptions.push(code);
    }
  }

  const item: ConditionItem = {
    index,
    fields: [],
    comparators: [],
    selectedField: hydrateSelectedField(field),
    selectedComparator: comparator,
    value,
    nameComponent: component,
    valueOptions
  };

  const { issues } = itemExecution(options.kind, item);
  if (issues.length > 0 && !options.keepMisexecuted) {
    fail(`A tela aceita esta regra mas a executa errado, então o kit não grava. ${issues.join(" ")}`, { executionIssues: issues });
  }
  return item;
}

/** Item já gravado → entrada do kit, para regravar (`update`) com o campo de origem hidratado. */
export function conditionInputFromItem(item: unknown, position: number): ConditionInput {
  const selected = isRecord(item) && isRecord(item.selectedField) ? item.selectedField : undefined;
  const field = selected ? (fieldIdOf(selected) ?? asText(selected.name)) : "";
  if (!isRecord(item) || field === "") {
    fail(`A condição ${position + 1} da regra não tem campo de origem. Informe as condições de novo com --when.`);
  }
  const comparator = asText(item.selectedComparator).replace(/\s+/g, " ").trim();
  const codes = Array.isArray(item.valueOptions) ? item.valueOptions.map(asText).filter((code) => code !== "") : [];
  const component = CONDITION_SOURCE_TYPES[asText(selected!.type)]?.component;
  if (BLANK_COMPARATORS.has(comparator)) return { field, comparator };
  if (component === "OPTION_FILTER" && codes.length > 0) return { field, comparator, values: codes.map((code) => ({ code })) };
  if (codes.length > 0) return { field, comparator, values: codes };
  const text = asText(item.value);
  return text === "" ? { field, comparator } : { field, comparator, value: text };
}

// ---------------------------------------------------------------------------
// Leitura: o editor da tela abre esta regra?
// ---------------------------------------------------------------------------

/** `conditions_items` gravado → itens; `undefined` quando não é uma lista JSON. */
export function parseConditionItems(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * O que impede o editor da tela de abrir um item. Campo de opção precisa de
 * `selectedField.options` com cada `valueOptions` dentro (ou do vínculo, nos tipos cuja lista
 * vem da API: aí o valor gravado não é conferido aqui, só o vínculo).
 */
export function editorIssues(item: unknown): string[] {
  const selected = isRecord(item) && isRecord(item.selectedField) ? item.selectedField : undefined;
  if (!isRecord(item) || !selected) return ["sem selectedField"];
  const type = asText(selected.type);
  const rule = CONDITION_SOURCE_TYPES[type];
  const label = describeField(selected);
  if (!rule) return [`${label}: a tela não tem filtro para esse tipo`];

  const problem = optionListProblem(selected);
  if (problem) return [`${label}: ${problem}`];

  const codes = Array.isArray(item.valueOptions) ? item.valueOptions.map(asText) : [];
  if (rule.component !== "OPTION_FILTER" || DYNAMIC_OPTION_LINK[type]) return [];
  const known =
    type === "SWITCH_FIELD" ? new Set(["true", "false"]) : new Set(staticChoices(selected).map((choice) => choice.value));
  const missing = codes.filter((code) => !known.has(code));
  return missing.length > 0 ? [`${label}: valor fora de selectedField.options (${missing.join(", ")})`] : [];
}

export interface ConditionSummary {
  field: { id?: number; title?: string; type?: string };
  comparator: string;
  value?: string;
  values?: Array<{ code: string; label?: string }>;
}

export function summarizeCondition(item: unknown): ConditionSummary {
  const record = isRecord(item) ? item : {};
  const selected = isRecord(record.selectedField) ? record.selectedField : {};
  const id = fieldIdOf(selected);
  const codes = Array.isArray(record.valueOptions) ? record.valueOptions.map(asText) : [];
  const choices =
    asText(selected.type) === "COMBO_BOX_USER_FIELD" || asText(selected.type) === "REQUESTER_FIELD"
      ? [LOGGED_USER]
      : staticChoices(selected);
  return {
    field: {
      ...(id !== undefined ? { id } : {}),
      ...(asText(selected.title) ? { title: asText(selected.title) } : {}),
      ...(asText(selected.type) ? { type: asText(selected.type) } : {})
    },
    comparator: asText(record.selectedComparator),
    ...(asText(record.value) ? { value: asText(record.value) } : {}),
    ...(codes.length > 0
      ? {
          values: codes.map((code) => {
            const label = choices.find((choice) => choice.value === code)?.label;
            return label ? { code, label } : { code };
          })
        }
      : {})
  };
}
