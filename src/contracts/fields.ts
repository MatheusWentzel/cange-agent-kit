import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  getFieldsByFlowParamsSchema,
  getFieldsByRegisterParamsSchema,
  normalizeFieldsFromApiResponse,
  type NormalizedField
} from "../schemas/fields.js";

import { summarizeFields } from "./raw-adapters.js";
import type { FieldSetWithRaw } from "./types.js";

export interface FieldsContracts {
  getFieldsByFlow: (input: { flowId: string | number }) => Promise<FieldSetWithRaw>;
  getFieldsByRegister: (input: {
    registerId: string | number;
    typeFilter?: string;
    withChildren?: string | boolean;
  }) => Promise<FieldSetWithRaw>;
}

export function createFieldsContracts(client: CangeClient): FieldsContracts {
  return {
    async getFieldsByFlow(input) {
      const parsed = getFieldsByFlowParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getFieldsByFlow.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/field/by-flow", {
        query: {
          flow_id: String(parsed.data.flowId)
        }
      });

      return toFieldSet(raw);
    },

    async getFieldsByRegister(input) {
      const parsed = getFieldsByRegisterParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getFieldsByRegister.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/field/by-register", {
        query: {
          register_id: String(parsed.data.registerId),
          typeFilter: parsed.data.typeFilter,
          withChildren:
            typeof parsed.data.withChildren === "boolean"
              ? String(parsed.data.withChildren)
              : parsed.data.withChildren
        }
      });

      return toFieldSet(raw);
    }
  };
}

function toFieldSet(raw: unknown): FieldSetWithRaw {
  const fields = normalizeFieldsFromApiResponse(raw);
  return {
    raw,
    fields,
    summary: summarizeFields(fields)
  };
}

export function filterFieldsByForm(
  fields: NormalizedField[],
  formId: number | string | undefined
): NormalizedField[] {
  if (formId === undefined) {
    return fields;
  }
  return fields.filter((field) => String(field.formId) === String(formId));
}
