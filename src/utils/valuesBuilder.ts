import type { NormalizedField } from "../schemas/fields.js";

export function buildValuesSkeleton(fields: NormalizedField[]): Record<string, string> {
  const skeleton: Record<string, string> = {};
  for (const field of fields) {
    skeleton[field.name] = `<${normalizePlaceholder(field.type)}>`;
  }
  return skeleton;
}

function normalizePlaceholder(type: string): string {
  const normalized = type.trim().replace(/\s+/g, "_").toUpperCase();
  return normalized.length > 0 ? normalized : "VALUE";
}
