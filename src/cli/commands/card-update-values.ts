import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { updateCardValuesPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface CardUpdateValuesOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
}

export function registerCardUpdateValuesCommand(cardCommand: Command): void {
  cardCommand
    .command("update-values")
    .description("MUTAÇÃO: atualiza respostas dinâmicas (values) do cartão")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields antes de mutar")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardUpdateValuesOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateCardValuesPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card update-values.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        if (options.validateFields) {
          const fieldsData = await kit.contracts.getFieldsByFlow({ flowId: payload.flowId });
          const targetFields = fieldsData.fields.filter(
            (field) => String(field.formId) === String(payload.idForm)
          );

          if (targetFields.length === 0) {
            throw new CangeValidationError(
              "Nenhum field encontrado para o idForm informado no flow.",
              {
                details: {
                  flowId: payload.flowId,
                  idForm: payload.idForm
                }
              }
            );
          }

          const validation = kit.contracts.validateValuesAgainstFields({
            values: payload.values,
            fields: targetFields,
            requireRequiredFields: false,
            targetFormId: payload.idForm
          });
          assertValidationResult(validation.valid, validation);
        }

        if (options.dryRun) {
          return createDryRunResult(payload);
        }

        return kit.contracts.updateCardValues(payload);
      })
    );
}
