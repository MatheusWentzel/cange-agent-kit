import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { moveCardStepPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";
import { checkPayloadMove } from "../move-required.js";
import { authOnce, throwIfInvalid, validationSummary } from "../write-support.js";

interface CardMoveStepOptions {
  payload: string;
  validateFields?: boolean;
  allowDataLoss?: boolean;
  dryRun?: boolean;
}

export function registerCardMoveStepCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("move-step")
    .description("MUTAÇÃO (DEPRECATED): use `card move-step-with-values`")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do idForm (os obrigatórios da etapa atual são sempre exigidos)")
    .option(
      "--allow-data-loss",
      "Perda de dados intencional: não reenvia o que o cartão já tem na etapa atual e aceita perder o rascunho dela"
    )
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardMoveStepOptions) => {
        // Item 6: aviso de deprecação em stderr (não polui stdout/JSON).
        process.stderr.write(
          "⚠️  `card move-step` está DEPRECATED — use `card move-step-with-values`. " +
            "Este alias será removido em versão futura.\n"
        );
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = moveCardStepPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card move-step.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;
        // O wrapper pula o login em --dry-run, mas este comando sempre lê (fluxo e cartão).
        await authOnce(kit, ensureAuth)();

        // Decisão 1 (06/10): o alias também exige os obrigatórios da etapa ATUAL do cartão,
        // sempre (lê fluxo e cartão, inclusive em --dry-run).
        // F3 (revisão 07/10): o bloqueio do rascunho manda repetir com --allow-data-loss; o
        // alias aceita a flag, com o mesmo efeito do move-step-with-values.
        const check = await checkPayloadMove(kit, payload, payload.values, undefined, {
          resend: options.allowDataLoss !== true,
          allowDataLoss: options.allowDataLoss === true
        });
        // EXTRA-06 D1: gravando a etapa atual, reenvia o que o cartão tem nela (o rascunho da tela).
        payload.values = check.values;

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

        const validation = validationSummary(check.issues);

        if (options.dryRun) {
          const result = createDryRunResult(payload);
          const output = {
            ...result,
            validation,
            ...(check.warning ? { warning: check.warning } : {}),
            note: `${result.note} Comando deprecated: use card move-step-with-values.`
          };
          return validation.valid ? output : withExitCode(output, EXIT_CODES.USAGE);
        }
        throwIfInvalid(check.issues);

        const result = await kit.contracts.moveCardStepWithValues(payload);
        return {
          ...result,
          warning: [check.warning, "Comando deprecated: use card move-step-with-values."].filter(Boolean).join(" ")
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    deprecatedInFavorOf: "card move-step-with-values",
    envelope: "{ raw, summary } (ou { note, payload } em --dry-run)",
    example: "card move-step-with-values --payload ./payloads/move.json"
  });
}
