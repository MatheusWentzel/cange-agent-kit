import type { NormalizedField } from "../schemas/fields.js";

import type {
  CardSummary,
  FieldSummaryItem,
  FieldsSummary,
  FlowSummary,
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
  const record = extractPrimaryRecord(raw);
  if (!record) {
    return {};
  }

  return {
    cardId: pickNumberOrString(record, ["id", "card_id", "id_card"]),
    flowId: pickNumberOrString(record, ["flow_id", "id_flow"]),
    companyId: pickNumberOrString(record, ["company_id", "id_company"]),
    currentStepId: pickNumberOrString(record, ["step_id", "id_step", "current_step_id"]),
    dueDate: pickString(record, ["dt_due", "due_date"]),
    responsibleUserId: pickNumberOrString(record, ["user_id", "responsible_user_id"]),
    archived: pickBoolean(record, ["archived"]),
    complete: pickBoolean(record, ["complete"])
  };
}

export function summarizeFields(fields: NormalizedField[]): FieldsSummary {
  const items: FieldSummaryItem[] = fields.map((field) => ({
    id: field.id,
    name: field.name,
    label: field.label,
    title: field.title,
    type: field.type,
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
