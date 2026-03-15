import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { moveCardStepPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CardMoveStepOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardMoveStepCommand(cardCommand: Command): void {
  cardCommand
    .command("move-step")
    .description("MUTAÇÃO: move cartão de etapa sem enviar values")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardMoveStepOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = moveCardStepPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card move-step.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.moveCardStep(parsed.data);
      })
    );
}
