import { CangeError, CangeValidationError } from "../client/errors.js";

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
  /** Rodada 5 (V2): título real do cartão mesmo sem view (`flags.ensure_card_title`). */
  ensureCardTitle?: boolean;
  /** C4: página seguinte (V2: cursor do back; V1: deslocamento na lista, em texto). */
  cursor?: string;
  /** C4: devolve `nextCursor`/`totalCount` também no V1 (o formato completo não pede). */
  paginate?: boolean;
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
  /** C4: cursor da página seguinte (só quando pedido `limit` e há mais). */
  nextCursor?: string;
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

/**
 * K3: quando a falha do V2 autoriza cair no V1. Só falha do MOTOR: rede/timeout (sem
 * status), 5xx ou erro inesperado fora da API. 4xx é resposta de uso (401/403 acesso,
 * 404 fluxo, 400 pedido, 429 limite): o V1 daria o mesmo erro, ou pior, uma resposta
 * diferente sem aviso. Esses propagam.
 */
export function isQueryEngineFailure(error: unknown): boolean {
  if (!(error instanceof CangeError)) return true;
  return error.status === undefined || error.status >= 500;
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
      limit: input.limit,
      ...(input.ensureCardTitle === true ? { ensureCardTitle: true } : {}),
      ...(input.cursor !== undefined ? { startCursor: input.cursor } : {})
    });
    return {
      engine: "v2",
      requestedEngine: input.engine ?? "auto",
      fellBackToV1: false,
      summaries: result.summaries,
      total: result.summaries.length,
      truncated: result.truncated,
      totalCount: result.totalCount,
      executionStats: result.lastExecutionStats,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {})
    };
  }

  async function fetchViaV1(input: FetchFlowCardsInput): Promise<FetchFlowCardsResult> {
    const page = await readV1Page(cards, input);
    return {
      engine: "v1",
      requestedEngine: input.engine ?? "auto",
      fellBackToV1: false,
      summaries: page.summaries,
      total: page.summaries.length,
      truncated: page.truncated,
      ...(input.paginate && page.totalCount !== undefined ? { totalCount: page.totalCount } : {}),
      ...(input.paginate && page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
    };
  }

  async function fetchFlowCards(input: FetchFlowCardsInput): Promise<FetchFlowCardsResult> {
    const mustUseV2 = requiresV2(input);
    const engine = mustUseV2 ? "v2" : await resolveQueryEngine(input.flowId, input.engine);

    if (engine === "v2") {
      try {
        return await fetchViaV2(input);
      } catch (error) {
        // K2: com cursor, o V1 não continua a página do V2 (o cursor do V2 não é
        // deslocamento): cair no V1 recomeçaria do zero e o agente releria em laço.
        if (mustUseV2 || input.engine === "v2" || input.cursor !== undefined || !isQueryEngineFailure(error)) {
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

export interface V1PageInput {
  flowId: number | string;
  flowStepId?: number | string;
  isArchived?: boolean;
  isTestModel?: boolean;
  isWithPreAnswer?: boolean;
  isWithTimeTracking?: boolean;
  limit?: number;
  cursor?: string;
}

export interface V1Page {
  summaries: CardSummary[];
  /** Cartões que casam (etapa) no fluxo, quando dá para saber. */
  totalCount?: number;
  nextCursor?: string;
  /** Há mais além desta página (o `next`) ou a leitura parou no teto/cursor vencido. */
  truncated: boolean;
  /** 1ª resposta do back (no fluxo grande, com todos os cartões lidos). */
  raw: unknown;
}

/**
 * Página do V1 (`GET /card/by-flow`). O cursor do kit é o deslocamento na lista. EXE-K3:
 * no fluxo grande o back pagina (150 por vez, `cursorKey` + `offset`); a leitura segue o
 * cursor até ter deslocamento + limite + 1 cartões (o +1 diz se há página seguinte) ou o
 * fim. Antes a lista parava nos 150 da 1ª página e o `next` sumia no 150º cartão.
 */
export async function readV1Page(
  cards: Pick<CardsContracts, "listAllCardsByFlow">,
  input: V1PageInput
): Promise<V1Page> {
  const offset = parseV1Cursor(input.cursor);
  const step = input.flowStepId !== undefined ? String(input.flowStepId) : undefined;
  const result = await cards.listAllCardsByFlow({
    flowId: input.flowId,
    ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
    ...(input.isTestModel !== undefined ? { isTestModel: input.isTestModel } : {}),
    ...(input.isWithPreAnswer !== undefined ? { isWithPreAnswer: input.isWithPreAnswer } : {}),
    ...(input.isWithTimeTracking !== undefined ? { isWithTimeTracking: input.isWithTimeTracking } : {}),
    ...(input.limit !== undefined ? { need: offset + input.limit + 1 } : {}),
    ...(step !== undefined
      ? { accept: (summary: CardSummary) => String(summary.currentStepId ?? summary.step_id ?? "") === step }
      : {})
  });
  const matched = result.summaries.length;
  // Lista inteira: o total é o que casou. Parcial: sem filtro de etapa, o total do back.
  const totalCount = result.complete ? matched : step === undefined ? result.totalIds : undefined;
  let summaries = offset > 0 ? result.summaries.slice(offset) : result.summaries;
  let nextCursor: string | undefined;
  if (input.limit !== undefined) {
    if (summaries.length > input.limit) nextCursor = String(offset + input.limit);
    summaries = summaries.slice(0, input.limit);
  }
  return {
    summaries,
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    // K5: há mais além do `next`; fluxo grande lido pela metade (teto ou cursor vencido) também.
    truncated: nextCursor !== undefined || !result.complete,
    raw: result.raw
  };
}

/** K2: cursor do V1 é o deslocamento na lista (número). Outro texto é cursor de outro motor. */
export function parseV1Cursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new CangeValidationError(
      `--cursor "${cursor}" não é deste motor: no V1 o cursor é um número (deslocamento). ` +
        "Use o `next` que veio na resposta anterior, sem trocar o --engine entre as páginas."
    );
  }
  return Number(cursor);
}
