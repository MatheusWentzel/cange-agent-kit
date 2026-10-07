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
 *
 * Rascunho x resposta confirmada mais nova (F1 da revisão, 07/10): decide por CAMPO e pela
 * recência da LINHA (`form_answer_field.dt_last_update`, no empate o `id_form_answer_field`),
 * não pelo `dt_created` do form_answer. O autosave da tela (`POST /form/pre-new-answer`)
 * regrava as linhas do rascunho sem mudar o form_answer: um rascunho criado antes e editado
 * depois da confirmada é o valor que a tela mostra (cartão 1107439: 18:30 no rascunho
 * editado em 08/07 contra 18:00 na confirmada de 07/07). A confirmada só vence quando a
 * linha dela é a mais nova, que é o caso do `card update-values` (o `PUT /form/answer`
 * grava na resposta mais recente, e esse valor não pode sumir no mover).
 *
 * Autocompletar da tela (F2 da revisão): a tela preenche o campo SEM linha na pré-resposta
 * com o autocompletar dele (`getAutoCompleteRule('answer')`) e manda esse valor no mover.
 * O kit faz igual (`applyAutoComplete`): estático, data atual, criador do cartão e o valor
 * de outro campo do cartão. O que o kit não calcula (usuário atual, campo de vínculo,
 * opção pelo rótulo) vai para `autoPending` e o obrigatório vazio vira aviso.
 *
 * A rota respondeu SEM nada (nem rascunho com linha, nem última passagem elegível): a tela
 * abre o formulário vazio, só com o autocompletar (`usePreAnswer`, ramo "No existing
 * answers"), e o kit também (`vazio`). Antes o kit caía no `GET /card` e contava o que a
 * tela não mostra: anexo da passagem anterior (o back não reaproveita anexo entre
 * passagens) e valor de passagem mais antiga quando a última veio sem linha (184 cartões
 * ativos no cange_local, 07/10). Só sem a rota (404, back antigo) vale o `GET /card`.
 */

/** De onde veio o que o cartão tem na etapa atual. */
export type CarrySource = "rascunho" | "ultima-passagem" | "vazio" | "cartao";

/** Regra do autocompletar que deu o valor (o que a tela faria no campo sem valor). */
export type AutoFillRule = "estatico" | "data-atual" | "criador-do-cartao" | "campo-do-cartao";

export interface CarryOverResult {
  /** hash → valor remontado, pronto para o `values` do mover (autocompletar incluído). */
  values: Record<string, unknown>;
  /** hashes preenchidos hoje no cartão (contam como presentes nos obrigatórios). */
  filled: Set<string>;
  /** Preenchidos que não dá para reenviar (o mover deixa vazios no snapshot novo). */
  notKept: Array<{ name: string; title?: string }>;
  /**
   * `rascunho` = pré-resposta da etapa (o mover apaga), `ultima-passagem` = o que o back remonta,
   * `vazio` = a rota respondeu sem nada (a tela abre o formulário vazio), `cartao` = GET /card (back sem a rota).
   */
  source: CarrySource;
  /** Valor gravado em texto por campo (detector de perda de dados). */
  stored: Map<string, string>;
  /** Campos com linha gravada na fonte, mesmo vazia (a tela não autocompleta esses). */
  answered: Set<string>;
  /** Campos sem valor que o autocompletar da tela preenche; o valor já está em `values`. */
  autoFilled: Array<{ name: string; title?: string; rule: AutoFillRule }>;
  /** Campos sem valor com autocompletar que o kit não calcula: obrigatório vazio vira aviso. */
  autoPending: Array<{ name: string; title?: string; reason: string }>;
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

/** Recência de uma linha: [data da linha em ms, id_form_answer_field, ordem da resposta]. */
type Recency = [number, number, number];

interface StoredField {
  /** Valores da resposta que vence o campo, na ordem do `index`. */
  items: Array<{ index: number; value: string }>;
  /** A linha mais nova do campo nesta resposta (campo de várias linhas: a maior). */
  recency: Recency;
}

/** Como escolher, por campo, entre as respostas: a mais recente que traz o campo, ou a linha mais nova. */
type MergeMode = "resposta" | "linha";

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
  let result: CarryOverResult;
  let draft: Record<string, unknown> | undefined;
  if (!pre) {
    // Sem a rota (404): o GET /card, como antes. A rota respondeu sem nada: vazio, como a tela.
    result =
      input.preAnswerRaw === undefined
        ? readCarryOver(input.cardRaw, input.formId, input.fields)
        : build([], input.fields, "vazio");
  } else if (String(pre.origin ?? "") === SYNTHETIC_ORIGIN || firstDefined(pre.id_form_answer, pre.id) === undefined) {
    result = build([pre], input.fields, "ultima-passagem");
  } else {
    draft = pre;
    // Só a confirmada mais nova que o rascunho disputa com ele (é nela que o PUT /form/answer
    // grava quando o rascunho é mais antigo); a disputa é campo a campo, pela linha (F1).
    const newer = confirmedAnswers(input.cardRaw, input.formId).filter((answer) => isNewer(answer, pre));
    result = build([pre, ...newer], input.fields, "rascunho", "linha");
  }
  // A rota respondeu: os `fields` dela trazem o autocompletar de cada campo, como a tela usa.
  if (input.preAnswerRaw !== undefined) {
    applyAutoComplete(result, {
      preFields: asRecord(input.preAnswerRaw)?.fields,
      cardRaw: input.cardRaw,
      fields: input.fields,
      ...(draft ? { draft } : {})
    });
  }
  return result;
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

/**
 * `answers` do mais antigo para o mais recente. Modo `resposta`: a mais recente que traz o
 * campo vence. Modo `linha` (rascunho x confirmadas): vence a resposta com a linha mais nova
 * do campo (`dt_last_update`, depois `id_form_answer_field`, depois a ordem da resposta).
 */
function build(
  answers: Array<Record<string, unknown>>,
  fields: NormalizedField[],
  source: CarrySource,
  mode: MergeMode = "resposta"
): CarryOverResult {
  const result: CarryOverResult = {
    values: {},
    filled: new Set(),
    notKept: [],
    source,
    stored: new Map(),
    answered: new Set(),
    autoFilled: [],
    autoPending: []
  };

  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }

  const stored = new Map<string, StoredField>();
  answers.forEach((answer, order) => {
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
      const recency = lineRecency(record, answer, order);
      const entry = perAnswer.get(field.name) ?? { items: [], recency };
      if (compareRecency(recency, entry.recency) > 0) entry.recency = recency;
      if (value !== undefined && value.trim().length > 0) {
        entry.items.push({ index: Number(record.index ?? entry.items.length) || 0, value });
      }
      perAnswer.set(field.name, entry);
    }
    for (const [name, entry] of perAnswer) {
      const current = stored.get(name);
      if (mode === "resposta" || !current || compareRecency(entry.recency, current.recency) > 0) stored.set(name, entry);
    }
  });

  for (const [name, entry] of stored) {
    result.answered.add(name);
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

/** Data da linha (a da última edição, senão a de criação, senão a da resposta), o id e a ordem. */
function lineRecency(record: Record<string, unknown>, answer: Record<string, unknown>, order: number): Recency {
  const time = parseTime(record.dt_last_update) ?? parseTime(record.dt_created) ?? parseTime(answer.dt_created) ?? 0;
  const id = Number(firstDefined(record.id_form_answer_field, record.id) ?? 0);
  return [time, Number.isFinite(id) ? id : 0, order];
}

function compareRecency(a: Recency, b: Recency): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

// ---------------------------------------------------------------------------
// Autocompletar da tela (F2)
// ---------------------------------------------------------------------------

/** Destino lista de opções: a tela casa pelo RÓTULO do valor de origem; o kit não reproduz. */
const OPTION_TYPES = new Set(["COMBO_BOX_FIELD", "RADIO_BOX_FIELD", "CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD", "DATE_FIELD"]);

interface AutoCompleteInput {
  /** `fields` do `GET /form/pre-answer` (com `ac_type`, `ac_parent_field_id`, `auto_complete`). */
  preFields: unknown;
  cardRaw: unknown;
  fields: NormalizedField[];
  /** O rascunho da etapa (a tela também lê o campo de origem nele). */
  draft?: Record<string, unknown>;
}

/**
 * Igual ao `usePreAnswer` + `getAutoCompleteRule('answer')` da tela: campo do formulário sem
 * linha no que o cartão tem recebe o valor do autocompletar dele, e esse valor vai no mover.
 *  - `ac_type = 1` (estático): as linhas de `auto_complete.form_answer_fields`;
 *  - `ac_type = 0` e `ac_parent_field_id`: `-1` data atual, `-3` criador do cartão, `> 0` o
 *    valor desse campo no cartão (a resposta mais recente que o traz, rascunho incluído).
 * Fica em `autoPending` (o kit não calcula): `-2` usuário atual (quem abre a tela), campo de
 * vínculo (`ac_child_field_id`) e destino lista de opções (a tela casa pelo rótulo).
 */
function applyAutoComplete(result: CarryOverResult, input: AutoCompleteInput): void {
  const preFields = toArray(input.preFields)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  if (preFields.length === 0) return;
  const byId = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  for (const record of preFields) {
    const id = firstDefined(record.id_field, record.id);
    if (id !== undefined) byId.set(String(id), record);
    if (typeof record.name === "string") byName.set(record.name, record);
  }

  for (const field of input.fields) {
    if (result.answered.has(field.name) || field.name in result.values) continue;
    const raw = (field.id !== undefined ? byId.get(String(field.id)) : undefined) ?? byName.get(field.name);
    if (!raw) continue;
    const title = field.title ? { title: field.title } : {};
    const pending = (reason: string): void => {
      result.autoPending.push({ name: field.name, ...title, reason });
    };
    const fill = (items: Array<{ index: number; value: string }>, rule: AutoFillRule): void => {
      const rebuilt = rebuild(field, items);
      if (rebuilt === undefined) return pending("tipo que o kit não remonta");
      if (isEmptyForField(field, rebuilt)) return;
      result.values[field.name] = rebuilt;
      result.autoFilled.push({ name: field.name, ...title, rule });
    };

    const acType = toInteger(raw.ac_type);
    if (acType === 1) {
      const fieldId = firstDefined(raw.id_field, field.id);
      const items = valueItems(
        toArray(asRecord(raw.auto_complete)?.form_answer_fields).filter((item) => {
          const row = asRecord(item);
          const rowField = row ? firstDefined(row.field_id, row.id_field) : undefined;
          return rowField === undefined || fieldId === undefined || String(rowField) === String(fieldId);
        })
      );
      if (items.length > 0) fill(items, "estatico");
      continue;
    }
    if (acType !== 0) continue;
    const parent = toInteger(raw.ac_parent_field_id);
    if (parent === undefined || parent === 0) continue;
    if (parent === -1) {
      fill([{ index: 0, value: new Date().toISOString() }], "data-atual");
    } else if (parent === -3) {
      const creator = toInteger(findCardRecord(input.cardRaw)?.user_id_creator);
      if (creator !== undefined && creator > 0) fill([{ index: 0, value: String(creator) }], "criador-do-cartao");
      else pending("criador do cartão");
    } else if (parent === -2) {
      pending("usuário atual");
    } else if (parent > 0) {
      if (toInteger(raw.ac_child_field_id) !== undefined) {
        pending("campo de vínculo");
      } else if (OPTION_TYPES.has(normalizeFieldType(field.type))) {
        pending("opção pelo rótulo");
      } else {
        const items = parentFieldItems(input.cardRaw, input.draft, parent);
        if (!items) continue;
        if (DATE_TYPES.has(normalizeFieldType(field.type))) {
          const iso = items.length === 1 ? toIsoDate(items[0]!.value) : undefined;
          // A tela descarta a data que não consegue ler (o campo fica vazio).
          if (iso) fill([{ index: 0, value: iso }], "campo-do-cartao");
        } else {
          fill(items, "campo-do-cartao");
        }
      }
    }
  }
}

/** Linhas não excluídas com valor, na ordem do `index`. */
function valueItems(rows: unknown[]): Array<{ index: number; value: string }> {
  const items: Array<{ index: number; value: string }> = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row || isDeleted(row)) continue;
    const value = asString(row.value);
    if (value === undefined || value.trim().length === 0) continue;
    items.push({ index: Number(row.index ?? items.length) || 0, value });
  }
  return items.sort((a, b) => a.index - b.index);
}

/**
 * Valor do campo de origem no cartão, como o `POST /form/answers/by-cards` da tela: a
 * resposta mais recente (`dt_created`) que traz o campo, rascunho da etapa incluído.
 */
function parentFieldItems(
  cardRaw: unknown,
  draft: Record<string, unknown> | undefined,
  parentId: number
): Array<{ index: number; value: string }> | undefined {
  const card = findCardRecord(cardRaw);
  const answers = toArray(card?.form_answers)
    .map(asRecord)
    .filter((answer): answer is Record<string, unknown> => answer !== undefined && !isDeleted(answer));
  if (draft) answers.push(draft);
  let best: { answer: Record<string, unknown>; rows: unknown[] } | undefined;
  for (const answer of answers) {
    const rows = toArray(answer.form_answer_fields).filter((item) => {
      const row = asRecord(item);
      if (!row || isDeleted(row)) return false;
      const fieldRecord = asRecord(row.field);
      return String(firstDefined(row.field_id, row.id_field, fieldRecord?.id_field) ?? "") === String(parentId);
    });
    if (rows.length === 0) continue;
    if (!best || compareByRecencyAsc(answer, best.answer) > 0) best = { answer, rows };
  }
  if (!best) return undefined;
  const items = valueItems(best.rows);
  return items.length > 0 ? items : undefined;
}

/** Data em ISO, como o `sanitizeAutoCompleteDateValue` da tela (ISO ou dd/MM/yyyy). */
function toIsoDate(value: string): string | undefined {
  const text = value.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (br) {
    const date = new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1])));
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function toInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
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
