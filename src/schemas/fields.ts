import { z } from "zod";

import { parseRequiredLike } from "./common.js";

export const getFieldsByFlowParamsSchema = z.object({
  flowId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
});

export const getFieldsByRegisterParamsSchema = z.object({
  registerId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  typeFilter: z.string().optional(),
  withChildren: z.union([z.boolean(), z.string().trim().min(1)]).optional()
});

export interface NormalizedField {
  id?: number | string;
  name: string;
  title?: string;
  description?: string;
  type: string;
  required: boolean;
  formId?: number | string;
  options?: unknown;
  raw: Record<string, unknown>;
}

export function normalizeFieldsFromApiResponse(raw: unknown): NormalizedField[] {
  const records = extractRawFieldRecords(raw);
  return records
    .map((item) => normalizeSingleField(item))
    .filter((item): item is NormalizedField => item !== undefined);
}

function extractRawFieldRecords(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }

  if (!isRecord(raw)) {
    return [];
  }

  const candidates: unknown[] = [raw.fields, raw.items, raw.data, raw.results, raw.list];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }

    if (isRecord(candidate)) {
      const nestedArrayCandidates = [candidate.fields, candidate.items, candidate.data, candidate.list];
      for (const nested of nestedArrayCandidates) {
        if (Array.isArray(nested)) {
          return nested.filter(isRecord);
        }
      }
    }
  }

  return [];
}

function normalizeSingleField(item: Record<string, unknown>): NormalizedField | undefined {
  const name = pickString(item, ["name", "field_name", "key"]);
  const type = pickString(item, ["type", "field_type", "fieldType"]);
  if (!name || !type) {
    return undefined;
  }

  const id = pickNumberOrString(item, ["id", "field_id", "id_field"]);
  const title = pickString(item, ["title", "name_label", "label"]);
  const description = pickString(item, ["description", "help_text", "placeholder"]);
  const requiredRaw = pickUnknown(item, ["required", "is_required", "mandatory"]);
  const formId = pickNumberOrString(item, ["form_id", "formId", "id_form"]);
  const options = pickUnknown(item, ["options", "choices", "values_options", "items"]);

  return {
    id,
    name,
    title,
    description,
    type,
    required: parseRequiredLike(requiredRaw),
    formId,
    options,
    raw: item
  };
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function pickNumberOrString(
  record: Record<string, unknown>,
  keys: string[]
): number | string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
