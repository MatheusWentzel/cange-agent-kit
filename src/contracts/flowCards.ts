import type { CardsContracts } from "./cards.js";
import type { FlowQueryContracts } from "./flowQuery.js";
import type { FlowsContracts } from "./flows.js";
import { extractPrimaryRecord } from "./raw-adapters.js";
import type {
  CardSummary,
  FlowQueryEngine,
  FlowQueryExecutionStats
} from "./types.js";

export type FlowQueryEngineChoice = "auto" | FlowQueryEngine;

export interface FetchFlowCardsInput {
  flowId: number | string;
  engine?: FlowQueryEngineChoice;
  flowViewId?: number | string;
  search?: string;
  filters?: unknown[];
  sort?: unknown[];
  flowStepId?: number | string;
  isArchived?: boolean;
  searchFieldScope?: "view" | "flow";
  limit?: number;
  pageSize?: number;
}

export interface FetchFlowCardsResult {
  engine: FlowQueryEngine;
  requestedEngine: FlowQueryEngineChoice;
  fellBackToV1: boolean;
  summaries: CardSummary[];
  total: number;
  truncated: boolean;
  totalCount?: number;
  executionStats?: FlowQueryExecutionStats;
}

export interface FlowCardsContracts {
  /** Resolve qual motor usar para um flow (respeitando override explícito). */
  resolveQueryEngine: (flowId: number | string, override?: FlowQueryEngineChoice) => Promise<FlowQueryEngine>;
  /** Busca cartões escolhendo V2 (mais rápido) quando disponível, com fallback seguro para V1. */
  fetchFlowCards: (input: FetchFlowCardsInput) => Promise<FetchFlowCardsResult>;
}

interface FlowCardsDeps {
  cards: CardsContracts;
  flows: FlowsContracts;
  flowQuery: FlowQueryContracts;
  logger?: (message: string, context?: unknown) => void;
}

/** Params que só o V2 sabe executar — se algum estiver presente, V1 não é opção. */
function requiresV2(input: FetchFlowCardsInput): boolean {
  return (
    input.flowViewId !== undefined ||
    (input.search !== undefined && input.search.length > 0) ||
    (Array.isArray(input.filters) && input.filters.length > 0) ||
    (Array.isArray(input.sort) && input.sort.length > 0)
  );
}

export function createFlowCardsContracts(deps: FlowCardsDeps): FlowCardsContracts {
  const { cards, flows, flowQuery, logger } = deps;

  // Cache por processo: o status do motor é global e não muda no meio de uma run.
  let cachedEngineStatus: boolean | undefined;
  const flowFlagCache = new Map<string, boolean>();

  async function isEngineEnabledGlobally(): Promise<boolean> {
    if (cachedEngineStatus === undefined) {
      try {
        const status = await flowQuery.getQueryEngineStatus();
        cachedEngineStatus = status.enabled;
      } catch (error) {
        logger?.("Falha ao ler query-engine-status; assumindo desabilitado.", error);
        cachedEngineStatus = false;
      }
    }
    return cachedEngineStatus;
  }

  async function isFlowFlaggedV2(flowId: number | string): Promise<boolean> {
    const key = String(flowId);
    const cached = flowFlagCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let flagged = false;
    try {
      const flow = await flows.getFlow({ idFlow: key });
      const record = extractPrimaryRecord(flow.raw);
      const flagValue = record?.use_flow_query_v2 ?? record?.use_query_v2;
      flagged = typeof flagValue === "string" && flagValue.trim().toUpperCase() === "S";
    } catch (error) {
      logger?.(`Falha ao ler flag use_flow_query_v2 do flow ${key}; assumindo V1.`, error);
    }
    flowFlagCache.set(key, flagged);
    return flagged;
  }

  async function resolveQueryEngine(
    flowId: number | string,
    override?: FlowQueryEngineChoice
  ): Promise<FlowQueryEngine> {
    if (override === "v1" || override === "v2") {
      return override;
    }
    if (await isEngineEnabledGlobally()) {
      return "v2";
    }
    if (await isFlowFlaggedV2(flowId)) {
      return "v2";
    }
    return "v1";
  }

  async function fetchViaV2(input: FetchFlowCardsInput): Promise<FetchFlowCardsResult> {
    const result = await flowQuery.queryFlowV2All({
      flowId: input.flowId,
      flowViewId: input.flowViewId,
      filters: input.filters,
      sort: input.sort,
      search: input.search,
      flowStepId: input.flowStepId,
      isArchived: input.isArchived,
      searchFieldScope: input.searchFieldScope,
      pageSize: input.pageSize,
      limit: input.limit
    });
    return {
      engine: "v2",
      requestedEngine: input.engine ?? "auto",
      fellBackToV1: false,
      summaries: result.summaries,
      total: result.summaries.length,
      truncated: result.truncated,
      totalCount: result.totalCount,
      executionStats: result.lastExecutionStats
    };
  }

  async function fetchViaV1(input: FetchFlowCardsInput): Promise<FetchFlowCardsResult> {
    const result = await cards.listCardsByFlow({
      flowId: input.flowId,
      isArchived: input.isArchived
    });
    let summaries = result.summaries;
    if (input.flowStepId !== undefined) {
      const step = String(input.flowStepId);
      summaries = summaries.filter((item) => String(item.currentStepId ?? item.step_id ?? "") === step);
    }
    if (input.limit !== undefined) {
      summaries = summaries.slice(0, input.limit);
    }
    return {
      engine: "v1",
      requestedEngine: input.engine ?? "auto",
      fellBackToV1: false,
      summaries,
      total: summaries.length,
      truncated: false
    };
  }

  async function fetchFlowCards(input: FetchFlowCardsInput): Promise<FetchFlowCardsResult> {
    const mustUseV2 = requiresV2(input);
    const engine = mustUseV2 ? "v2" : await resolveQueryEngine(input.flowId, input.engine);

    if (engine === "v2") {
      try {
        return await fetchViaV2(input);
      } catch (error) {
        if (mustUseV2 || input.engine === "v2") {
          throw error;
        }
        logger?.("Query V2 falhou; caindo para V1.", error);
        const fallback = await fetchViaV1(input);
        return { ...fallback, requestedEngine: input.engine ?? "auto", fellBackToV1: true };
      }
    }

    return fetchViaV1(input);
  }

  return { resolveQueryEngine, fetchFlowCards };
}
