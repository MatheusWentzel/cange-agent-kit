import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { cardNotVisibleMessage, FLOW_FROM_CARD_HINT, HIDDEN, locateFlowOfCard, type FlowResolution } from "../resource-ref.js";

interface CardRelationshipOptions {
  flowId?: string;
  cardId: string;
  withCards?: boolean;
}

export function registerCardRelationshipCommand(cardCommand: Command): void {
  cardCommand
    .command("relationship")
    .description(
      "Lê a relação pai-filho de 'Meus Fluxos' (COMBO_BOX_FLOW_FIELD): cards que referenciam este card (direção filho -> pai). Leitura confiável: os read-models não expõem o vínculo."
    )
    // Onda 4 (B2): o flow alvo do campo de vínculo é o fluxo do próprio cartão de --card-id
    // (o back casa field.flow_id = flow_id e value = id_card). Sem --flow-id, o kit descobre
    // pelo cartão (GET /card/locate), como o card read; 11 falhas do A220 em produção.
    .option(
      "--flow-id <id>",
      "Fluxo do cartão de --card-id (o fluxo para onde o campo de vínculo aponta). Sem ele, o kit descobre pelo cartão"
    )
    .requiredOption("--card-id <id>", "Cartão referenciado: o id que fica gravado no campo de vínculo dos outros cartões")
    .option("--no-with-cards", "Não trazer os cards completos (só os vínculos)")
    .action(
      createCommandAction(async ({ kit }, options: CardRelationshipOptions) => {
        // O fluxo do ambiente é o do cartão do run: só vale para ele. Com outro cartão, um
        // fluxo errado não dá erro, devolve "sem vínculos" (o back filtra pelo fluxo).
        let flowId = options.flowId ?? (options.cardId === envCardId() ? envFlowId() : undefined);
        let resolved: FlowResolution | undefined;
        // Fluxo no ambiente sem cartão do run: o parser comum não consulta o cartão (os
        // outros comandos usam o fluxo do ambiente e dão 404 se errar). Aqui o erro seria
        // silencioso, então o kit consulta o cartão (review do Alex, onda 4).
        if (!flowId && envFlowId() !== undefined && envCardId() === undefined) {
          const located = await locateFlowOfCard(options.cardId, (cardId) => kit.contracts.locateCard({ cardId }));
          if (located === HIDDEN) throw new CangeCliUsageError(cardNotVisibleMessage(options.cardId));
          if (located) {
            flowId = String(located.flow_id);
            resolved = located;
          }
        }
        if (!flowId) {
          throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);
        }
        const result = await kit.contracts.getCardRelationship({
          flowId,
          cardId: options.cardId,
          withCards: options.withCards
        });
        return resolved ? { ...result, resolved } : result;
      })
    );
}
