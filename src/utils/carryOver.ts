import { asRecord } from "../contracts/raw-adapters.js";
import type { NormalizedField } from "../schemas/fields.js";

import { normalizeFieldType } from "./fieldTypeGuards.js";

/**
 * P5 (05/10, card #1367456): o mover em 1 passo REENVIA os campos já preenchidos
 * do formulário da etapa atual, como a tela faz.
 *
 * O `POST /card/v2/move-step` grava um form_answer NOVO só com o que vier em
 * `values` (a tela manda o formulário inteiro da etapa, já carregado com o que o
 * cartão tem). Mandar só o campo novo esvaziaria os outros no snapshot. Aqui o
 * kit lê o cartão e remonta o valor gravado de cada campo do formulário, no
 * formato que o back aceita de volta. Tipo que não dá para remontar com
 * segurança (anexo, lista de itens, ID automático, fórmula) vai para `notKept`:
 * o comando avisa e `--fail-on-data-loss` bloqueia.
 */

export interface CarryOverResult {
  /** hash → valor remontado, pronto para o `values` do mover. */
  values: Record<string, unknown>;
  /** hashes preenchidos hoje no cartão (contam como presentes nos obrigatórios). */
  filled: Set<string>;
  /** Preenchidos que não dá para reenviar (o mover deixa vazios no snapshot novo). */
  notKept: Array<{ name: string; title?: string }>;
}

const MULTI_ID_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD", "FLOW_FIELD"]);
const MULTI_TEXT_TYPES = new Set(["CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
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

interface StoredField {
  /** Valores do form_answer mais recente que traz o campo, na ordem do `index`. */
  items: Array<{ index: number; value: string }>;
}

export function readCarryOver(cardRaw: unknown, formId: string, fields: NormalizedField[]): CarryOverResult {
  const result: CarryOverResult = { values: {}, filled: new Set(), notKept: [] };
  const card = findCardRecord(cardRaw);
  if (!card) return result;

  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }

  const answers = toArray(card.form_answers)
    .map(asRecord)
    .filter((answer): answer is Record<string, unknown> => answer !== undefined)
    .filter((answer) => String(answer.form_id ?? answer.id_form) === formId)
    .filter((answer) => !isDeleted(answer))
    .sort(compareByRecencyAsc);

  // O snapshot mais recente vence por campo (o que a tela mostra).
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
    result.filled.add(name);
    const rebuilt = rebuild(field, entry.items.sort((a, b) => a.index - b.index).map((item) => item.value));
    if (rebuilt === undefined) {
      result.notKept.push({ name, ...(field.title ? { title: field.title } : {}) });
    } else {
      result.values[name] = rebuilt;
    }
  }
  return result;
}

function rebuild(field: NormalizedField, values: string[]): unknown {
  const type = normalizeFieldType(field.type);
  if (MULTI_ID_TYPES.has(type)) {
    const ids = values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    return ids.length === values.length ? ids : undefined;
  }
  if (MULTI_TEXT_TYPES.has(type)) return values;
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

function compareByRecencyAsc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const dateA = asString(a.dt_created) ?? "";
  const dateB = asString(b.dt_created) ?? "";
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return Number(firstDefined(a.id_form_answer, a.id) ?? 0) - Number(firstDefined(b.id_form_answer, b.id) ?? 0);
}
