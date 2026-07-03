import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CardGetOptions {
  flowId: string;
  cardId: string;
  companyId?: string;
  fieldIds?: string;
  summaryOnly?: boolean;
}

export function registerCardGetCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("get")
    .description("Busca um cartão por flow_id + id_card")
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--card-id <id>", "ID do card")
    .option("--company-id <id>", "ID da company")
    .option(
      "--field-ids <ids>",
      "Filtra summary.fieldValues por IDs de field (lista separada por vírgula)"
    )
    .option("--summary-only", "Retorna somente summary (sem raw)")
    .action(
      createCommandAction(async ({ kit }, options: CardGetOptions) => {
        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId,
          companyId: options.companyId
        });

        const requestedFieldIds = parseFieldIds(options.fieldIds);
        if (requestedFieldIds.length === 0) {
          if (options.summaryOnly) {
            return {
              summary: result.summary
            };
          }
          return result;
        }

        const sourceFields = result.summary.fieldValues ?? result.summary.fields ?? {};
        const filteredFieldValues: Record<string, unknown> = {};
        for (const fieldId of requestedFieldIds) {
          filteredFieldValues[fieldId] =
            fieldId in sourceFields ? sourceFields[fieldId] : null;
        }

        const response = {
          summary: {
            ...result.summary,
            fieldValues: filteredFieldValues,
            fields: filteredFieldValues
          },
          requestedFieldIds
        };

        if (options.summaryOnly) {
          return response;
        }

        return {
          ...result,
          ...response
        };
      })
    );

  annotateCommand(command, {
    envelope: "{ raw, summary } (só { summary } com --summary-only; + requestedFieldIds com --field-ids)",
    fieldsLocation:
      "campos legíveis (title, stepName, fieldValues) vivem em `summary`; `raw` é a resposta crua da API",
    example: "card get --flow-id 192 --card-id 1096611 --summary-only"
  });
}

function parseFieldIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
