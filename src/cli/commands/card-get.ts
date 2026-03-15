import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface CardGetOptions {
  flowId: string;
  cardId: string;
  companyId?: string;
}

export function registerCardGetCommand(cardCommand: Command): void {
  cardCommand
    .command("get")
    .description("Busca um cartão por flow_id + id_card")
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--card-id <id>", "ID do card")
    .option("--company-id <id>", "ID da company")
    .action(
      createCommandAction(async ({ kit }, options: CardGetOptions) => {
        return kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId,
          companyId: options.companyId
        });
      })
    );
}
