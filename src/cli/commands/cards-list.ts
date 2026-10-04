import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import type { FlowQueryEngineChoice } from "../../contracts/flowCards.js";
import { extractFlowSteps } from "../../contracts/payload-builder.js";
import type { CardSummary } from "../../contracts/types.js";
import type { CangeAgentKit } from "../../index.js";
import { dropEmpty } from "../../utils/lean.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { parseOptionalBoolean } from "../helpers.js";

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
    .option("--limit <n>", "Limita quantidade de cartões retornados")
    .action(
      createCommandAction(async ({ kit, profile }, options: CardsListOptions) => {
        const lean = profile === "lean";
        const engine = parseEngine(options.engine);
        const limit = parseLimit(options.limit);
        const isArchived = parseOptionalBoolean(options.archived);
        const withPreAnswer = parseOptionalBoolean(options.withPreAnswer);
        const withTimeTracking = parseOptionalBoolean(options.withTimeTracking);
        const testModel = parseOptionalBoolean(options.testModel);

        // pre-answer/time-tracking/test-model são enriquecimentos que só existem no
        // /card/by-flow (V1). Mantém o caminho legado quando pedidos, salvo se o
        // usuário forçou V2 ou pediu uma view (que só o V2 resolve).
        const usesV1Enrichment =
          withPreAnswer === true || withTimeTracking === true || testModel === true;
        const forceLegacyV1 = usesV1Enrichment && engine !== "v2" && !options.viewId;

        if (forceLegacyV1) {
          const result = await kit.contracts.listCardsByFlow({
            flowId: options.flowId,
            isArchived,
            isWithPreAnswer: withPreAnswer,
            isWithTimeTracking: withTimeTracking,
            isTestModel: testModel
          });

          let summaries = result.summaries;
          if (options.stepId) {
            summaries = summaries.filter(
              (item) => String(item.currentStepId ?? item.step_id ?? "") === options.stepId
            );
          }
          if (limit !== undefined) {
            summaries = summaries.slice(0, limit);
          }

          if (lean) {
            return dropEmpty({
              engine: "v1",
              flowId: Number(options.flowId),
              total: summaries.length,
              summaries: await leanCardSummaries(kit, options.flowId, summaries)
            });
          }
          return { engine: "v1", raw: result.raw, summaries, total: summaries.length };
        }

        const result = await kit.contracts.fetchFlowCards({
          flowId: options.flowId,
          engine,
          flowViewId: options.viewId,
          flowStepId: options.stepId,
          isArchived,
          limit,
          // Rodada 5: título real (sem view o V2 devolvia "(Sem título)").
          ...(lean ? { ensureCardTitle: true } : {})
        });

        if (lean) {
          return dropEmpty({
            engine: result.engine,
            flowId: Number(options.flowId),
            total: result.total,
            totalCount: result.totalCount,
            truncated: result.truncated,
            summaries: await leanCardSummaries(kit, options.flowId, result.summaries)
          });
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

  annotateCommand(command, {
    envelope:
      "Enxuto (padrão): { engine, flowId, total, totalCount, truncated, summaries[{cardId, title (real), currentStepId, stepName, responsibleUserId, responsibleName, dueDate, completedAt, complete, archived}] }. " +
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
