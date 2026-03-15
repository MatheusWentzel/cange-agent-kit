import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { updateRegisterPayloadSchema } from "../../schemas/registers.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface RegisterUpdateOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
  registerId?: string;
}

export function registerRegisterUpdateCommand(registerCommand: Command): void {
  registerCommand
    .command("update")
    .description("MUTAÇÃO: atualiza resposta dinâmica de register")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields antes de mutar")
    .option("--register-id <id>", "ID do register para validação de fields")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: RegisterUpdateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateRegisterPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para register update.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        if (options.validateFields) {
          const registerId =
            options.registerId ??
            (typeof payload.registerId === "number" ? String(payload.registerId) : payload.registerId);
          if (!registerId) {
            throw new CangeCliUsageError(
              "Para --validate-fields em register update, informe --register-id ou registerId no payload."
            );
          }

          const formContext = await kit.contracts.getRegisterFormFields({
            registerId
          });

          if (String(formContext.formId) !== String(payload.idForm)) {
            throw new CangeValidationError("idForm divergente do register.form_id.", {
              details: {
                payloadIdForm: payload.idForm,
                registerFormId: formContext.formId
              }
            });
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

        return kit.contracts.updateRegister(payload);
      })
    );
}
