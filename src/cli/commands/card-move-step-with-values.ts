import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { moveCardStepWithValuesPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface CardMoveStepWithValuesOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
}

export function registerCardMoveStepWithValuesCommand(cardCommand: Command): void {
  cardCommand
    .command("move-step-with-values")
    .description("MUTAÇÃO: move cartão de etapa com values")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardMoveStepWithValuesOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = moveCardStepWithValuesPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card move-step-with-values.", {
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

        return kit.contracts.moveCardStepWithValues(payload);
      })
    );
}
