import type { NormalizedField } from "../schemas/fields.js";
import { getExpectedFormatByFieldType } from "../utils/fieldTypeGuards.js";

import type {
  CardSummary,
  FieldSummaryItem,
  FieldsSummary,
  FlowSummary,
  FlowViewFilterSummary,
  FlowViewSortItem,
  FlowViewSummary,
  NotificationSummary,
  RegisterEntry,
  RegisterSummary
} from "./types.js";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const candidates = [record.items, record.data, record.results, record.list, record.rows];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    const candidateRecord = asRecord(candidate);
    if (candidateRecord) {
      for (const nested of Object.values(candidateRecord)) {
        if (Array.isArray(nested)) {
          return nested;
        }
      }
    }
  }

  return [];
}

export function extractPrimaryRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (!direct) {
    return undefined;
  }

  const nestedCandidates = [direct.data, direct.item, direct.flow, direct.register, direct.card];
  for (const candidate of nestedCandidates) {
    const record = asRecord(candidate);
    if (record) {
      return record;
    }
  }

  const array = extractArray(raw).map(asRecord).filter(isDefined);
  if (array.length > 0) {
    return array[0];
  }

  return direct;
}

export function summarizeFlow(raw: unknown): FlowSummary {
  const record = extractPrimaryRecord(raw);
  if (!record) {
    return {};
  }

  return {
    id: pickNumberOrString(record, ["id", "flow_id", "id_flow"]),
    hash: pickString(record, ["hash"]),
    title: pickString(record, ["title", "name"]),
    formInitId: pickNumberOrString(record, ["form_init_id", "formInitId"]),
    companyId: pickNumberOrString(record, ["company_id", "id_company"]),
    status: pickString(record, ["status", "active"])
  };
}

/**
 * Resume uma visualização (flow_view). Parseia o `schema` JSON para dar
 * visibilidade dos filtros/colunas/ordenação salvos sem exigir que o chamador
 * conheça o formato interno. `includeSchema` anexa o schema parseado bruto.
 */
export function summarizeFlowView(raw: unknown, options: { includeSchema?: boolean } = {}): FlowViewSummary {
  const record = extractPrimaryRecord(raw);
  if (!record) {
    return {};
  }

  const parsedSchema = parseFlowViewSchema(record.schema);
  const isPublicRaw = record.isPublic ?? record.is_public;

  return compactDefined({
    id: pickNumberOrString(record, ["id_flow_view", "id", "flow_view_id"]),
    name: pickString(record, ["name", "title"]),
    icon: pickString(record, ["icon"]),
    color: pickString(record, ["color"]),
    isPublic: typeof isPublicRaw === "string" ? isPublicRaw.trim().toUpperCase() === "S" : pickBoolean(record, ["isPublic"]),
    isFavorited: pickBoolean(record, ["isFavorited", "is_favorited"]),
    filter: summarizeFlowViewSchema(parsedSchema),
    schema: options.includeSchema ? parsedSchema : undefined
  });
}

function parseFlowViewSchema(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function summarizeFlowViewSchema(
  schema: Record<string, unknown> | undefined
): FlowViewFilterSummary | undefined {
  if (!schema) {
    return undefined;
  }

  const fieldView = toRecordArray(schema.fieldView);
  const activeColumns = fieldView.filter((column) => pickBoolean(column, ["active"]) !== false);
  const conditions = toRecordArray(schema.conditions);
  const orderBy = toRecordArray(schema.orderBy);

  const sort: FlowViewSortItem[] = orderBy.map((order) => {
    const selectedField = asRecord(order.selectedField);
    return compactDefined({
      field:
        pickNumberOrString(selectedField ?? {}, ["title", "name", "id_field", "field_id"]) ??
        pickNumberOrString(order, ["title", "id_field", "field_id"]),
      order: pickString(order, ["selectedOrder", "order"])
    });
  });

  return compactDefined({
    columnsCount: activeColumns.length > 0 || fieldView.length > 0 ? activeColumns.length : undefined,
    filtersCount: conditions.length > 0 ? conditions.length : undefined,
    sort: sort.length > 0 ? sort : undefined,
    searchText: pickString(schema, ["searchText"]),
    searchFieldScope: pickString(schema, ["search_field_scope", "searchFieldScope"])
  });
}

export function summarizeRegister(raw: unknown): RegisterSummary {
  const record = extractPrimaryRecord(raw);
  if (!record) {
    return {};
  }

  return {
    id: pickNumberOrString(record, ["id", "register_id", "id_register"]),
    hash: pickString(record, ["hash"]),
    title: pickString(record, ["title", "name"]),
    formId: pickNumberOrString(record, ["form_id", "id_form", "formId"]),
    companyId: pickNumberOrString(record, ["company_id", "id_company"]),
    status: pickString(record, ["status", "active"])
  };
}

const V2_FORM_ANSWER_PREFIX = "form_answer.";
const V2_FIELD_PREFIX = "field:";

/** `deleted === "S"` é a fonte de verdade de exclusão (pode vir null/"N" para ativo). */
function isEntryDeleted(record: Record<string, unknown>): boolean {
  return typeof record.deleted === "string" && record.deleted.trim().toUpperCase() === "S";
}

/** Primeiro valor não-vazio dentre as chaves (ignora undefined/null/string em branco). */
function firstNonEmptyValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

/**
 * v1 — extrai as entradas (form_answers) do payload do `GET /register?withAnswers=true`.
 * Ignora entradas com `deleted === "S"` (fonte de verdade).
 */
export function extractRegisterAnswersV1(raw: unknown): Record<string, unknown>[] {
  const record = extractPrimaryRecord(raw);
  const answers = record ? toRecordArray(record.form_answers) : [];
  return answers.filter((answer) => !isEntryDeleted(answer));
}

/**
 * v1 — normaliza um `form_answer` (rota legada) em {@link RegisterEntry}.
 * Rótulo = `field.title` (humano; cai no `name`/hash só se faltar título).
 * Valor por `valueString`; se o mesmo `field_id` aparecer em índices repetidos, agrega em array.
 */
export function summarizeRegisterEntryV1(rawAnswer: unknown): RegisterEntry {
  const answer = asRecord(rawAnswer) ?? {};
  const byFieldId = new Map<string, { label: string; values: unknown[] }>();

  for (const answerField of toRecordArray(answer.form_answer_fields)) {
    if (isEntryDeleted(answerField)) {
      continue;
    }
    const field = asRecord(answerField.field) ?? {};
    const fieldId =
      pickNumberOrString(answerField, ["field_id", "id_field"]) ??
      pickNumberOrString(field, ["id_field", "field_id", "id"]);
    if (fieldId === undefined) {
      continue;
    }
    const value = firstNonEmptyValue(answerField, ["valueString", "value_string", "value"]);
    if (value === undefined) {
      continue;
    }
    const label = pickString(field, ["title", "name"]) ?? String(fieldId);
    const key = String(fieldId);
    const existing = byFieldId.get(key);
    if (existing) {
      existing.values.push(value);
    } else {
      byFieldId.set(key, { label, values: [value] });
    }
  }

  const fields: Record<string, unknown> = {};
  for (const { label, values } of byFieldId.values()) {
    fields[label] = values.length === 1 ? values[0] : values;
  }

  return compactDefined({
    id: pickNumberOrString(answer, ["id_form_answer", "form_answer_id", "id"]),
    title: pickString(answer, ["title"]),
    fields
  }) as RegisterEntry;
}

/**
 * v2 — extrai os itens (rows projetadas) do payload do `POST /register/v2/query`.
 */
export function extractRegisterItemsV2(raw: unknown): Record<string, unknown>[] {
  const record = asRecord(raw);
  if (record && Array.isArray(record.items)) {
    return record.items.map(asRecord).filter(isDefined);
  }
  return extractArray(raw).map(asRecord).filter(isDefined);
}

/**
 * v2 — normaliza uma row projetada em {@link RegisterEntry}.
 * A row usa chaves `form_answer.<col>` (metadados) e `field:<id>` (valores). Ela NÃO traz o
 * título humano do campo, só o id — por isso recebe um mapa `field_id → título`.
 * Valor: single-value é um objeto `{ display_value, value, ... }`; multi-value é
 * `{ items: [...], mv_display_value }`.
 */
export function summarizeRegisterEntryV2(
  rawRow: unknown,
  titleByFieldId: Map<string, string> = new Map()
): RegisterEntry {
  const row = asRecord(rawRow) ?? {};
  const fields: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(row)) {
    if (!key.startsWith(V2_FIELD_PREFIX)) {
      continue;
    }
    const fieldId = key.slice(V2_FIELD_PREFIX.length);
    const value = normalizeRegisterV2Value(rawValue);
    if (value === undefined) {
      continue;
    }
    const label = titleByFieldId.get(fieldId) ?? key;
    fields[label] = value;
  }

  return compactDefined({
    id: pickNumberOrString(row, [`${V2_FORM_ANSWER_PREFIX}id_form_answer`, "id_form_answer"]),
    title: pickString(row, [`${V2_FORM_ANSWER_PREFIX}title`, "title"]),
    fields
  }) as RegisterEntry;
}

/** Reduz o valor de um campo v2 ao texto/array útil (display_value; multi-valor → array). */
function normalizeRegisterV2Value(raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object") {
    return raw === "" ? undefined : raw;
  }
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const values = record.items
      .map((item) => firstNonEmptyValue(asRecord(item) ?? {}, ["display_value", "related_title", "value"]))
      .filter((value) => value !== undefined);
    if (values.length > 0) {
      return values;
    }
    return firstNonEmptyValue(record, ["mv_display_value"]);
  }
  return firstNonEmptyValue(record, ["display_value", "related_title", "value"]);
}

export function summarizeCard(raw: unknown): CardSummary {
  const record = extractCardRecord(raw);
  if (!record) {
    return {};
  }

  const flow = asRecord(record.flow);
  const flowStep = asRecord(record.flow_step);
  const user = asRecord(record.user);
  const flattenedFields = extractCardFieldValues(record);
  const cardId = pickNumberOrString(record, ["id", "card_id", "id_card"]);
  const flowId = pickNumberOrString(record, ["flow_id", "id_flow"]);
  const stepId =
    pickNumberOrString(record, ["flow_step_id", "step_id", "id_step", "current_step_id"]) ??
    pickNumberOrString(flowStep ?? {}, ["id_step", "step_id"]);

  return compactDefined({
    cardId,
    id_card: cardId,
    title: pickString(record, ["title", "name"]),
    flowId,
    flow_id: flowId,
    flowName: pickString(flow ?? {}, ["name", "title"]),
    flowHash: pickString(flow ?? {}, ["hash"]),
    companyId: pickNumberOrString(record, ["company_id", "id_company"]),
    currentStepId: stepId,
    step_id: stepId,
    stepName: pickString(flowStep ?? {}, ["name", "title"]),
    dueDate: pickString(record, ["dt_due", "due_date"]),
    createdAt: pickString(record, ["dt_created", "created_at"]),
    responsibleUserId:
      pickNumberOrString(record, ["user_id", "responsible_user_id"]) ??
      pickNumberOrString(user ?? {}, ["id_user", "user_id", "id"]),
    responsibleName: pickString(user ?? {}, ["name"]),
    statusDue: pickNumberOrString(record, ["status_dt_due"]),
    fieldValues: flattenedFields,
    fields: flattenedFields,
    archived: pickBoolean(record, ["archived"]),
    complete: pickBoolean(record, ["complete"])
  });
}

export function summarizeNotification(raw: unknown): NotificationSummary {
  const record = extractNotificationRecord(raw);
  if (!record) {
    return {};
  }

  const card = asRecord(record.card);
  const comment = asRecord(record.card_comment);
  const commentUser = asRecord(comment?.user);
  const responsibleUser = asRecord(card?.user);
  const flow = asRecord(card?.flow);
  const flowStep = asRecord(card?.flow_step);
  const commentText =
    pickString(comment ?? {}, ["description", "message", "content"]) ??
    pickString(record, ["description", "message", "content"]);

  return compactDefined({
    id: pickNumberOrString(record, ["id", "notification_id", "id_notification"]),
    title:
      pickString(record, ["title", "name", "subject"]) ??
      pickString(card ?? {}, ["title", "name"]),
    description: commentText,
    type: pickString(record, ["type", "notification_type"]),
    link: pickString(record, ["link", "url", "href"]),
    cardId:
      pickNumberOrString(record, ["card_id", "id_card"]) ??
      pickNumberOrString(card ?? {}, ["id_card", "card_id"]),
    cardTitle: pickString(card ?? {}, ["title", "name"]),
    flowId:
      pickNumberOrString(record, ["flow_id", "id_flow"]) ??
      pickNumberOrString(card ?? {}, ["flow_id", "id_flow"]),
    flowName: pickString(flow ?? {}, ["name", "title"]),
    currentStepId:
      pickNumberOrString(card ?? {}, ["flow_step_id", "step_id", "id_step"]) ??
      pickNumberOrString(flowStep ?? {}, ["id_step", "step_id"]),
    stepName: pickString(flowStep ?? {}, ["name", "title"]),
    responsibleUserId:
      pickNumberOrString(card ?? {}, ["user_id", "responsible_user_id"]) ??
      pickNumberOrString(responsibleUser ?? {}, ["id_user", "user_id"]),
    responsibleName: pickString(responsibleUser ?? {}, ["name"]),
    commentId:
      pickNumberOrString(record, ["card_comment_id", "comment_id"]) ??
      pickNumberOrString(comment ?? {}, ["id_card_comment", "card_comment_id"]),
    commentText,
    commentAuthorId: pickNumberOrString(commentUser ?? {}, ["id_user", "user_id"]),
    commentAuthorName: pickString(commentUser ?? {}, ["name"]),
    archived: pickBoolean(record, ["archived", "isArchived", "is_archived"]),
    read: pickBoolean(record, ["read", "isRead", "is_read"]),
    createdAt: pickString(record, ["dt_created", "created_at", "dt_create", "createdAt", "date"])
  });
}

export function summarizeFields(fields: NormalizedField[]): FieldsSummary {
  const items: FieldSummaryItem[] = fields.map((field) => ({
    id: field.id,
    name: field.name,
    title: field.title,
    description: field.description,
    type: field.type,
    // NUMBER percentual (variation "2") armazena FRAÇÃO — o formato enriquecido
    // orienta o autor do payload ANTES da escrita (bug real: 90 → "9.000,00%").
    expectedFormat:
      field.type === "NUMBER_FIELD" && field.variation === "2"
        ? "number (FRAÇÃO 0-1: 0.9 = 90% — campo percentual)"
        : getExpectedFormatByFieldType(field.type),
    required: field.required,
    formId: field.formId,
    ...(field.variation !== undefined ? { variation: field.variation } : {})
  }));

  const groupedByFormId: Record<string, number> = {};
  for (const field of fields) {
    const key = field.formId !== undefined ? String(field.formId) : "unknown";
    groupedByFormId[key] = (groupedByFormId[key] ?? 0) + 1;
  }

  return {
    total: fields.length,
    requiredCount: fields.filter((field) => field.required).length,
    groupedByFormId,
    items
  };
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumberOrString(
  record: Record<string, unknown>,
  keys: string[]
): number | string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "s" || normalized === "1" || normalized === "true") {
        return true;
      }
      if (normalized === "n" || normalized === "0" || normalized === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function pickUnknown(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asRecord).filter(isDefined);
}

function extractCardRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (direct && looksLikeCardRecord(direct)) {
    return direct;
  }

  const candidates: Record<string, unknown>[] = [];
  if (direct) {
    const nested = [direct.card, direct.data, direct.item, direct.result];
    for (const value of nested) {
      const nestedRecord = asRecord(value);
      if (nestedRecord) {
        candidates.push(nestedRecord);
      }
    }
  }

  for (const arrayItem of extractArray(raw)) {
    const arrayRecord = asRecord(arrayItem);
    if (arrayRecord) {
      candidates.push(arrayRecord);
    }
  }

  for (const candidate of candidates) {
    if (looksLikeCardRecord(candidate)) {
      return candidate;
    }
  }

  return direct ?? candidates[0];
}

function extractCardFieldValues(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const formAnswers = toRecordArray(record.form_answers);
  if (formAnswers.length === 0) {
    return undefined;
  }

  const flattened: Record<string, unknown> = {};
  for (const answer of formAnswers) {
    const answerFields = toRecordArray(answer.form_answer_fields);
    for (const answerField of answerFields) {
      const field = asRecord(answerField.field);
      const fieldId =
        pickNumberOrString(answerField, ["field_id", "id_field", "id"]) ??
        pickNumberOrString(field ?? {}, ["id_field", "field_id", "id"]);
      if (fieldId === undefined) {
        continue;
      }

      const value =
        pickUnknown(answerField, ["valueString", "value_string", "value"]) ??
        pickUnknown(answerField, ["field_option_id", "option_id"]);
      if (value === undefined) {
        continue;
      }

      flattened[String(fieldId)] = value;
    }
  }

  return Object.keys(flattened).length > 0 ? flattened : undefined;
}

function looksLikeCardRecord(record: Record<string, unknown>): boolean {
  const cardKeys = [
    "id_card",
    "card_id",
    "flow_id",
    "company_id",
    "flow_step_id",
    "status_dt_due",
    "dt_due"
  ];
  return cardKeys.some((key) => key in record);
}

function extractNotificationRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (direct && looksLikeNotificationRecord(direct)) {
    return direct;
  }

  const candidates: Record<string, unknown>[] = [];
  if (direct) {
    const nested = [direct.notification, direct.data, direct.item, direct.result];
    for (const value of nested) {
      const nestedRecord = asRecord(value);
      if (nestedRecord) {
        candidates.push(nestedRecord);
      }
    }
  }

  for (const arrayItem of extractArray(raw)) {
    const arrayRecord = asRecord(arrayItem);
    if (arrayRecord) {
      candidates.push(arrayRecord);
    }
  }

  for (const candidate of candidates) {
    if (looksLikeNotificationRecord(candidate)) {
      return candidate;
    }
  }

  return direct ?? candidates[0];
}

function looksLikeNotificationRecord(record: Record<string, unknown>): boolean {
  const notificationKeys = [
    "id_notification",
    "notification_id",
    "card_comment_id",
    "dt_created",
    "type"
  ];
  return notificationKeys.some((key) => key in record);
}

function compactDefined<T extends Record<string, unknown>>(record: T): T {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact as T;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
