import { asRecord } from "../contracts/raw-adapters.js";
import type { NormalizedField } from "../schemas/fields.js";

import { normalizeFieldType } from "./fieldTypeGuards.js";
import { isEmptyForField, isRichTextType } from "./requiredFields.js";

/**
 * P5 (05/10, card #1367456): o mover em 1 passo REENVIA os campos já preenchidos
 * do formulário da etapa atual, como a tela faz.
 *
 * O `POST /card/v2/move-step` grava um form_answer NOVO só com o que vier em
 * `values` (a tela manda o formulário inteiro da etapa, já carregado com o que o
 * cartão tem). Mandar só o campo novo esvaziaria os outros no snapshot. Aqui o
 * kit remonta o valor gravado de cada campo do formulário, no formato que o back
 * aceita de volta. Tipo que não dá para remontar com segurança (anexo, ID
 * automático, fórmula) vai para `notKept`: o comando avisa e `--fail-on-data-loss`
 * bloqueia.
 *
 * EXTRA-06 D1 (07/10/2026, P0): a FONTE do que o cartão tem na etapa é a mesma da tela,
 * o `GET /form/pre-answer?card_id=&id_form=<form da etapa atual>`:
 *  - o rascunho da etapa (form_answer com `flow_step_id` NULL: o autosave da tela, e o
 *    que automação e `card update-values` gravam nele) quando existe;
 *  - sem rascunho, a última passagem confirmada do mesmo formulário (o back monta;
 *    `origin = "return-step-autocomplete"`).
 * O `GET /card` não traz o rascunho: o kit via campo vazio que a tela mostra preenchido
 * (falso "Falta" no mover) e, pior, o mover apaga o rascunho (`/card/v2/move-step`) e o
 * que estava só nele sumia. Agora o que está no rascunho é contado e reenviado.
 * Resposta confirmada MAIS NOVA que o rascunho (caminho antigo) entra por cima, por
 * campo: o `PUT /form/answer` grava na resposta mais recente, e o valor gravado por
 * `card update-values` nela não pode sumir no mover.
 * Sem a rota (404) ou sem nada nela, vale o `GET /card` como antes.
 */

/** De onde veio o que o cartão tem na etapa atual. */
export type CarrySource = "rascunho" | "ultima-passagem" | "cartao";

export interface CarryOverResult {
  /** hash → valor remontado, pronto para o `values` do mover. */
  values: Record<string, unknown>;
  /** hashes preenchidos hoje no cartão (contam como presentes nos obrigatórios). */
  filled: Set<string>;
  /** Preenchidos que não dá para reenviar (o mover deixa vazios no snapshot novo). */
  notKept: Array<{ name: string; title?: string }>;
  /** `rascunho` = pré-resposta da etapa (o mover apaga), `ultima-passagem` = o que o back remonta, `cartao` = GET /card. */
  source: CarrySource;
  /** Valor gravado em texto por campo (detector de perda de dados). */
  stored: Map<string, string>;
}

const MULTI_ID_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD", "FLOW_FIELD"]);
const MULTI_TEXT_TYPES = new Set(["CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
/**
 * Lista de itens e check list: o back grava 1 linha por item (`index` = `value` do item,
 * `value` = `label`). Reenviar `{ value: <index>, label: <valor> }` refaz as mesmas
 * linhas (`CreateFormAnswerService`, ramo INPUT_LIST/CHECK_LIST). No check list o
 * `label` é o item em JSON, com o `checked`.
 */
const ITEM_LIST_TYPES = new Set(["CHECK_LIST_FIELD", "INPUT_LIST_FIELD"]);
const NUMBER_TYPES = new Set(["NUMBER_FIELD", "NUMERIC_FIELD", "CURRENCY_FIELD", "MONEY_FIELD"]);
const USER_TYPES = new Set(["COMBO_BOX_USER_FIELD", "USER_FIELD", "REQUESTER_FIELD"]);
const BOOLEAN_TYPES = new Set(["SWITCH_FIELD", "TOGGLE_FIELD"]);
const SINGLE_TEXT_TYPES = new Set([
  "TEXT_SHORT_FIELD",
  "TEXT_LONG_FIELD",
  "RICH_TEXT_FIELD",
  "INPUT_RICH_TEXT_FIELD",
  "DYNAMIC_TEXT_FIELD",
  "HTML_FIELD",
  "PHONE_FIELD",
  "PHONE_NUMBER_FIELD",
  "DOC_FIELD",
  "DOCUMENT_FIELD",
  "LINK_FIELD",
  "URL_FIELD",
  "MAIL_FIELD",
  "EMAIL_FIELD",
  "DATE_PICKER_FIELD",
  "DUE_DATE_FIELD",
  "DATE_FIELD",
  "COMBO_BOX_FIELD",
  "RADIO_BOX_FIELD"
]);

/** Origem do form_answer sintético que o back monta sem rascunho (BuildReturnStepAutocompleteService). */
const SYNTHETIC_ORIGIN = "return-step-autocomplete";

interface StoredField {
  /** Valores da resposta que vence o campo, na ordem do `index`. */
  items: Array<{ index: number; value: string }>;
}

/** Só o `GET /card` (respostas confirmadas): o mais recente vence por campo. */
export function readCarryOver(cardRaw: unknown, formId: string, fields: NormalizedField[]): CarryOverResult {
  return build(confirmedAnswers(cardRaw, formId), fields, "cartao");
}

export interface StepCarryOverInput {
  /** Resposta do `GET /card` (respostas confirmadas). */
  cardRaw: unknown;
  /** Resposta do `GET /form/pre-answer` da etapa atual (`{ fields, formsAnswers }`); undefined = rota ausente. */
  preAnswerRaw: unknown;
  formId: string;
  fields: NormalizedField[];
}

/** O que o cartão tem no formulário da etapa atual, pela mesma fonte da tela (ver o topo). */
export function readStepCarryOver(input: StepCarryOverInput): CarryOverResult {
  const pre = preAnswerRecord(input.preAnswerRaw, input.formId);
  if (!pre) return readCarryOver(input.cardRaw, input.formId, input.fields);
  const synthetic = String(pre.origin ?? "") === SYNTHETIC_ORIGIN || firstDefined(pre.id_form_answer, pre.id) === undefined;
  if (synthetic) return build([pre], input.fields, "ultima-passagem");
  const newer = confirmedAnswers(input.cardRaw, input.formId).filter((answer) => isNewer(answer, pre));
  return build([pre, ...newer], input.fields, "rascunho");
}

/** `formsAnswers` da pré-resposta, quando é deste formulário e tem campo gravado. */
function preAnswerRecord(raw: unknown, formId: string): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const answer = asRecord(root.formsAnswers ?? root.formAnswer ?? asRecord(root.raw)?.formsAnswers);
  if (!answer || isDeleted(answer)) return undefined;
  const answerForm = firstDefined(answer.form_id, answer.id_form);
  if (answerForm !== undefined && String(answerForm) !== formId) return undefined;
  const rows = toArray(answer.form_answer_fields)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined && !isDeleted(row));
  return rows.length > 0 ? answer : undefined;
}

function confirmedAnswers(cardRaw: unknown, formId: string): Array<Record<string, unknown>> {
  const card = findCardRecord(cardRaw);
  if (!card) return [];
  return toArray(card.form_answers)
    .map(asRecord)
    .filter((answer): answer is Record<string, unknown> => answer !== undefined)
    .filter((answer) => String(answer.form_id ?? answer.id_form) === formId)
    .filter((answer) => !isDeleted(answer))
    .sort(compareByRecencyAsc);
}

/** `answers` do mais antigo para o mais recente: o mais recente que traz o campo vence. */
function build(answers: Array<Record<string, unknown>>, fields: NormalizedField[], source: CarrySource): CarryOverResult {
  const result: CarryOverResult = { values: {}, filled: new Set(), notKept: [], source, stored: new Map() };

  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }

  const stored = new Map<string, StoredField>();
  for (const answer of answers) {
    const perAnswer = new Map<string, StoredField>();
    for (const item of toArray(answer.form_answer_fields)) {
      const record = asRecord(item);
      if (!record || isDeleted(record)) continue;
      const fieldRecord = asRecord(record.field);
      const fieldId = firstDefined(record.field_id, record.id_field, fieldRecord?.id_field, fieldRecord?.id);
      const field =
        (fieldId !== undefined ? byId.get(String(fieldId)) : undefined) ??
        (typeof fieldRecord?.name === "string" ? byName.get(fieldRecord.name) : undefined);
      if (!field) continue;
      const value = asString(record.value);
      const entry = perAnswer.get(field.name) ?? { items: [] };
      if (value !== undefined && value.trim().length > 0) {
        entry.items.push({ index: Number(record.index ?? entry.items.length) || 0, value });
      }
      perAnswer.set(field.name, entry);
    }
    for (const [name, entry] of perAnswer) stored.set(name, entry);
  }

  for (const [name, entry] of stored) {
    if (entry.items.length === 0) continue;
    const field = byName.get(name)!;
    const items = entry.items.sort((a, b) => a.index - b.index);
    const texts = items.map((item) => item.value);
    // D4: rich text sem conteúdo (`<p></p>`) não conta como preenchido (a tela trata como vazio).
    const empty = isRichTextType(field.type) && isEmptyForField(field, texts);
    if (!empty) {
      result.filled.add(name);
      result.stored.set(name, texts.join(", "));
    }
    const rebuilt = rebuild(field, items);
    if (rebuilt === undefined) {
      if (!empty) result.notKept.push({ name, ...(field.title ? { title: field.title } : {}) });
    } else {
      result.values[name] = rebuilt;
    }
  }
  return result;
}

function rebuild(field: NormalizedField, items: Array<{ index: number; value: string }>): unknown {
  const type = normalizeFieldType(field.type);
  const values = items.map((item) => item.value);
  if (MULTI_ID_TYPES.has(type)) {
    const ids = values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    return ids.length === values.length ? ids : undefined;
  }
  if (MULTI_TEXT_TYPES.has(type)) return values;
  if (ITEM_LIST_TYPES.has(type)) return items.map((item) => ({ value: String(item.index), label: item.value }));
  if (values.length !== 1) return undefined;
  const [value] = values as [string];
  if (NUMBER_TYPES.has(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (USER_TYPES.has(type)) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  if (BOOLEAN_TYPES.has(type)) {
    if (value === "true" || value === "1" || value === "S") return true;
    if (value === "false" || value === "0" || value === "N") return false;
    return undefined;
  }
  if (SINGLE_TEXT_TYPES.has(type)) return value;
  return undefined;
}

function findCardRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (!direct) return undefined;
  if (Array.isArray(direct.form_answers)) return direct;
  for (const key of ["card", "data", "item", "result", "raw"]) {
    const nested = asRecord(direct[key]);
    if (nested && Array.isArray(nested.form_answers)) return nested;
  }
  return direct;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isDeleted(record: Record<string, unknown>): boolean {
  return String(record.deleted ?? "").toUpperCase() === "S";
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Mesma ordem do back para "a resposta mais recente" (`dt_created DESC, id DESC`); sem data dos dois lados, só o id. */
function isNewer(answer: Record<string, unknown>, than: Record<string, unknown>): boolean {
  if (asString(answer.dt_created) !== undefined && asString(than.dt_created) !== undefined) {
    return compareByRecencyAsc(answer, than) > 0;
  }
  return Number(firstDefined(answer.id_form_answer, answer.id) ?? 0) > Number(firstDefined(than.id_form_answer, than.id) ?? 0);
}

function compareByRecencyAsc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const dateA = asString(a.dt_created) ?? "";
  const dateB = asString(b.dt_created) ?? "";
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return Number(firstDefined(a.id_form_answer, a.id) ?? 0) - Number(firstDefined(b.id_form_answer, b.id) ?? 0);
}
