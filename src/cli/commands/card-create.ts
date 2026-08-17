import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, normalizeNumericValueKeys, readPayloadFile } from "../helpers.js";

interface CardCreateOptions {
  payload: string;
  validateFields?: boolean;
  dryRun?: boolean;
  full?: boolean;
}

export function registerCardCreateCommand(cardCommand: Command): void {
  cardCommand
    .command("create")
    .description("MUTAÇÃO: cria card com base em payload JSON")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .option("--full", "Devolve o envelope completo (raw + summary). Default: só {cardId, stepId, createdAt}")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card create.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;
        const normalized = await normalizeNumericValueKeys(kit, payload.flowId, payload.values, ensureAuth);
        payload.values = normalized.values;

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

        const result = await kit.contracts.createCard(payload);
        if (options.full) {
          return result;
        }
        // 5.3 (retro runs 16-19): a saída default é ENXUTA — o envelope completo
        // (raw de dezenas de KB) inundava o contexto do agente, que pipava o
        // output para node só para comprimir. --full devolve tudo.
        const s = result.summary as Record<string, unknown>;
        return {
          cardId: s.cardId ?? s.id_card,
          stepId: s.currentStepId ?? s.step_id,
          flowId: s.flowId ?? s.flow_id,
          createdAt: s.createdAt,
          ...(normalized.translatedKeys.length > 0 ? { translatedKeys: normalized.translatedKeys } : {})
        };
      })
    );
}
