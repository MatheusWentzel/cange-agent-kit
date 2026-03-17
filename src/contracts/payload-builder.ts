import { CangeValidationError } from "../client/errors.js";
import type { NormalizedField } from "../schemas/fields.js";
import { getExpectedFormatByFieldType, validateValueByFieldType } from "../utils/fieldTypeGuards.js";
import { getRequiredFields } from "../utils/requiredFields.js";
import { buildValuesSkeleton } from "../utils/valuesBuilder.js";

import { filterFieldsByForm, type FieldsContracts } from "./fields.js";
import type { FlowsContracts } from "./flows.js";
import type { RegistersContracts } from "./registers.js";
import { asRecord, extractPrimaryRecord, summarizeFields } from "./raw-adapters.js";
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
  getFlowStepFormFields: (input: { flowId: number | string; stepId: number | string }) => Promise<{
    formId?: number | string;
    step?: FlowStepSummary;
    fields: NormalizedField[];
    raw: { flow: unknown; fields: unknown };
  }>;
  getRegisterFormFields: (input: { registerId: number | string }) => Promise<{
    formId?: number | string;
    fields: NormalizedField[];
    raw: { register: unknown; fields: unknown };
  }>;
  getRequiredFlowFields: (input: { flowId: number | string }) => Promise<NormalizedField[]>;
  getRequiredFlowStepFields: (input: {
    flowId: number | string;
    stepId: number | string;
  }) => Promise<NormalizedField[]>;
  getRequiredRegisterFields: (input: { registerId: number | string }) => Promise<NormalizedField[]>;
  buildCardCreationTemplate: (input: { flowId: number | string }) => Promise<ValuesTemplateResult>;
  buildCardStepMoveTemplate: (input: {
    flowId: number | string;
    fromStepId: number | string;
    toStepId: number | string;
  }) => Promise<StepMoveTemplateResult>;
  buildRegisterCreationTemplate: (input: { registerId: number | string }) => Promise<ValuesTemplateResult>;
  validateValuesAgainstFields: (input: ValidateValuesInput) => ValidationResult;
}

export interface FlowStepSummary {
  id?: number | string;
  name?: string;
  formId?: number | string;
  index?: number | string;
  raw: Record<string, unknown>;
}

export interface StepMoveTemplateResult extends ValuesTemplateResult {
  fromStep?: FlowStepSummary;
  toStep?: FlowStepSummary;
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

    async getFlowStepFormFields(input) {
      const flowData = await flows.getFlow({ idFlow: String(input.flowId) });
      const step = findFlowStep(flowData.raw, input.stepId);
      if (!step) {
        throw new CangeValidationError(
          "Não foi possível localizar a etapa no flow para descobrir o formulário da movimentação.",
          {
            details: {
              flowId: input.flowId,
              stepId: input.stepId
            }
          }
        );
      }

      const formId = step.formId;
      if (formId === undefined) {
        throw new CangeValidationError(
          "Etapa sem form_id. Não foi possível descobrir o formulário da movimentação.",
          {
            details: {
              flowId: input.flowId,
              stepId: input.stepId,
              stepName: step.name
            }
          }
        );
      }

      const fieldSet = await fields.getFieldsByFlow({ flowId: input.flowId });
      const formFields = filterFieldsByForm(fieldSet.fields, formId);
      return {
        formId,
        step,
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

    async getRequiredFlowStepFields(input) {
      const data = await this.getFlowStepFormFields(input);
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

    async buildCardStepMoveTemplate(input) {
      const flowData = await flows.getFlow({ idFlow: String(input.flowId) });
      const fromStep = findFlowStep(flowData.raw, input.fromStepId);
      if (!fromStep) {
        throw new CangeValidationError("Etapa de origem não encontrada no flow.", {
          details: {
            flowId: input.flowId,
            fromStepId: input.fromStepId
          }
        });
      }

      const toStep = findFlowStep(flowData.raw, input.toStepId);
      if (!toStep) {
        throw new CangeValidationError("Etapa de destino não encontrada no flow.", {
          details: {
            flowId: input.flowId,
            toStepId: input.toStepId
          }
        });
      }

      if (fromStep.formId === undefined) {
        throw new CangeValidationError("Etapa de origem sem form_id para movimentação.", {
          details: {
            flowId: input.flowId,
            fromStepId: input.fromStepId,
            fromStepName: fromStep.name
          }
        });
      }

      const fieldSet = await fields.getFieldsByFlow({ flowId: input.flowId });
      const formFields = filterFieldsByForm(fieldSet.fields, fromStep.formId);

      return {
        context: {
          kind: "flow-step-move",
          flowId: input.flowId,
          formId: fromStep.formId,
          fromStepId: input.fromStepId,
          toStepId: input.toStepId
        },
        requiredFields: getRequiredFields(formFields).map(toFieldSummary),
        optionalFields: formFields.filter((item) => !item.required).map(toFieldSummary),
        payloadSkeleton: {
          flowId: input.flowId,
          cardId: "<CARD_ID>",
          fromStepId: input.fromStepId,
          toStepId: input.toStepId,
          idForm: fromStep.formId,
          values: buildValuesSkeleton(formFields),
          complete: "N",
          isFromCurrentStep: true,
          isTestMode: false
        },
        flowSummary: flowData.summary,
        fieldsSummary: summarizeFields(formFields),
        fromStep,
        toStep
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
        fieldTitle: originalField?.title,
        message: originalField
          ? `O campo ${formatFieldReference(key, originalField.title)} não pertence ao formulário alvo.`
          : `O campo "${key}" não existe na estrutura consultada.`
      });
      continue;
    }

    const typeValidation = validateValueByFieldType(field.type, value, field.options);
    if (typeValidation.expected === "unknown") {
      issues.push({
        code: "UNKNOWN_FIELD_TYPE",
        fieldName: key,
        fieldTitle: field.title,
        message: `Tipo de field não suportado para validação: ${field.type}.`,
        expected: "unknown"
      });
      continue;
    }

    if (!typeValidation.valid) {
      if (typeValidation.allowedOptions && typeValidation.allowedOptions.length > 0) {
        const optionsDescription = typeValidation.allowedOptions
          .map((option) =>
            option.label
              ? `"${String(option.value)}" (${option.label})`
              : `"${String(option.value)}"`
          )
          .join(", ");
        const sentValue =
          typeof value === "string" || typeof value === "number"
            ? `"${String(value)}"`
            : JSON.stringify(value);

        issues.push({
          code: "INVALID_OPTION",
          fieldName: key,
          fieldTitle: field.title,
          message: `Valor inválido para ${formatFieldReference(
            key,
            field.title
          )}: ${sentValue}. Opções válidas: ${optionsDescription}.`,
          expected: `one of [${optionsDescription}]`,
          receivedType: describeValueType(value)
        });
        continue;
      }

      issues.push({
        code: "INVALID_TYPE",
        fieldName: key,
        fieldTitle: field.title,
        message: `Tipo inválido para ${formatFieldReference(
          key,
          field.title
        )}. Esperado: ${typeValidation.expected}.`,
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
          fieldTitle: field.title,
          message: `Campo obrigatório ausente: ${formatFieldReference(field.name, field.title)}.`
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

function formatFieldReference(fieldName: string, fieldTitle?: string): string {
  if (fieldTitle && fieldTitle.trim().length > 0) {
    return `"${fieldTitle}" (${fieldName})`;
  }
  return `"${fieldName}"`;
}

function findFlowStep(flowRaw: unknown, stepId: number | string): FlowStepSummary | undefined {
  const targetId = String(stepId);
  const steps = extractFlowSteps(flowRaw);
  return steps.find((step) => step.id !== undefined && String(step.id) === targetId);
}

function extractFlowSteps(flowRaw: unknown): FlowStepSummary[] {
  const roots: Array<Record<string, unknown>> = [];
  const direct = asRecord(flowRaw);
  const primary = extractPrimaryRecord(flowRaw);

  if (direct) {
    roots.push(direct);
  }
  if (primary) {
    roots.push(primary);
  }
  if (direct) {
    const nestedDirectRoots = [asRecord(direct.data), asRecord(direct.item), asRecord(direct.flow)];
    roots.push(...nestedDirectRoots.filter((item): item is Record<string, unknown> => item !== undefined));
  }
  if (primary) {
    const nestedPrimaryRoots = [asRecord(primary.data), asRecord(primary.flow)];
    roots.push(...nestedPrimaryRoots.filter((item): item is Record<string, unknown> => item !== undefined));
  }

  const records: Record<string, unknown>[] = [];
  const seenSerialized = new Set<string>();
  for (const root of roots) {
    for (const record of extractStepRecordsFromRoot(root)) {
      const key = JSON.stringify(record);
      if (!seenSerialized.has(key)) {
        seenSerialized.add(key);
        records.push(record);
      }
    }
  }

  return records
    .map((record): FlowStepSummary | undefined => {
      const id = pickStepValue(record, ["id_step", "step_id", "id", "id_flow_step"]);
      if (id === undefined) {
        return undefined;
      }
      return {
        id,
        name: pickStepString(record, ["name", "title"]),
        formId: pickStepValue(record, ["form_id", "id_form", "formId"]),
        index: pickStepValue(record, ["index", "step_index"]),
        raw: record
      };
    })
    .filter((item): item is FlowStepSummary => item !== undefined);
}

function extractStepRecordsFromRoot(root: Record<string, unknown>): Record<string, unknown>[] {
  const arraysByKnownKeys = ["flow_steps", "steps", "flowSteps", "stages", "etapas"];
  const records: Record<string, unknown>[] = [];

  for (const key of arraysByKnownKeys) {
    records.push(...toRecordArray(root[key]));
  }

  for (const value of Object.values(root)) {
    if (Array.isArray(value)) {
      const arrayRecords = toRecordArray(value).filter(looksLikeStepRecord);
      records.push(...arrayRecords);
    }
  }

  return records.filter(looksLikeStepRecord);
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

function looksLikeStepRecord(record: Record<string, unknown>): boolean {
  return ["id_step", "step_id", "id_flow_step", "form_id", "id_form"].some((key) => key in record);
}

function pickStepValue(
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

function pickStepString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function toFieldSummary(field: NormalizedField): FieldSummaryItem {
  return {
    id: field.id,
    name: field.name,
    title: field.title,
    description: field.description,
    type: field.type,
    expectedFormat: getExpectedFormatByFieldType(field.type),
    required: field.required,
    formId: field.formId
  };
}
