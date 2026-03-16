import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { moveCardStepPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface CardMoveStepOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
}

export function registerCardMoveStepCommand(cardCommand: Command): void {
  cardCommand
    .command("move-step")
    .description("MUTAÇÃO (DEPRECATED): alias de move-step-with-values")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar")
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
            requireRequiredFields: true,
            targetFormId: payload.idForm
          });
          assertValidationResult(validation.valid, validation);
        }

        if (options.dryRun) {
          const result = createDryRunResult(payload);
          return {
            ...result,
            note: `${result.note} Comando deprecated: use card move-step-with-values.`
          };
        }

        const result = await kit.contracts.moveCardStepWithValues(payload);
        return {
          ...result,
          warning: "Comando deprecated: use card move-step-with-values."
        };
      })
    );
}
