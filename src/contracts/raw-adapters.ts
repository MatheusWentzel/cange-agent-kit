import type { NormalizedField } from "../schemas/fields.js";
import { getExpectedFormatByFieldType } from "../utils/fieldTypeGuards.js";

import type {
  CardSummary,
  FieldSummaryItem,
  FieldsSummary,
  FlowSummary,
  NotificationSummary,
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
    expectedFormat: getExpectedFormatByFieldType(field.type),
    required: field.required,
    formId: field.formId
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
