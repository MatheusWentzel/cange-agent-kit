import type { Command } from "commander";

import type { CangeAgentKit } from "../../index.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { moveCardStepWithValuesPayloadSchema } from "../../schemas/cards.js";
import { detectDataLoss, type DataLossCheck } from "../../utils/dataLoss.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { getExpectedFormatByFieldType } from "../../utils/fieldTypeGuards.js";
import { createCommandAction } from "../context.js";
import { assertValidationResult, readPayloadFile } from "../helpers.js";

interface CardMoveStepWithValuesOptions {
  payload?: string;
  validateFields?: boolean;
  dryRun?: boolean;
  discoverRequired?: boolean;
  flowId?: string;
  formId?: string;
  allowSelfMove?: boolean;
  allowDataLoss?: boolean;
  failOnDataLoss?: boolean;
}

export function registerCardMoveStepWithValuesCommand(cardCommand: Command): void {
  cardCommand
    .command("move-step-with-values")
    .description("MUTAÇÃO: move cartão de etapa com values")
    .option("--payload <path>", "Caminho do JSON de payload")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar")
    .option(
      "--discover-required",
      "Descobre campos obrigatórios do form antes da mutação (sem executar escrita)"
    )
    .option("--flow-id <id>", "Flow ID para descoberta quando não houver payload")
    .option("--form-id <id>", "Form ID para descoberta quando não houver payload")
    .option(
      "--allow-self-move",
      "Permite mover para a mesma etapa (fromStepId === toStepId). Bloqueado por padrão: self-move duplica o form_answer."
    )
    .option(
      "--allow-data-loss",
      "Desativa a checagem de campos preenchidos ausentes do values (perda de dados intencional)."
    )
    .option(
      "--fail-on-data-loss",
      "Bloqueia a mutação se houver campos preenchidos no card ausentes do values."
    )
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardMoveStepWithValuesOptions) => {
        if (options.discoverRequired) {
          const discovery = await discoverRequiredForMove(kit, options);
          return {
            mode: "discover-required",
            context: {
              flowId: discovery.flowId,
              formId: discovery.formId
            },
            requiredFields: discovery.requiredFields,
            optionalCount: discovery.fields.length - discovery.requiredFields.length,
            totalFields: discovery.fields.length
          };
        }

        if (!options.payload) {
          throw new CangeCliUsageError(
            "Informe --payload para mover o card ou use --discover-required para descoberta."
          );
        }

        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = moveCardStepWithValuesPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card move-step-with-values.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;

        // M1 — Guard de self-move. O endpoint /card/v2/move-step NÃO bloqueia
        // fromStepId === toStepId (diferente da v1), e cada move cria um
        // form_answer novo: um self-move seguido do move real duplica o
        // form_answer e o snapshot vazio mais recente sobrepõe o preenchido.
        if (payload.fromStepId === payload.toStepId && !options.allowSelfMove) {
          throw new CangeValidationError(
            "Self-move bloqueado: fromStepId === toStepId. Mover para a mesma etapa cria um " +
              "form_answer duplicado (o snapshot mais recente sobrepõe o anterior). Para apenas " +
              "atualizar values sem mover, use `card update-values`. Se o self-move for realmente " +
              "intencional, repita com --allow-self-move.",
            {
              details: {
                fromStepId: payload.fromStepId,
                toStepId: payload.toStepId,
                suggestion: "card update-values"
              }
            }
          );
        }

        // O wrapper de comando pula a autenticação em --dry-run (premissa de que
        // dry-run não faz I/O). Mas a validação (getFieldsByFlow) e o detector de
        // perda de dados (getCard) leem da API mesmo em dry-run — então garantimos
        // o login aqui quando algum passo de leitura for rodar.
        const willReadInDryRun = options.validateFields || !options.allowDataLoss;
        if (options.dryRun && willReadInDryRun) {
          await ensureAuth();
        }

        let targetFields: NormalizedField[] | undefined;
        if (options.validateFields) {
          const fieldsData = await kit.contracts.getFieldsByFlow({ flowId: payload.flowId });
          targetFields = fieldsData.fields.filter(
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

        // M2 — Detector de perda de dados (read-before-write). Lê o estado atual
        // do card e aponta campos preenchidos do form alvo ausentes do `values`.
        // Resiliente: nunca bloqueia por falha de leitura.
        const dataLossCheck: DataLossCheck = options.allowDataLoss
          ? {
              checked: false,
              orphans: [],
              note: "Checagem de perda de dados desativada por --allow-data-loss."
            }
          : await detectDataLoss({ kit, payload, targetFields });

        if (dataLossCheck.orphans.length > 0 && options.failOnDataLoss) {
          throw new CangeValidationError(
            "Perda de dados detectada: há campos preenchidos no card ausentes do values. " +
              "Bloqueado por --fail-on-data-loss. Inclua-os no values ou remova a flag.",
            { details: dataLossCheck }
          );
        }

        if (options.dryRun) {
          return {
            ...createDryRunResult(payload),
            dataLossCheck
          };
        }

        const result = await kit.contracts.moveCardStepWithValues(payload);
        if (dataLossCheck.orphans.length > 0) {
          return {
            ...result,
            warning: dataLossCheck.note,
            dataLossCheck
          };
        }
        return result;
      })
    );
}

async function discoverRequiredForMove(
  kit: CangeAgentKit,
  options: CardMoveStepWithValuesOptions
): Promise<{
  flowId: number | string;
  formId: number | string;
  fields: NormalizedField[];
  requiredFields: Array<Record<string, unknown>>;
}> {
  const payloadHints = options.payload ? await readPayloadHints(options.payload) : {};
  const flowId = options.flowId ?? payloadHints.flowId;
  const formId = options.formId ?? payloadHints.formId;

  if (!flowId || !formId) {
    throw new CangeCliUsageError(
      "Para --discover-required, informe --flow-id e --form-id (ou forneça --payload com flowId e idForm)."
    );
  }

  const fieldsData = await kit.contracts.getFieldsByFlow({ flowId });
  const targetFields = fieldsData.fields.filter((field) => String(field.formId) === String(formId));
  if (targetFields.length === 0) {
    throw new CangeValidationError("Nenhum field encontrado para o idForm informado no flow.", {
      details: {
        flowId,
        formId
      }
    });
  }

  const requiredFields = targetFields
    .filter((field) => field.required)
    .map((field) => ({
      id: field.id,
      name: field.name,
      title: field.title,
      description: field.description,
      type: field.type,
      expectedFormat: getExpectedFormatByFieldType(field.type),
      required: true,
      options: normalizeFieldOptions(field.options)
    }));

  return {
    flowId,
    formId,
    fields: targetFields,
    requiredFields
  };
}

async function readPayloadHints(
  payloadPath: string
): Promise<{ flowId?: string; formId?: string }> {
  const payload = await readPayloadFile<Record<string, unknown>>(payloadPath);
  const flowId = coerceStringId(payload.flowId);
  const formId = coerceStringId(payload.idForm);
  return {
    flowId,
    formId
  };
}

function coerceStringId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function normalizeFieldOptions(options: unknown): Array<string | number | Record<string, unknown>> | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }

  return options.map((option) => {
    if (typeof option === "string" || typeof option === "number") {
      return option;
    }
    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      return {
        raw: option
      };
    }
    const record = option as Record<string, unknown>;
    return {
      id: record.id ?? record.id_field_option ?? record.field_option_id ?? record.option_id,
      value: record.value,
      title: record.title ?? record.label ?? record.name,
      raw: record
    };
  });
}
