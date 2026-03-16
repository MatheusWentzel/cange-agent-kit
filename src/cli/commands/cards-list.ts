import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
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
}

export function registerCardsListCommand(cardCommand: Command): void {
  cardCommand
    .command("list")
    .description("Lista cartões de um flow")
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--archived <value>", "Filtrar arquivados (true|false)")
    .option("--with-pre-answer <value>", "Incluir respostas prévias (true|false)")
    .option("--with-time-tracking <value>", "Incluir time tracking (true|false)")
    .option("--test-model <value>", "Incluir test model (true|false)")
    .option("--step-id <id>", "Filtra cartões por etapa atual")
    .option("--limit <n>", "Limita quantidade de cartões retornados")
    .action(
      createCommandAction(async ({ kit }, options: CardsListOptions) => {
        const result = await kit.contracts.listCardsByFlow({
          flowId: options.flowId,
          isArchived: parseOptionalBoolean(options.archived),
          isWithPreAnswer: parseOptionalBoolean(options.withPreAnswer),
          isWithTimeTracking: parseOptionalBoolean(options.withTimeTracking),
          isTestModel: parseOptionalBoolean(options.testModel)
        });

        let summaries = result.summaries;

        if (options.stepId) {
          summaries = summaries.filter(
            (item) => item.currentStepId !== undefined && String(item.currentStepId) === options.stepId
          );
        }

        if (options.limit !== undefined) {
          const limit = Number.parseInt(options.limit, 10);
          if (!Number.isFinite(limit) || limit <= 0) {
            throw new CangeCliUsageError("Valor inválido para --limit. Use inteiro positivo.");
          }
          summaries = summaries.slice(0, limit);
        }

        return {
          raw: result.raw,
          summaries,
          total: summaries.length
        };
      })
    );
}
