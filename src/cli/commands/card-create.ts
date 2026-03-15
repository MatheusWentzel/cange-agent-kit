import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface CardCreateOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
}

export function registerCardCreateCommand(cardCommand: Command): void {
  cardCommand
    .command("create")
    .description("MUTAÇÃO: cria card com base em payload JSON")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CardCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card create.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        if (options.validateFields) {
          const formContext = await kit.contracts.getFlowInitFormFields({
            flowId: payload.flowId
          });
          if (String(formContext.formId) !== String(payload.idForm)) {
            throw new CangeValidationError(
              "idForm divergente do formulário inicial do flow (flow.form_init_id).",
              {
                details: {
                  payloadIdForm: payload.idForm,
                  flowFormInitId: formContext.formId
                }
              }
            );
          }

          const validation = kit.contracts.validateValuesAgainstFields({
            values: payload.values,
            fields: formContext.fields,
            requireRequiredFields: true,
            targetFormId: formContext.formId
          });
          assertValidationResult(validation.valid, validation);
        }

        if (options.dryRun) {
          return createDryRunResult(payload);
        }

        return kit.contracts.createCard(payload);
      })
    );
}
