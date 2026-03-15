import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { updateCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CardUpdateOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardUpdateCommand(cardCommand: Command): void {
  cardCommand
    .command("update")
    .description("MUTAÇÃO: atualiza atributos principais do cartão")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardUpdateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card update.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.updateCard(parsed.data);
      })
    );
}
