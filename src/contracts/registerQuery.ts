import { CangeApiError, CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { toNumber } from "../schemas/common.js";
import type { NormalizedField } from "../schemas/fields.js";
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
  FlowQueryEngine,
  FlowQueryExecutionStats,
  FlowQueryPageInfo,
  RegisterEngineStatus,
  RegisterEntriesResult,
  RegisterEntry
} from "./types.js";

export interface GetRegisterEntriesInput {
  registerId: number | string;
  search?: string;
  pageSize?: number;
  cursor?: string;
  /**
   * v9: campos do cadastro já lidos por quem chama (`GET /field/by-register`). A
   * engine v2 usa para projetar os valores sem ler os campos de novo.
   */
  fields?: NormalizedField[];
}

/** Uma entrada pelo id, lida com o MESMO acesso da listagem do cadastro. */
export interface RegisterEntryResult {
  engine: FlowQueryEngine;
  /** `undefined` = a entrada não está neste cadastro (ou foi apagada). */
  entry?: RegisterEntry;
  raw: unknown;
}

/** De qual cadastro (ou cartão) é uma resposta de formulário. */
export interface RegisterEntryLocation {
  registerId?: number;
  cardId?: number;
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
  /**
   * v9 (run 1131): uma entrada pelo id. Engine v2: `GET /register/v2/query-single`;
   * v1: a lista do cadastro filtrada pelo id. As duas passam pela checagem de acesso
   * ao cadastro (sem acesso = o 404 de sempre).
   */
  getRegisterEntry: (input: {
    registerId: number | string;
    entryId: number | string;
    fields?: NormalizedField[];
  }) => Promise<RegisterEntryResult>;
  /**
   * v9: de qual cadastro é a entrada (`GET /form/answer?id_form_answer=`). Só
   * localiza: os valores voltam pelo {@link getRegisterEntry}, que checa o acesso.
   * `undefined` = a resposta não existe nesta empresa (ou foi apagada).
   */
  locateRegisterEntry: (input: { entryId: number | string }) => Promise<RegisterEntryLocation | undefined>;
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
  async function resolveRegisterFields(
    registerId: number | string,
    prefetched?: NormalizedField[]
  ): Promise<{
    titleByFieldId: Map<string, string>;
    fieldView: Array<Record<string, unknown>>;
  }> {
    const titleByFieldId = new Map<string, string>();
    const fieldView: Array<Record<string, unknown>> = [];
    try {
      const fieldList = prefetched ?? (await fields.getFieldsByRegister({ registerId })).fields;
      for (const field of fieldList) {
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
    const { titleByFieldId, fieldView } = await resolveRegisterFields(input.registerId, input.fields);

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
    const query = { ...parsed.data, fields: input.fields };
    return status.useV2 ? queryV2(query) : queryV1(query);
  }

  async function getRegisterEntry(input: {
    registerId: number | string;
    entryId: number | string;
    fields?: NormalizedField[];
  }): Promise<RegisterEntryResult> {
    const entryId = String(input.entryId);
    if (!/^[1-9]\d*$/.test(entryId)) {
      throw new CangeValidationError("Parâmetros inválidos para getRegisterEntry: entryId precisa ser um inteiro positivo.", {
        details: { entryId: input.entryId }
      });
    }
    const status = await getRegisterEngineStatus({ registerId: input.registerId });
    if (status.useV2) {
      const { titleByFieldId } = await resolveRegisterFields(input.registerId, input.fields);
      let raw: unknown;
      try {
        raw = await client.get<unknown>("/register/v2/query-single", {
          query: { id_register: String(input.registerId), id_form_answer: entryId }
        });
      } catch (error) {
        // O back separa as duas frases: "Register não encontrado ou sem acesso" (o cadastro)
        // e "Registro não encontrado" (a entrada não está nele). Só a 2a vira "sem entrada".
        if (isEntryNotFound(error)) return { engine: "v2", raw: undefined };
        throw error;
      }
      const item = asRecord(asRecord(raw)?.item);
      return { engine: "v2", raw, entry: item ? summarizeRegisterEntryV2(item, titleByFieldId) : undefined };
    }

    const raw = await client.get<unknown>("/register", {
      query: { id_register: String(input.registerId), withAnswers: "true" }
    });
    const answer = extractRegisterAnswersV1(raw).find((candidate) => {
      const id = candidate.id_form_answer ?? candidate.form_answer_id ?? candidate.id;
      return id !== undefined && id !== null && String(id) === entryId;
    });
    return { engine: "v1", raw: answer, entry: answer ? summarizeRegisterEntryV1(answer) : undefined };
  }

  async function locateRegisterEntry(input: { entryId: number | string }): Promise<RegisterEntryLocation | undefined> {
    const raw = await client.get<unknown>("/form/answer", { query: { id_form_answer: String(input.entryId) } });
    const answers = Array.isArray(raw) ? raw : raw !== null && raw !== undefined ? [raw] : [];
    const answer = answers.map(asRecord).find((candidate) => candidate !== undefined);
    if (!answer) return undefined;
    const register = asRecord(answer.register);
    const registerId = positiveNumber(answer.register_id) ?? positiveNumber(register?.id_register);
    const cardId = positiveNumber(answer.card_id);
    return {
      ...(registerId !== undefined ? { registerId } : {}),
      ...(cardId !== undefined ? { cardId } : {})
    };
  }

  return { getRegisterEngineStatus, getRegisterEntries, getRegisterEntry, locateRegisterEntry };
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

function isEntryNotFound(error: unknown): boolean {
  if (!(error instanceof CangeApiError) || error.status !== 404) return false;
  const text = error.message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\bregistro nao encontrado\b/.test(text) && !/sem acesso/.test(text);
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
