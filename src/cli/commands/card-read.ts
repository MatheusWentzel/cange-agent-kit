import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CardReadOptions {
  flowId: string;
  cardId: string;
  fieldIds?: string;
}

/**
 * `cange card read` — leitura ENXUTA de um card, feita para agentes.
 *
 * `card get` devolve o envelope completo com `raw` (a resposta crua da API pode
 * passar de 700 KB — caso real: run do Comprador, card 1219728) e o agente paga
 * esse tamanho em tokens de contexto. Este comando faz a MESMA consulta e devolve
 * só o que um agente precisa para decidir: etapa atual + valores legíveis.
 *
 * Use `card get` (com raw) apenas quando precisar de um detalhe estrutural que o
 * summary não tem.
 */
export function registerCardReadCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("read")
    .description(
      "LEITURA ENXUTA do card (etapa atual + valores legíveis, sem raw) — use este por padrão; `card get` só quando precisar do raw"
    )
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--card-id <id>", "ID do card")
    .option(
      "--field-ids <ids>",
      "Filtra fieldValues por IDs de field (lista separada por vírgula)"
    )
    .action(
      createCommandAction(async ({ kit }, options: CardReadOptions) => {
        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId
        });

        const s = result.summary as Record<string, unknown>;
        let fieldValues = (s.fieldValues ?? s.fields ?? {}) as Record<string, unknown>;

        const requested = (options.fieldIds ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (requested.length > 0) {
          const filtered: Record<string, unknown> = {};
          for (const id of requested) {
            filtered[id] = id in fieldValues ? fieldValues[id] : null;
          }
          fieldValues = filtered;
        }

        return {
          cardId: s.cardId ?? s.id_card,
          title: s.title,
          flowId: s.flowId ?? s.flow_id,
          flowName: s.flowName,
          stepId: s.currentStepId ?? s.step_id,
          stepName: s.stepName,
          createdAt: s.createdAt,
          archived: s.archived,
          complete: s.complete,
          fieldValues
        };
      })
    );

  annotateCommand(command, {
    envelope: "{ cardId, title, flowId, flowName, stepId, stepName, createdAt, archived, complete, fieldValues }",
    fieldsLocation: "fieldValues: chave = field id, valor = texto legível (valueString)",
    example: "card read --flow-id 22792 --card-id 1219728"
  });
}
