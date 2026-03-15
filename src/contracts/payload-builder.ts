import { CangeValidationError } from "../client/errors.js";
import type { NormalizedField } from "../schemas/fields.js";
import { validateValueByFieldType } from "../utils/fieldTypeGuards.js";
import { getRequiredFields } from "../utils/requiredFields.js";
import { buildValuesSkeleton } from "../utils/valuesBuilder.js";

import { filterFieldsByForm, type FieldsContracts } from "./fields.js";
import type { FlowsContracts } from "./flows.js";
import type { RegistersContracts } from "./registers.js";
import { summarizeFields } from "./raw-adapters.js";
import type { FieldSummaryItem, ValidationIssue, ValidationResult, ValuesTemplateResult } from "./types.js";

export interface ValidateValuesInput {
  values: Record<string, unknown>;
  fields: NormalizedField[];
  requireRequiredFields: boolean;
  targetFormId?: number | string;
}

export interface PayloadBuilderContracts {
  getFlowInitFormFields: (input: { flowId: number | string }) => Promise<{
    formId?: number | string;
    fields: NormalizedField[];
    raw: { flow: unknown; fields: unknown };
  }>;
  getRegisterFormFields: (input: { registerId: number | string }) => Promise<{
    formId?: number | string;
    fields: NormalizedField[];
    raw: { register: unknown; fields: unknown };
  }>;
  getRequiredFlowFields: (input: { flowId: number | string }) => Promise<NormalizedField[]>;
  getRequiredRegisterFields: (input: { registerId: number | string }) => Promise<NormalizedField[]>;
  buildCardCreationTemplate: (input: { flowId: number | string }) => Promise<ValuesTemplateResult>;
  buildRegisterCreationTemplate: (input: { registerId: number | string }) => Promise<ValuesTemplateResult>;
  validateValuesAgainstFields: (input: ValidateValuesInput) => ValidationResult;
}

export function createPayloadBuilderContracts(params: {
  flows: FlowsContracts;
  fields: FieldsContracts;
  registers: RegistersContracts;
}): PayloadBuilderContracts {
  const { flows, fields, registers } = params;

  return {
    async getFlowInitFormFields(input) {
      const flowData = await flows.getFlow({ idFlow: String(input.flowId) });
      const formId = flowData.summary.formInitId;
      if (formId === undefined) {
        throw new CangeValidationError(
          "Flow sem form_init_id. Não foi possível descobrir o formulário inicial."
        );
      }

      const fieldSet = await fields.getFieldsByFlow({ flowId: input.flowId });
      const formFields = filterFieldsByForm(fieldSet.fields, formId);
      return {
        formId,
        fields: formFields,
        raw: { flow: flowData.raw, fields: fieldSet.raw }
      };
    },

    async getRegisterFormFields(input) {
      const registerData = await registers.getRegister({ idRegister: String(input.registerId) });
      const formId = registerData.summary.formId;
      if (formId === undefined) {
        throw new CangeValidationError(
          "Register sem form_id. Não foi possível descobrir o formulário base."
        );
      }

      const fieldSet = await fields.getFieldsByRegister({ registerId: input.registerId });
      const formFields = filterFieldsByForm(fieldSet.fields, formId);
      return {
        formId,
        fields: formFields,
        raw: { register: registerData.raw, fields: fieldSet.raw }
      };
    },

    async getRequiredFlowFields(input) {
      const data = await this.getFlowInitFormFields(input);
      return getRequiredFields(data.fields);
    },

    async getRequiredRegisterFields(input) {
      const data = await this.getRegisterFormFields(input);
      return getRequiredFields(data.fields);
    },

    async buildCardCreationTemplate(input) {
      const flowData = await flows.getFlow({ idFlow: String(input.flowId) });
      const { formId, fields: formFields } = await this.getFlowInitFormFields(input);
      return {
        context: {
          kind: "flow",
          flowId: input.flowId,
          formId
        },
        requiredFields: getRequiredFields(formFields).map(toFieldSummary),
        optionalFields: formFields.filter((item) => !item.required).map(toFieldSummary),
        payloadSkeleton: {
          idForm: formId,
          flowId: input.flowId,
          origin: "/cange-agent-kit",
          values: buildValuesSkeleton(formFields)
        },
        flowSummary: flowData.summary,
        fieldsSummary: summarizeFields(formFields)
      };
    },

    async buildRegisterCreationTemplate(input) {
      const registerData = await registers.getRegister({ idRegister: String(input.registerId) });
      const { formId, fields: formFields } = await this.getRegisterFormFields(input);
      return {
        context: {
          kind: "register",
          registerId: input.registerId,
          formId
        },
        requiredFields: getRequiredFields(formFields).map(toFieldSummary),
        optionalFields: formFields.filter((item) => !item.required).map(toFieldSummary),
        payloadSkeleton: {
          idForm: formId,
          origin: "/cange-agent-kit",
          values: buildValuesSkeleton(formFields)
        },
        registerSummary: registerData.summary,
        fieldsSummary: summarizeFields(formFields)
      };
    },

    validateValuesAgainstFields(input) {
      return validateValuesAgainstFields(input);
    }
  };
}

export function validateValuesAgainstFields(input: ValidateValuesInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalizedValues: Record<string, unknown> = {};
  const fieldsInScope = filterFieldsByForm(input.fields, input.targetFormId);
  const fieldByName = new Map(fieldsInScope.map((field) => [field.name, field]));

  for (const [key, value] of Object.entries(input.values)) {
    const field = fieldByName.get(key);
    if (!field) {
      const originalField = input.fields.find((item) => item.name === key);
      issues.push({
        code: originalField ? "FIELD_OUT_OF_FORM" : "UNKNOWN_FIELD",
        fieldName: key,
        message: originalField
          ? `O campo "${key}" não pertence ao formulário alvo.`
          : `O campo "${key}" não existe na estrutura consultada.`
      });
      continue;
    }

    const typeValidation = validateValueByFieldType(field.type, value);
    if (typeValidation.expected === "unknown") {
      issues.push({
        code: "UNKNOWN_FIELD_TYPE",
        fieldName: key,
        message: `Tipo de field não suportado para validação: ${field.type}.`,
        expected: "unknown"
      });
      continue;
    }

    if (!typeValidation.valid) {
      issues.push({
        code: "INVALID_TYPE",
        fieldName: key,
        message: `Tipo inválido para "${key}". Esperado: ${typeValidation.expected}.`,
        expected: typeValidation.expected,
        receivedType: describeValueType(value)
      });
      continue;
    }

    normalizedValues[key] = value;
  }

  if (input.requireRequiredFields) {
    for (const field of fieldsInScope.filter((item) => item.required)) {
      if (!(field.name in input.values) || isMissingValue(input.values[field.name])) {
        issues.push({
          code: "MISSING_REQUIRED",
          fieldName: field.name,
          message: `Campo obrigatório ausente: "${field.name}".`
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    normalizedValues
  };
}

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function toFieldSummary(field: NormalizedField): FieldSummaryItem {
  return {
    id: field.id,
    name: field.name,
    title: field.title,
    description: field.description,
    type: field.type,
    required: field.required,
    formId: field.formId
  };
}
