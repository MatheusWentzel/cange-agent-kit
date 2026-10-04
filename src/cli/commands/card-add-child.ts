import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { addChildCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { normalizeNumericValueKeys, readPayloadFile } from "../helpers.js";

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
      createCommandAction(async ({ kit, ensureAuth }, options: CardAddChildOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = addChildCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card add-child.", {
            details: parsed.error.format()
          });
        }

        // R5-KR-03: o `map` e o `card read` enxutos mostram o id numérico do campo,
        // sem o hash. O add-child cria o filho e só DEPOIS vincula, sem transação:
        // um linkField numérico só falhava no PUT e deixava o filho órfão. Traduz
        // id → hash ANTES do POST (values pelo fluxo filho, linkField pelo fluxo
        // pai); id que não existe falha aqui, antes de criar qualquer coisa.
        const { child, parent } = parsed.data;
        child.values = (await normalizeNumericValueKeys(kit, child.flowId, child.values, ensureAuth)).values;
        if (/^\d+$/.test(parent.linkField)) {
          const link = await normalizeNumericValueKeys(kit, parent.flowId, { [parent.linkField]: true }, ensureAuth);
          parent.linkField = Object.keys(link.values)[0] ?? parent.linkField;
        }

        if (options.dryRun) {
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
