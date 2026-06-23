import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { addChildCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CardAddChildOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardAddChildCommand(cardCommand: Command): void {
  cardCommand
    .command("add-child")
    .description(
      "MUTAÇÃO: cria um card filho em outro fluxo e o vincula ao campo 'Meus Fluxos' do pai. O campo é multi-valor e REPLACE — passe parent.existingChildIds para não apagar vínculos existentes (read-modify-write)."
    )
    .requiredOption("--payload <path>", "Caminho do JSON de payload (child + parent)")
    .option("--dry-run", "Exibe o payload normalizado sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardAddChildOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = addChildCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card add-child.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          const { child, parent } = parsed.data;
          return createDryRunResult({
            ...parsed.data,
            preview: {
              willCreateChildInFlow: child.flowId,
              willLinkOnParentField: parent.linkField,
              resultingChildIds: "[...existingChildIds, novoId] (REPLACE do campo multi-valor)"
            }
          });
        }

        return kit.contracts.addChildCard(parsed.data);
      })
    );
}
