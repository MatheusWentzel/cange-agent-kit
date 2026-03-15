import type { NormalizedField } from "../schemas/fields.js";

export function getRequiredFields(fields: NormalizedField[]): NormalizedField[] {
  return fields.filter((field) => field.required);
}

export function filterFieldsByFormId(
  fields: NormalizedField[],
  formId: number | string | undefined
): NormalizedField[] {
  if (formId === undefined) {
    return fields;
  }
  return fields.filter((field) => String(field.formId) === String(formId));
}
