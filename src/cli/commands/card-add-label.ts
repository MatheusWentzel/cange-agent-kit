import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { addCardLabelPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CardAddLabelOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardAddLabelCommand(cardCommand: Command): void {
  cardCommand
    .command("add-label")
    .description("MUTAÇÃO: vincula uma etiqueta (flow_tag) a um card")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardAddLabelOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = addCardLabelPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card add-label.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.addCardLabel(parsed.data);
      })
    );
}
