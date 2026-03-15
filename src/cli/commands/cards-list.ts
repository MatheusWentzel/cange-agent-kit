import type { Command } from "commander";

import { createCommandAction } from "../context.js";
import { parseOptionalBoolean } from "../helpers.js";

interface CardsListOptions {
  flowId: string;
  archived?: string;
  withPreAnswer?: string;
  withTimeTracking?: string;
  testModel?: string;
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
    .action(
      createCommandAction(async ({ kit }, options: CardsListOptions) => {
        return kit.contracts.listCardsByFlow({
          flowId: options.flowId,
          isArchived: parseOptionalBoolean(options.archived),
          isWithPreAnswer: parseOptionalBoolean(options.withPreAnswer),
          isWithTimeTracking: parseOptionalBoolean(options.withTimeTracking),
          isTestModel: parseOptionalBoolean(options.testModel)
        });
      })
    );
}
