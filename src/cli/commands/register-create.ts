import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { createRegisterPayloadSchema } from "../../schemas/registers.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface RegisterCreateOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
  registerId?: string;
}

export function registerRegisterCreateCommand(registerCommand: Command): void {
  registerCommand
    .command("create")
    .description("MUTAÇÃO: cria resposta de cadastro (register)")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields antes de mutar")
    .option("--register-id <id>", "ID do register para validação de fields")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: RegisterCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createRegisterPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para register create.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        if (options.validateFields) {
          const registerId = options.registerId ?? extractRegisterId(payload.registerContext);
          if (!registerId) {
            throw new CangeCliUsageError(
              "Para --validate-fields em register create, informe --register-id ou registerContext com registerId."
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

        return kit.contracts.createRegister(payload);
      })
    );
}

function extractRegisterId(
  registerContext: Record<string, unknown> | undefined
): string | undefined {
  if (!registerContext) {
    return undefined;
  }
  const candidates = [registerContext.registerId, registerContext.idRegister, registerContext.register_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}
