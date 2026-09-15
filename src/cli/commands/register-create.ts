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
        assertNoLegacyRegisterContext(payloadRaw);
        const parsed = createRegisterPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para register create.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        if (options.validateFields) {
          const registerId = options.registerId ?? String(payload.registerId);

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

/**
 * O payload antigo levava o id do cadastro aninhado em `registerContext`, que o
 * backend nunca leu: toda criação morria em 404 "não foi possível encontrar a
 * referência do formulário". Quem ainda tiver payload no formato velho recebe a
 * instrução de migração em vez do erro genérico de schema.
 */
function assertNoLegacyRegisterContext(payloadRaw: unknown): void {
  if (
    typeof payloadRaw !== "object" ||
    payloadRaw === null ||
    !("registerContext" in payloadRaw) ||
    "registerId" in payloadRaw
  ) {
    return;
  }

  const legacy = (payloadRaw as { registerContext?: unknown }).registerContext;
  const hint = extractLegacyRegisterId(legacy);
  throw new CangeCliUsageError(
    "Payload no formato antigo: `registerContext` foi removido porque o backend nunca o leu " +
      "(POST /form/new-answer espera `register_id` no nível raiz). " +
      `Troque por "registerId": ${hint ?? "<id do cadastro>"} no nível raiz do payload.`
  );
}

function extractLegacyRegisterId(registerContext: unknown): string | undefined {
  if (typeof registerContext !== "object" || registerContext === null) {
    return undefined;
  }
  const context = registerContext as Record<string, unknown>;
  const candidates = [context.registerId, context.idRegister, context.register_id];
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
