import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { toNumber } from "../schemas/common.js";
import {
  queryFlowV2AllParamsSchema,
  queryFlowV2ParamsSchema
} from "../schemas/flowQuery.js";

import { asRecord, extractArray, summarizeCard } from "./raw-adapters.js";
import type {
  CardSummary,
  FlowQueryExecutionStats,
  FlowQueryPageInfo
} from "./types.js";

export interface QueryFlowV2Input {
  flowId: number | string;
  flowViewId?: number | string;
  filters?: unknown[];
  sort?: unknown[];
  fields?: unknown[];
  search?: string;
  pageSize?: number;
  cursor?: string;
  flowStepId?: number | string;
  isArchived?: boolean;
  searchFieldScope?: "view" | "flow";
  /** Rodada 5: título real do cartão mesmo sem fieldView (`flags.ensure_card_title`). */
  ensureCardTitle?: boolean;
}

export interface QueryFlowV2Result {
  raw: unknown;
  summaries: CardSummary[];
  pageInfo: FlowQueryPageInfo;
  executionStats?: FlowQueryExecutionStats;
}

export interface QueryFlowV2AllInput extends Omit<QueryFlowV2Input, "cursor"> {
  limit?: number;
  maxPages?: number;
  /** C4: começa deste cursor (a `nextCursor` de uma chamada anterior). */
  startCursor?: string;
}

export interface QueryFlowV2AllResult {
  summaries: CardSummary[];
  pages: number;
  truncated: boolean;
  totalCount?: number;
  lastExecutionStats?: FlowQueryExecutionStats;
  /**
   * C4: cursor da página seguinte sempre que sobrou cartão. A última página é pedida
   * só com o que falta para o `limit`, então a leitura para numa fronteira de página
   * e o cursor do back continua exatamente dali (ex.: `--limit 700` = 500 + 200).
   */
  nextCursor?: string;
}

/** Um item de agregação do `POST /flow/v2/aggregations` (o mesmo do back). */
export interface FlowAggregationItem {
  fn: "SUM" | "COUNT" | "MIN" | "MAX" | "AVG";
  target: "card" | "field";
  key: string;
  by_step?: boolean;
}

export interface AggregateFlowV2Input {
  flowId: number | string;
  agg: FlowAggregationItem[];
  flowStepId?: number | string;
  isArchived?: boolean;
}

export interface AggregateFlowV2Result {
  raw: unknown;
  /** Chave `fn:target:key` (ex.: `COUNT:card:`, `SUM:field:5003`) → valor, sobre o conjunto filtrado. */
  filteredScope: Record<string, number>;
  /** `flow_step_id` → cartões, quando pedido `COUNT card by_step`. */
  stepCounts?: Record<string, number>;
  /** O back agrega no máximo 10.000 cartões; `true` = passou disso. */
  truncated: boolean;
}

export interface QueryEngineStatusResult {
  raw: unknown;
  enabled: boolean;
}

export interface FlowQueryContracts {
  getQueryEngineStatus: () => Promise<QueryEngineStatusResult>;
  queryFlowV2: (input: QueryFlowV2Input) => Promise<QueryFlowV2Result>;
  queryFlowV2All: (input: QueryFlowV2AllInput) => Promise<QueryFlowV2AllResult>;
  /** C4: contagem/soma no servidor (`POST /flow/v2/aggregations`), com o acesso do token. */
  aggregateFlowV2: (input: AggregateFlowV2Input) => Promise<AggregateFlowV2Result>;
}

export function createFlowQueryContracts(client: CangeClient): FlowQueryContracts {
  async function queryFlowV2(input: QueryFlowV2Input): Promise<QueryFlowV2Result> {
    const parsed = queryFlowV2ParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new CangeValidationError("Parâmetros inválidos para queryFlowV2.", {
        details: parsed.error.format()
      });
    }

    const data = parsed.data;
    const flags =
      data.isArchived !== undefined || data.searchFieldScope !== undefined || data.ensureCardTitle === true
        ? {
            isArchived: data.isArchived,
            search_field_scope: data.searchFieldScope,
            ...(data.ensureCardTitle === true ? { ensure_card_title: true } : {})
          }
        : undefined;

    const raw = await client.post<unknown>("/flow/v2/query", {
      body: {
        flow_id: toNumber(data.flowId),
        flow_view_id: data.flowViewId !== undefined ? toNumber(data.flowViewId) : undefined,
        filters: data.filters,
        sort: data.sort,
        fields: data.fields,
        search: data.search,
        page_size: data.pageSize,
        cursor: data.cursor,
        flow_step_id: data.flowStepId !== undefined ? toNumber(data.flowStepId) : undefined,
        flags
      }
    });

    return {
      raw,
      summaries: extractQueryItems(raw).map((item) => summarizeCard(unwrapCardItem(item))),
      pageInfo: extractPageInfo(raw),
      executionStats: extractExecutionStats(raw)
    };
  }

  async function queryFlowV2All(input: QueryFlowV2AllInput): Promise<QueryFlowV2AllResult> {
    const parsed = queryFlowV2AllParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new CangeValidationError("Parâmetros inválidos para queryFlowV2All.", {
        details: parsed.error.format()
      });
    }

    const { limit, maxPages, startCursor, ...pageInput } = parsed.data;
    const pageCap = maxPages ?? 50;
    // Sem page_size explícito, dimensiona a página pelo próprio limit (teto 500)
    // para não buscar 50 quando só se quer poucos cartões.
    const basePageSize =
      pageInput.pageSize ?? (limit !== undefined ? Math.min(limit, 500) : undefined);
    const summaries: CardSummary[] = [];
    let cursor: string | undefined = startCursor;
    let pages = 0;
    let nextCursor: string | undefined;
    let truncated = false;
    let lastExecutionStats: FlowQueryExecutionStats | undefined;
    let totalCount: number | undefined;

    do {
      // K1: a página pede só o que falta para o limit. Assim o limit nunca corta no
      // meio de uma página e o `next_cursor` do back continua de onde a leitura parou
      // (o cursor do back é por chave de ordenação, não por deslocamento).
      const remaining = limit !== undefined ? limit - summaries.length : undefined;
      const pageSize =
        basePageSize !== undefined && remaining !== undefined ? Math.min(basePageSize, remaining) : basePageSize;
      const page = await queryFlowV2({ ...pageInput, pageSize, cursor });
      summaries.push(...page.summaries);
      lastExecutionStats = page.executionStats;
      if (typeof page.executionStats?.totalCount === "number") {
        totalCount = page.executionStats.totalCount;
      }
      pages += 1;
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : undefined;

      if (limit !== undefined && summaries.length >= limit) {
        // Só acontece se o back devolver mais que o page_size pedido: aí não há
        // cursor que continue do meio da página, e a saída avisa com `truncated`.
        const cutMidPage = summaries.length > limit;
        summaries.length = limit;
        truncated = Boolean(cursor) || cutMidPage;
        if (!cutMidPage) nextCursor = cursor;
        break;
      }
      if (pages >= pageCap && cursor) {
        truncated = true;
        nextCursor = cursor;
        break;
      }
    } while (cursor);

    return { summaries, pages, truncated, totalCount, lastExecutionStats, ...(nextCursor ? { nextCursor } : {}) };
  }

  async function aggregateFlowV2(input: AggregateFlowV2Input): Promise<AggregateFlowV2Result> {
    const raw = await client.post<unknown>("/flow/v2/aggregations", {
      body: {
        flow_id: toNumber(input.flowId),
        ...(input.flowStepId !== undefined ? { flow_step_id: toNumber(input.flowStepId) } : {}),
        flags: { isArchived: input.isArchived ?? false },
        agg: input.agg
      }
    });
    const record = asRecord(raw) ?? {};
    const toNumbers = (value: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [key, item] of Object.entries(asRecord(value) ?? {})) {
        const n = typeof item === "number" ? item : Number(item);
        if (Number.isFinite(n)) out[key] = n;
      }
      return out;
    };
    const stepCounts = asRecord(record.step_counts) ? toNumbers(record.step_counts) : undefined;
    return {
      raw,
      filteredScope: toNumbers(record.filtered_scope),
      ...(stepCounts ? { stepCounts } : {}),
      truncated: asRecord(record.execution_stats)?.filtered_scope_truncated === true
    };
  }

  return {
    async getQueryEngineStatus() {
      const raw = await client.get<unknown>("/flow/v2/query-engine-status");
      const record = asRecord(raw);
      return { raw, enabled: record?.enabled === true };
    },
    queryFlowV2,
    queryFlowV2All,
    aggregateFlowV2
  };
}

function extractQueryItems(raw: unknown): unknown[] {
  const record = asRecord(raw);
  if (record && Array.isArray(record.items)) {
    return record.items;
  }
  return extractArray(raw);
}

/** Item do V2 = `{ card, fields, pre_answer_fields }`. Desembrulha `card` quando presente. */
function unwrapCardItem(item: unknown): unknown {
  const record = asRecord(item);
  if (record && asRecord(record.card)) {
    return record.card;
  }
  return item;
}

function extractPageInfo(raw: unknown): FlowQueryPageInfo {
  const pageInfo = asRecord(asRecord(raw)?.page_info);
  if (!pageInfo) {
    return {};
  }
  return {
    hasMore: pageInfo.has_more === true,
    nextCursor: typeof pageInfo.next_cursor === "string" ? pageInfo.next_cursor : undefined
  };
}

function extractExecutionStats(raw: unknown): FlowQueryExecutionStats | undefined {
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
