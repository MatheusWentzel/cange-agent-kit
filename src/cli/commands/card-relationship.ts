import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface CardRelationshipOptions {
  flowId: string;
  cardId: string;
  withCards?: boolean;
}

export function registerCardRelationshipCommand(cardCommand: Command): void {
  cardCommand
    .command("relationship")
    .description(
      "Lê a relação pai-filho de 'Meus Fluxos' (COMBO_BOX_FLOW_FIELD): cards que referenciam este card (direção filho -> pai). Leitura confiável — read-models não expõem o vínculo."
    )
    .requiredOption("--flow-id <id>", "Flow ALVO do campo de vínculo (para onde o campo aponta)")
    .requiredOption("--card-id <id>", "Card cujo id está armazenado no value do campo de vínculo (o filho)")
    .option("--no-with-cards", "Não trazer os cards completos (só os vínculos)")
    .action(
      createCommandAction(async ({ kit }, options: CardRelationshipOptions) => {
        return kit.contracts.getCardRelationship({
          flowId: options.flowId,
          cardId: options.cardId,
          withCards: options.withCards
        });
      })
    );
}
