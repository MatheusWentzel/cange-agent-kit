import { createHash, randomBytes } from "node:crypto";

import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  type CreateFieldPayload,
  type CreateFlowPayload,
  type CreateStepPayload,
  type FieldOptionPayload,
  type PatchFieldPayload,
  type ReorderStepPayload,
  type StepRelationshipBodyPayload,
  type UpdateFlowPayload,
  type UpdateStepPayload,
  createFieldPayloadSchema,
  createFlowPayloadSchema,
  createStepPayloadSchema,
  fieldTypeParamSchema,
  idFlowFieldParamSchema,
  idFlowFormFieldParamSchema,
  idFlowFormParamSchema,
  idFlowParamSchema,
  idFlowStepFieldParamSchema,
  idFlowStepParamSchema,
  patchFieldPayloadSchema,
  reorderStepPayloadSchema,
  stepRelationshipBodySchema,
  stepRelationshipFromQuerySchema,
  updateFlowPayloadSchema,
  updateStepPayloadSchema
} from "../schemas/flowV2Build.js";
import { toNumber } from "../schemas/common.js";

const BUILD_PREFIX = "/flow/v2/build";

function flowPath(idFlow: number | string, suffix = ""): string {
  return `${BUILD_PREFIX}/flows/${toNumber(idFlow)}${suffix}`;
}

function failValidation(message: string, details: unknown): never {
  throw new CangeValidationError(message, { details });
}

/**
 * CR-1 — serializa `options[].order` para string na borda do contrato.
 *
 * O servidor da Flow V2 Build API espera `order` como string; o schema local
 * aceita number OU string numérica (ver `orderSchema` em `schemas/flowV2Build.ts`)
 * para não vazar essa exigência ao chamador. Aqui, imediatamente antes do
 * `client.post`/`client.patch`, convertemos cada `order` presente para
 * `String(order)`. Options sem `order` ficam intactas (o servidor preenche pela
 * posição). Centralizar num único helper evita divergência entre os 5 pontos
 * que enviam options (2 create + 3 patch).
 */
function serializeFieldOptions<T extends { options?: FieldOptionPayload[] }>(payload: T): T {
  if (!payload.options) {
    return payload;
  }
  return {
    ...payload,
    options: payload.options.map((option) =>
      option.order === undefined ? option : { ...option, order: String(option.order) }
    )
  };
}

const HASH_NAME_RE = /^[0-9a-f]{40}$/;

// O front do Cange espera field.name como hash de 40 hex (sha1) — campos nativos
// são gerados assim. Nome legível (ex: "status_geral") quebra o editor de
// formulário do front. Se o caller passar um name fora desse formato, geramos um
// hash único aqui; o caller deve ler o name resultante na resposta do create.
function ensureHashName<T extends { name?: string }>(payload: T): T {
  // Sem name (ex: patch que não altera o name) ou já é hash → não mexe.
  // Só normaliza quando vem um name fora do formato (ex: create com nome legível).
  if (!payload.name || HASH_NAME_RE.test(payload.name)) {
    return payload;
  }
  const seed = `${payload.name}:${Date.now()}:${randomBytes(8).toString("hex")}`;
  return { ...payload, name: createHash("sha1").update(seed).digest("hex") };
}

export interface FlowV2BuildContracts {
  ping: () => Promise<{ raw: unknown }>;
  listFieldTypes: () => Promise<{ raw: unknown; types: string[]; schemaVersion?: number }>;
  getFieldTypeDescriptor: (input: { type: string }) => Promise<{ raw: unknown }>;
  createFlow: (payload: CreateFlowPayload) => Promise<{ raw: unknown }>;
  updateFlow: (input: { idFlow: number | string; payload: UpdateFlowPayload }) => Promise<{
    raw: unknown;
  }>;
  createStep: (input: { idFlow: number | string; payload: CreateStepPayload }) => Promise<{
    raw: unknown;
  }>;
  updateStep: (input: {
    idFlow: number | string;
    idStep: number | string;
    payload: UpdateStepPayload;
  }) => Promise<{ raw: unknown }>;
  reorderStep: (input: { idFlow: number | string; payload: ReorderStepPayload }) => Promise<{
    raw: unknown;
  }>;
  createFieldByStep: (input: {
    idFlow: number | string;
    idStep: number | string;
    payload: CreateFieldPayload;
  }) => Promise<{ raw: unknown }>;
  createFieldByForm: (input: {
    idFlow: number | string;
    formId: number | string;
    payload: CreateFieldPayload;
  }) => Promise<{ raw: unknown }>;
  patchFieldByFlow: (input: {
    idFlow: number | string;
    idField: number | string;
    payload: PatchFieldPayload;
  }) => Promise<{ raw: unknown }>;
  patchFieldByStep: (input: {
    idFlow: number | string;
    idStep: number | string;
    idField: number | string;
    payload: PatchFieldPayload;
  }) => Promise<{ raw: unknown }>;
  patchFieldByForm: (input: {
    idFlow: number | string;
    formId: number | string;
    idField: number | string;
    payload: PatchFieldPayload;
  }) => Promise<{ raw: unknown }>;
  deleteFieldByFlow: (input: {
    idFlow: number | string;
    idField: number | string;
  }) => Promise<{ raw: unknown }>;
  deleteFieldByStep: (input: {
    idFlow: number | string;
    idStep: number | string;
    idField: number | string;
  }) => Promise<{ raw: unknown }>;
  listStepRelationshipsByFlow: (input: { idFlow: number | string }) => Promise<{ raw: unknown }>;
  listStepRelationshipsFromStep: (input: {
    idFlow: number | string;
    idStep: number | string;
  }) => Promise<{ raw: unknown }>;
  upsertStepRelationship: (input: {
    idFlow: number | string;
    payload: StepRelationshipBodyPayload;
  }) => Promise<{ raw: unknown }>;
}

export function createFlowV2BuildContracts(client: CangeClient): FlowV2BuildContracts {
  return {
    async ping() {
      const raw = await client.get<unknown>(`${BUILD_PREFIX}/__ping`);
      return { raw };
    },

    async listFieldTypes() {
      const raw = await client.get<unknown>(`${BUILD_PREFIX}/field-types`);
      const record = (raw ?? {}) as { types?: unknown; schema_version?: unknown };
      const types = Array.isArray(record.types)
        ? record.types.filter((value): value is string => typeof value === "string")
        : [];
      const schemaVersion =
        typeof record.schema_version === "number" ? record.schema_version : undefined;
      return { raw, types, schemaVersion };
    },

    async getFieldTypeDescriptor(input) {
      const parsed = fieldTypeParamSchema.safeParse(input);
      if (!parsed.success) {
        failValidation("Parâmetro inválido para getFieldTypeDescriptor.", parsed.error.format());
      }
      const raw = await client.get<unknown>(
        `${BUILD_PREFIX}/field-types/${encodeURIComponent(parsed.data.type)}`
      );
      return { raw };
    },

    async createFlow(payload) {
      const parsed = createFlowPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        failValidation("Payload inválido para createFlow.", parsed.error.format());
      }
      const raw = await client.post<unknown>(`${BUILD_PREFIX}/flows`, {
        body: parsed.data
      });
      return { raw };
    },

    async updateFlow(input) {
      const params = idFlowParamSchema.safeParse({ idFlow: input.idFlow });
      if (!params.success) {
        failValidation("Parâmetro inválido para updateFlow.", params.error.format());
      }
      const body = updateFlowPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para updateFlow.", body.error.format());
      }
      const raw = await client.patch<unknown>(flowPath(params.data.idFlow), {
        body: body.data
      });
      return { raw };
    },

    async createStep(input) {
      const params = idFlowParamSchema.safeParse({ idFlow: input.idFlow });
      if (!params.success) {
        failValidation("Parâmetro inválido para createStep.", params.error.format());
      }
      const body = createStepPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para createStep.", body.error.format());
      }
      const raw = await client.post<unknown>(flowPath(params.data.idFlow, "/steps"), {
        body: body.data
      });
      return { raw };
    },

    async updateStep(input) {
      const params = idFlowStepParamSchema.safeParse({
        idFlow: input.idFlow,
        idStep: input.idStep
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para updateStep.", params.error.format());
      }
      const body = updateStepPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para updateStep.", body.error.format());
      }
      const raw = await client.patch<unknown>(
        flowPath(params.data.idFlow, `/steps/${toNumber(params.data.idStep)}`),
        { body: body.data }
      );
      return { raw };
    },

    async reorderStep(input) {
      const params = idFlowParamSchema.safeParse({ idFlow: input.idFlow });
      if (!params.success) {
        failValidation("Parâmetro inválido para reorderStep.", params.error.format());
      }
      const body = reorderStepPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para reorderStep.", body.error.format());
      }
      const raw = await client.post<unknown>(flowPath(params.data.idFlow, "/steps/reorder"), {
        body: body.data
      });
      return { raw };
    },

    async createFieldByStep(input) {
      const params = idFlowStepParamSchema.safeParse({
        idFlow: input.idFlow,
        idStep: input.idStep
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para createFieldByStep.", params.error.format());
      }
      const body = createFieldPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para createFieldByStep.", body.error.format());
      }
      const raw = await client.post<unknown>(
        flowPath(params.data.idFlow, `/steps/${toNumber(params.data.idStep)}/fields`),
        { body: serializeFieldOptions(ensureHashName(body.data)) }
      );
      return { raw };
    },

    async createFieldByForm(input) {
      const params = idFlowFormParamSchema.safeParse({
        idFlow: input.idFlow,
        formId: input.formId
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para createFieldByForm.", params.error.format());
      }
      const body = createFieldPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para createFieldByForm.", body.error.format());
      }
      const raw = await client.post<unknown>(
        flowPath(params.data.idFlow, `/forms/${toNumber(params.data.formId)}/fields`),
        { body: serializeFieldOptions(ensureHashName(body.data)) }
      );
      return { raw };
    },

    async patchFieldByFlow(input) {
      const params = idFlowFieldParamSchema.safeParse({
        idFlow: input.idFlow,
        idField: input.idField
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para patchFieldByFlow.", params.error.format());
      }
      const body = patchFieldPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para patchFieldByFlow.", body.error.format());
      }
      const raw = await client.patch<unknown>(
        flowPath(params.data.idFlow, `/fields/${toNumber(params.data.idField)}`),
        { body: serializeFieldOptions(ensureHashName(body.data)) }
      );
      return { raw };
    },

    async patchFieldByStep(input) {
      const params = idFlowStepFieldParamSchema.safeParse({
        idFlow: input.idFlow,
        idStep: input.idStep,
        idField: input.idField
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para patchFieldByStep.", params.error.format());
      }
      const body = patchFieldPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para patchFieldByStep.", body.error.format());
      }
      const raw = await client.patch<unknown>(
        flowPath(
          params.data.idFlow,
          `/steps/${toNumber(params.data.idStep)}/fields/${toNumber(params.data.idField)}`
        ),
        { body: serializeFieldOptions(ensureHashName(body.data)) }
      );
      return { raw };
    },

    async patchFieldByForm(input) {
      const params = idFlowFormFieldParamSchema.safeParse({
        idFlow: input.idFlow,
        formId: input.formId,
        idField: input.idField
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para patchFieldByForm.", params.error.format());
      }
      const body = patchFieldPayloadSchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para patchFieldByForm.", body.error.format());
      }
      const raw = await client.patch<unknown>(
        flowPath(
          params.data.idFlow,
          `/forms/${toNumber(params.data.formId)}/fields/${toNumber(params.data.idField)}`
        ),
        { body: serializeFieldOptions(ensureHashName(body.data)) }
      );
      return { raw };
    },

    async deleteFieldByFlow(input) {
      const params = idFlowFieldParamSchema.safeParse({
        idFlow: input.idFlow,
        idField: input.idField
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para deleteFieldByFlow.", params.error.format());
      }
      const raw = await client.delete<unknown>(
        flowPath(params.data.idFlow, `/fields/${toNumber(params.data.idField)}`)
      );
      return { raw };
    },

    async deleteFieldByStep(input) {
      const params = idFlowStepFieldParamSchema.safeParse({
        idFlow: input.idFlow,
        idStep: input.idStep,
        idField: input.idField
      });
      if (!params.success) {
        failValidation("Parâmetros inválidos para deleteFieldByStep.", params.error.format());
      }
      const raw = await client.delete<unknown>(
        flowPath(
          params.data.idFlow,
          `/steps/${toNumber(params.data.idStep)}/fields/${toNumber(params.data.idField)}`
        )
      );
      return { raw };
    },

    async listStepRelationshipsByFlow(input) {
      const params = idFlowParamSchema.safeParse({ idFlow: input.idFlow });
      if (!params.success) {
        failValidation("Parâmetro inválido para listStepRelationshipsByFlow.", params.error.format());
      }
      const raw = await client.get<unknown>(
        flowPath(params.data.idFlow, "/step-relationships/by-flow")
      );
      return { raw };
    },

    async listStepRelationshipsFromStep(input) {
      const params = stepRelationshipFromQuerySchema.safeParse({
        idFlow: input.idFlow,
        idStep: input.idStep
      });
      if (!params.success) {
        failValidation(
          "Parâmetros inválidos para listStepRelationshipsFromStep.",
          params.error.format()
        );
      }
      const raw = await client.get<unknown>(
        flowPath(params.data.idFlow, "/step-relationships"),
        { query: { id_step: toNumber(params.data.idStep) } }
      );
      return { raw };
    },

    async upsertStepRelationship(input) {
      const params = idFlowParamSchema.safeParse({ idFlow: input.idFlow });
      if (!params.success) {
        failValidation("Parâmetro inválido para upsertStepRelationship.", params.error.format());
      }
      const body = stepRelationshipBodySchema.safeParse(input.payload);
      if (!body.success) {
        failValidation("Payload inválido para upsertStepRelationship.", body.error.format());
      }
      const raw = await client.post<unknown>(
        flowPath(params.data.idFlow, "/step-relationships"),
        { body: body.data }
      );
      return { raw };
    }
  };
}
