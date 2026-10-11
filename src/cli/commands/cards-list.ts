import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { readV1Page, type FlowQueryEngineChoice } from "../../contracts/flowCards.js";
import { extractFlowSteps } from "../../contracts/payload-builder.js";
import type { CardSummary } from "../../contracts/types.js";
import type { CangeAgentKit } from "../../index.js";
import { dropEmpty } from "../../utils/lean.js";
import { listOutput } from "../../utils/toon.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { addSearchSynonyms, parseOptionalBoolean } from "../helpers.js";

interface CardsListOptions {
  flowId: string;
  archived?: string;
  withPreAnswer?: string;
  withTimeTracking?: string;
  testModel?: string;
  stepId?: string;
  limit?: string;
  engine?: string;
  viewId?: string;
  search?: string;
  cursor?: string;
}

/** C4: página padrão do enxuto (antes vinham todos os cartões do fluxo). */
export const CARD_LIST_DEFAULT_LIMIT = 20;

/**
 * Comando pronto da página seguinte (o agente copia, não monta). Página do V1 leva
 * `--engine v1` e os `--with-*`: o cursor dela é deslocamento e não serve ao V2 (K2).
 */
function nextPageCommand(options: CardsListOptions, cursor: string, engine?: string): string {
  const parts = ["cange card list", `--flow-id ${options.flowId}`];
  if (engine === "v1") parts.push("--engine v1");
  if (options.withPreAnswer) parts.push(`--with-pre-answer ${options.withPreAnswer}`);
  if (options.withTimeTracking) parts.push(`--with-time-tracking ${options.withTimeTracking}`);
  if (options.testModel) parts.push(`--test-model ${options.testModel}`);
  if (options.stepId) parts.push(`--step-id ${options.stepId}`);
  if (options.viewId) parts.push(`--view-id ${options.viewId}`);
  if (options.search) parts.push(`--search ${JSON.stringify(options.search)}`);
  if (options.archived) parts.push(`--archived ${options.archived}`);
  if (options.limit) parts.push(`--limit ${options.limit}`);
  parts.push(`--cursor ${cursor}`);
  return parts.join(" ");
}

function parseEngine(value: string | undefined): FlowQueryEngineChoice {
  if (value === undefined) {
    return "auto";
  }
  if (value === "auto" || value === "v1" || value === "v2") {
    return value;
  }
  throw new CangeCliUsageError("Valor inválido para --engine. Use auto, v1 ou v2.");
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new CangeCliUsageError("Valor inválido para --limit. Use inteiro positivo.");
  }
  return limit;
}

export function registerCardsListCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("list")
    .description(
      "Lista cartões de um flow. Por padrão prioriza o motor V2 (mais rápido) com fallback V1; suporta view salva."
    )
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--archived <value>", "Filtrar arquivados (true|false)")
    .option("--with-pre-answer <value>", "Incluir respostas prévias (true|false) — só no V1")
    .option("--with-time-tracking <value>", "Incluir time tracking (true|false) — só no V1")
    .option("--test-model <value>", "Incluir test model (true|false) — só no V1")
    .option("--step-id <id>", "Filtra cartões por etapa atual")
    .option("--view-id <id>", "ID de uma visualização salva (aplica filtros/colunas/ordenação dela)")
    .option("--engine <engine>", "Motor de query: auto (default) | v1 | v2", "auto")
    .option(
      "--limit <n>",
      `Cartões por página (enxuto: padrão ${CARD_LIST_DEFAULT_LIMIT}; --full: todos). Para CONTAR ou SOMAR use \`cange cards count\`/\`cards sum\`, não a lista`
    )
    .option("--cursor <cursor>", "Página seguinte: o `--cursor` que veio em `next` na chamada anterior")
    .option("--search <texto>", "Busca textual em todos os campos do fluxo (motor V2; --q é sinônimo)")
    .action(
      createCommandAction(async ({ kit, profile }, options: CardsListOptions) => {
        const lean = profile === "lean";
        const engine = parseEngine(options.engine);
        const limit = parseLimit(options.limit) ?? (lean ? CARD_LIST_DEFAULT_LIMIT : undefined);
        const isArchived = parseOptionalBoolean(options.archived);
        const withPreAnswer = parseOptionalBoolean(options.withPreAnswer);
        const withTimeTracking = parseOptionalBoolean(options.withTimeTracking);
        const testModel = parseOptionalBoolean(options.testModel);

        // pre-answer/time-tracking/test-model são enriquecimentos que só existem no
        // /card/by-flow (V1). Mantém o caminho legado quando pedidos, salvo se o
        // usuário forçou V2 ou pediu uma view (que só o V2 resolve).
        const usesV1Enrichment =
          withPreAnswer === true || withTimeTracking === true || testModel === true;
        const search = options.search?.trim() || undefined;
        const forceLegacyV1 = usesV1Enrichment && engine !== "v2" && !options.viewId && !search;

        if (forceLegacyV1) {
          // EXE-K3: segue o cursor do fluxo grande (antes parava nos 150 da 1ª página).
          const page = await readV1Page(kit.contracts, {
            flowId: options.flowId,
            ...(isArchived !== undefined ? { isArchived } : {}),
            ...(withPreAnswer !== undefined ? { isWithPreAnswer: withPreAnswer } : {}),
            ...(withTimeTracking !== undefined ? { isWithTimeTracking: withTimeTracking } : {}),
            ...(testModel !== undefined ? { isTestModel: testModel } : {}),
            ...(options.stepId ? { flowStepId: options.stepId } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(lean && options.cursor !== undefined ? { cursor: options.cursor } : {})
          });

          if (lean) {
            return listOutput(
              dropEmpty({
                engine: "v1",
                flowId: Number(options.flowId),
                total: page.summaries.length,
                totalCount: page.totalCount,
                // K5: igual ao V2, o V1 diz que há mais além do `next`.
                truncated: page.truncated,
                next: page.nextCursor ? nextPageCommand(options, page.nextCursor, "v1") : undefined,
                summaries: await leanCardSummaries(kit, options.flowId, page.summaries)
              }),
              "summaries"
            );
          }
          return { engine: "v1", raw: page.raw, summaries: page.summaries, total: page.summaries.length, truncated: page.truncated };
        }

        const result = await kit.contracts.fetchFlowCards({
          flowId: options.flowId,
          engine,
          flowViewId: options.viewId,
          flowStepId: options.stepId,
          // P7: busca sem view varre todos os campos do fluxo (igual ao flow query).
          ...(search ? { search, searchFieldScope: options.viewId ? undefined : ("flow" as const) } : {}),
          isArchived,
          limit,
          // Rodada 5: título real (sem view o V2 devolvia "(Sem título)").
          ...(lean ? { ensureCardTitle: true, paginate: true } : {}),
          ...(lean && options.cursor ? { cursor: options.cursor } : {})
        });

        if (lean) {
          return listOutput(
            dropEmpty({
              engine: result.engine,
              flowId: Number(options.flowId),
              total: result.total,
              totalCount: result.totalCount,
              truncated: result.truncated,
              next: result.nextCursor ? nextPageCommand(options, result.nextCursor, result.engine) : undefined,
              summaries: await leanCardSummaries(kit, options.flowId, result.summaries)
            }),
            "summaries"
          );
        }
        return {
          engine: result.engine,
          requestedEngine: result.requestedEngine,
          fellBackToV1: result.fellBackToV1,
          truncated: result.truncated,
          totalCount: result.totalCount,
          total: result.total,
          summaries: result.summaries,
          executionStats: result.executionStats
        };
      })
    );
  addSearchSynonyms(command, "search");

  annotateCommand(command, {
    envelope:
      `Enxuto (padrão): ${CARD_LIST_DEFAULT_LIMIT} por página: { engine, flowId, total (nesta página), totalCount (todos que casam), truncated, next? (comando pronto da página seguinte, com --cursor), summaries[{cardId, title (real), currentStepId, stepName, responsibleUserId, responsibleName, dueDate, completedAt, complete, archived}] }. ` +
      "Com --full, V2: { engine, total, totalCount, truncated, summaries[], executionStats }; " +
      "V1 (com --with-*): { engine, raw, summaries[], total }",
    fieldsLocation:
      "os cartões enriquecidos (cardId, title, currentStepId, stepName, responsibleUserId, fieldValues) vivem em `summaries[]`, NUNCA em `raw`",
    example: "card list --flow-id 192 --limit 20",
    outputExample: {
      engine: "v2",
      total: 1,
      summaries: [{ cardId: 1096611, title: "…", currentStepId: 485, responsibleUserId: 76 }]
    }
  });
}

/**
 * Rodada 5: cartão na saída enxuta. Sem os aliases snake_case (`id_card`,
 * `flow_id`, `step_id`), sem `fields` (o MESMO objeto de `fieldValues`), sem
 * `flowHash`/`companyId` e sem o fluxo repetido em cada item (está no envelope).
 * Com o NOME da etapa: o V2 só traz o id, e o agente rodava `map` para traduzir.
 */
export async function leanCardSummaries(
  kit: CangeAgentKit,
  flowId: string,
  summaries: CardSummary[]
): Promise<Array<Record<string, unknown>>> {
  const stepNames = summaries.some((s) => !s.stepName && (s.currentStepId ?? s.step_id) !== undefined)
    ? await loadStepNames(kit, flowId)
    : new Map<string, string>();
  return summaries.map((s) => {
    const stepId = s.currentStepId ?? s.step_id;
    return {
      cardId: s.cardId ?? s.id_card,
      title: s.title,
      currentStepId: stepId,
      stepName: s.stepName ?? (stepId !== undefined ? stepNames.get(String(stepId)) : undefined),
      responsibleUserId: s.responsibleUserId,
      responsibleName: s.responsibleName,
      dueDate: s.dueDate,
      statusDue: s.statusDue,
      createdAt: s.createdAt,
      completedAt: s.completedAt,
      complete: s.complete,
      archived: s.archived,
      fieldValues: s.fieldValues ?? s.fields
    };
  });
}

/** Nome das etapas do fluxo (1 leitura do fluxo). Falhou: segue sem os nomes. */
async function loadStepNames(kit: CangeAgentKit, flowId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const flow = await kit.contracts.getFlow({ idFlow: String(flowId) });
    for (const step of extractFlowSteps(flow.raw)) {
      if (step.id !== undefined && step.name) names.set(String(step.id), step.name);
    }
  } catch {
    /* best-effort: o id da etapa continua na saída */
  }
  return names;
}
