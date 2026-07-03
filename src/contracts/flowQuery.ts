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
}

export interface QueryFlowV2AllResult {
  summaries: CardSummary[];
  pages: number;
  truncated: boolean;
  totalCount?: number;
  lastExecutionStats?: FlowQueryExecutionStats;
}

export interface QueryEngineStatusResult {
  raw: unknown;
  enabled: boolean;
}

export interface FlowQueryContracts {
  getQueryEngineStatus: () => Promise<QueryEngineStatusResult>;
  queryFlowV2: (input: QueryFlowV2Input) => Promise<QueryFlowV2Result>;
  queryFlowV2All: (input: QueryFlowV2AllInput) => Promise<QueryFlowV2AllResult>;
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
      data.isArchived !== undefined || data.searchFieldScope !== undefined
        ? { isArchived: data.isArchived, search_field_scope: data.searchFieldScope }
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

    const { limit, maxPages, ...pageInput } = parsed.data;
    const pageCap = maxPages ?? 50;
    // Sem page_size explícito, dimensiona a página pelo próprio limit (teto 500)
    // para não buscar 50 quando só se quer poucos cartões.
    const effectivePageSize =
      pageInput.pageSize ?? (limit !== undefined ? Math.min(limit, 500) : undefined);
    const summaries: CardSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    let lastExecutionStats: FlowQueryExecutionStats | undefined;
    let totalCount: number | undefined;

    do {
      const page = await queryFlowV2({ ...pageInput, pageSize: effectivePageSize, cursor });
      summaries.push(...page.summaries);
      lastExecutionStats = page.executionStats;
      if (typeof page.executionStats?.totalCount === "number") {
        totalCount = page.executionStats.totalCount;
      }
      pages += 1;
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : undefined;

      if (limit !== undefined && summaries.length >= limit) {
        summaries.length = limit;
        truncated = Boolean(cursor);
        break;
      }
      if (pages >= pageCap && cursor) {
        truncated = true;
        break;
      }
    } while (cursor);

    return { summaries, pages, truncated, totalCount, lastExecutionStats };
  }

  return {
    async getQueryEngineStatus() {
      const raw = await client.get<unknown>("/flow/v2/query-engine-status");
      const record = asRecord(raw);
      return { raw, enabled: record?.enabled === true };
    },
    queryFlowV2,
    queryFlowV2All
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
