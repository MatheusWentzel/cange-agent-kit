import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { toNumber } from "../schemas/common.js";
import {
  getRegisterEngineStatusParamsSchema,
  getRegisterEntriesParamsSchema
} from "../schemas/registers.js";

import type { FieldsContracts } from "./fields.js";
import {
  asRecord,
  extractRegisterAnswersV1,
  extractRegisterItemsV2,
  summarizeRegisterEntryV1,
  summarizeRegisterEntryV2
} from "./raw-adapters.js";
import type {
  FlowQueryExecutionStats,
  FlowQueryPageInfo,
  RegisterEngineStatus,
  RegisterEntriesResult
} from "./types.js";

export interface GetRegisterEntriesInput {
  registerId: number | string;
  search?: string;
  pageSize?: number;
  cursor?: string;
}

export interface RegisterQueryContracts {
  /** Lê as flags de engine do cadastro (`GET /register/v2/query-engine-status`). */
  getRegisterEngineStatus: (input: {
    registerId: number | string;
  }) => Promise<RegisterEngineStatus>;
  /**
   * Smart reader das entradas de um cadastro. Detecta a engine e roteia:
   * `v2` (paginado, `POST /register/v2/query`) quando `use_query_v2='S'` ou `isLargeData='S'`;
   * senão `v1` (`GET /register?withAnswers=true`). Devolve entradas normalizadas + engine usada.
   */
  getRegisterEntries: (input: GetRegisterEntriesInput) => Promise<RegisterEntriesResult>;
}

export function createRegisterQueryContracts(params: {
  client: CangeClient;
  fields: FieldsContracts;
}): RegisterQueryContracts {
  const { client, fields } = params;

  async function getRegisterEngineStatus(input: {
    registerId: number | string;
  }): Promise<RegisterEngineStatus> {
    const parsed = getRegisterEngineStatusParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new CangeValidationError("Parâmetros inválidos para getRegisterEngineStatus.", {
        details: parsed.error.format()
      });
    }

    const raw = await client.get<unknown>("/register/v2/query-engine-status", {
      query: { id_register: String(parsed.data.registerId) }
    });
    const record = asRecord(raw) ?? {};
    const useQueryV2 = typeof record.use_query_v2 === "string" ? record.use_query_v2 : undefined;
    const isLargeData = typeof record.isLargeData === "string" ? record.isLargeData : undefined;

    return {
      raw,
      registerId: parsed.data.registerId,
      useV2: useQueryV2 === "S" || isLargeData === "S",
      useQueryV2,
      isLargeData
    };
  }

  /**
   * Resolve os campos do cadastro para (a) o `fieldView` que a rota v2 exige para PROJETAR os
   * valores (sem ele a query volta só metadados do form_answer) e (b) o mapa `id → título` que
   * traduz as chaves `field:<id>` da row. Cada item do fieldView precisa de `id_field`, `form_id`
   * e `type` — campos sem esses três são omitidos da projeção.
   */
  async function resolveRegisterFields(registerId: number | string): Promise<{
    titleByFieldId: Map<string, string>;
    fieldView: Array<Record<string, unknown>>;
  }> {
    const titleByFieldId = new Map<string, string>();
    const fieldView: Array<Record<string, unknown>> = [];
    try {
      const fieldSet = await fields.getFieldsByRegister({ registerId });
      for (const field of fieldSet.fields) {
        if (field.id === undefined) {
          continue;
        }
        const label = field.title ?? field.name;
        titleByFieldId.set(String(field.id), label);

        const idField = Number(field.id);
        const formId = field.formId !== undefined ? Number(field.formId) : undefined;
        if (!Number.isFinite(idField) || formId === undefined || !Number.isFinite(formId) || !field.type) {
          continue;
        }
        fieldView.push({
          id_field: idField,
          form_id: formId,
          type: field.type,
          title: label,
          active: true,
          index: fieldView.length,
          indexOrigin: fieldView.length,
          origin: "field",
          reordered: false
        });
      }
    } catch {
      // Sem catálogo de campos: a projeção volta só metadados e as chaves caem em `field:<id>`.
    }
    return { titleByFieldId, fieldView };
  }

  async function queryV2(input: GetRegisterEntriesInput): Promise<RegisterEntriesResult> {
    const { titleByFieldId, fieldView } = await resolveRegisterFields(input.registerId);

    const filterPayload: Record<string, unknown> = {};
    if (fieldView.length > 0) {
      filterPayload.fieldView = fieldView;
    }
    if (input.search && input.search.trim().length > 0) {
      filterPayload.searchText = input.search;
    }
    const filterSchema =
      Object.keys(filterPayload).length > 0 ? JSON.stringify(filterPayload) : undefined;

    const raw = await client.post<unknown>("/register/v2/query", {
      body: {
        id_register: toNumber(input.registerId),
        filterSchema,
        page_size: input.pageSize,
        cursor: input.cursor
      }
    });

    return {
      raw,
      engine: "v2",
      entries: extractRegisterItemsV2(raw).map((row) =>
        summarizeRegisterEntryV2(row, titleByFieldId)
      ),
      pageInfo: extractRegisterPageInfo(raw),
      executionStats: extractRegisterExecutionStats(raw)
    };
  }

  async function queryV1(input: GetRegisterEntriesInput): Promise<RegisterEntriesResult> {
    const query: Record<string, string> = {
      id_register: String(input.registerId),
      withAnswers: "true"
    };
    if (input.search && input.search.trim().length > 0) {
      query.likeSearch = input.search;
    }

    const raw = await client.get<unknown>("/register", { query });

    return {
      raw,
      engine: "v1",
      entries: extractRegisterAnswersV1(raw).map((answer) => summarizeRegisterEntryV1(answer)),
      pageInfo: { hasMore: false }
    };
  }

  async function getRegisterEntries(
    input: GetRegisterEntriesInput
  ): Promise<RegisterEntriesResult> {
    const parsed = getRegisterEntriesParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new CangeValidationError("Parâmetros inválidos para getRegisterEntries.", {
        details: parsed.error.format()
      });
    }

    const status = await getRegisterEngineStatus({ registerId: parsed.data.registerId });
    return status.useV2 ? queryV2(parsed.data) : queryV1(parsed.data);
  }

  return { getRegisterEngineStatus, getRegisterEntries };
}

function extractRegisterPageInfo(raw: unknown): FlowQueryPageInfo {
  const pageInfo = asRecord(asRecord(raw)?.page_info);
  if (!pageInfo) {
    return {};
  }
  return {
    hasMore: pageInfo.has_more === true,
    nextCursor: typeof pageInfo.next_cursor === "string" ? pageInfo.next_cursor : undefined
  };
}

function extractRegisterExecutionStats(raw: unknown): FlowQueryExecutionStats | undefined {
  const stats = asRecord(asRecord(raw)?.execution_stats);
  if (!stats) {
    return undefined;
  }
  return {
    ...stats,
    plan: typeof stats.plan === "string" ? stats.plan : undefined,
    cached: typeof stats.cached === "boolean" ? stats.cached : undefined,
    pageSize: typeof stats.page_size === "number" ? stats.page_size : undefined,
    durationMs: typeof stats.duration_ms === "number" ? stats.duration_ms : undefined,
    totalCount: typeof stats.total_count === "number" ? stats.total_count : undefined,
    warmupCount: typeof stats.warmup_count === "number" ? stats.warmup_count : undefined,
    snapshotFallbackUsed:
      typeof stats.snapshot_fallback_used === "boolean" ? stats.snapshot_fallback_used : undefined
  };
}
