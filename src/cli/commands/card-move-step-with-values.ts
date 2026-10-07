import type { Command } from "commander";

import type { CangeAgentKit } from "../../index.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { moveCardStepWithValuesPayloadSchema } from "../../schemas/cards.js";
import { dataLossFromCarry, detectDataLoss, type DataLossCheck } from "../../utils/dataLoss.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { getExpectedFormatByFieldType } from "../../utils/fieldTypeGuards.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";
import { findMissingRequired, type FormScope, type ValueIssue } from "../../utils/valueResolver.js";
import { checkPayloadMove } from "../move-required.js";
import {
  addInlineValueOptions,
  authOnce,
  createWriteLookups,
  formScope,
  initScope,
  loadFlowContext,
  mergedValues,
  needsFieldResolution,
  parseInlineValues,
  resolveLayers,
  stepLabel,
  throwIfInvalid,
  validationSummary
} from "../write-support.js";
import { withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import { runInlineMove, type MoveInlineOptions } from "./card-move.js";

interface CardMoveStepWithValuesOptions extends MoveInlineOptions {
  payload?: string;
  discoverRequired?: boolean;
  flowId?: string;
  formId?: string;
  allowSelfMove?: boolean;
  allowDataLoss?: boolean;
}

export function registerCardMoveStepWithValuesCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("move-step-with-values")
    .description(
      "MUTAÇÃO: move cartão de etapa. Caminho curto: `card move --card-id N --to <etapa> --set ...` (mesmas flags aqui sem --payload)"
    )
    .option("--payload <path>", "AVANÇADO: arquivo JSON {flowId, cardId, fromStepId, toStepId, idForm, values}")
    .option("--card-id <id>", "Sem --payload: cartão a mover (origem = etapa atual)")
    .option("--to <etapa>", "Sem --payload: etapa de destino (nome ou id)");
  addInlineValueOptions(command);
  command
    .option(
      "--validate-fields",
      "Também recusa chave desconhecida e cobra os obrigatórios do idForm (os da etapa atual são sempre exigidos)"
    )
    .option(
      "--discover-required",
      "Descobre campos obrigatórios do form antes da mutação (sem executar escrita)"
    )
    .option("--flow-id <id>", "Fluxo (descoberta, ou o cartão no modo sem --payload)")
    .option("--form-id <id>", "Form ID para descoberta quando não houver payload")
    .option(
      "--allow-self-move",
      "Permite mover para a mesma etapa (fromStepId === toStepId). Bloqueado por padrão: self-move duplica o form_answer."
    )
    .option(
      "--allow-data-loss",
      "Perda de dados intencional: não reenvia o que o cartão já tem na etapa atual e não confere campos preenchidos ausentes do values."
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
          if (options.cardId !== undefined || options.to !== undefined || parseInlineValues(options)) {
            return runInlineMove(kit, ensureAuth, options, "card move-step-with-values");
          }
          throw new CangeCliUsageError(
            'Informe o cartão e o destino: `cange card move --card-id <id> --to "<etapa>" [--set "Campo=valor"]` ' +
              "(ou --payload <arquivo>, ou --discover-required)."
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
        const inline = parseInlineValues(options);
        const auth = authOnce(kit, ensureAuth);

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
        // dry-run não faz I/O). Mas a conferência dos obrigatórios da etapa atual
        // (decisão 1, sempre) lê o fluxo e o cartão mesmo em dry-run: login aqui.
        await auth();
        const ctx = await loadFlowContext(kit, payload.flowId);
        const targetFormId = String(payload.idForm ?? stepFormId(ctx.steps, payload.toStepId) ?? "");
        const target = formScope(ctx.fields, targetFormId, describeForm(ctx, payload, targetFormId), 0);
        const targetFields: NormalizedField[] = target.fields;

        let validation: ReturnType<typeof validationSummary> | undefined;
        let finalValues: Record<string, unknown> = payload.values;
        const issues: ValueIssue[] = [];
        const resolveNeeded = needsFieldResolution(
          { ...payload.values, ...(inline ?? {}) },
          options.validateFields === true || inline !== undefined
        );
        if (resolveNeeded) {
          // P4: o validate-fields filtrava SÓ pelo idForm do payload e dizia "não existe na
          // estrutura consultada" para um campo da outra etapa (10 erros em 5 runs). Agora
          // a chave é procurada em todos os formulários do fluxo e o erro diz de qual etapa
          // o campo é; o `card move` separa os formulários sozinho.
          const others: FormScope[] = [];
          const seen = new Set([targetFormId]);
          const addOther = (formId: string | number | undefined, label: string): void => {
            if (formId === undefined || seen.has(String(formId))) return;
            seen.add(String(formId));
            others.push(formScope(ctx.fields, formId, label, 9));
          };
          for (const step of ctx.steps) addOther(step.formId, describeForm(ctx, payload, String(step.formId)));
          const init = initScope(ctx, 9);
          if (init) addOther(init.formId, init.label);

          const resolution = await resolveLayers({
            layers: [payload.values, inline],
            forms: [target],
            outOfScope: others,
            lookups: createWriteLookups(kit, auth),
            passthroughUnknown: options.validateFields !== true
          });
          finalValues = mergedValues(resolution);
          issues.push(...resolution.issues);
          if (issues.some((issue) => issue.kind === "out_of_scope")) {
            issues.push({
              kind: "invalid_value",
              blocking: true,
              text: `o idForm ${targetFormId} só grava ${target.label}. \`cange card move --card-id ${payload.cardId} --to ${payload.toStepId} --set "Campo=valor"\` separa os formulários sozinho`
            });
          }
        }

        // Decisão 1 (06/10): os obrigatórios da etapa ATUAL do cartão, sempre (com ou sem
        // --validate-fields/--dry-run). Lê o cartão uma vez (o detector de perda reaproveita).
        // EXTRA-06 D1: gravando a etapa atual, o kit reenvia o que o cartão tem nela (o
        // rascunho que a tela mostra) com o values por cima; --allow-data-loss desliga.
        const check = await checkPayloadMove(kit, payload, finalValues, ctx, {
          resend: options.allowDataLoss !== true,
          allowDataLoss: options.allowDataLoss === true
        });
        finalValues = check.values;
        issues.push(...check.issues);
        // --validate-fields com o idForm de OUTRO formulário: cobra também os obrigatórios dele
        // (o da etapa atual já foi cobrado acima; sem repetir a mesma linha).
        if (options.validateFields && targetFormId !== check.originFormId) {
          issues.push(...findMissingRequired(target, finalValues));
        }
        if (options.dryRun) {
          validation = validationSummary(issues);
          if (!validation.valid) {
            return withExitCode(
              { ...createDryRunResult({ ...payload, values: finalValues }), validation },
              EXIT_CODES.USAGE
            );
          }
        } else {
          throwIfInvalid(issues);
        }
        payload.values = finalValues;

        // M2 — Detector de perda de dados (read-before-write). Lê o estado atual
        // do card e aponta campos preenchidos do form alvo ausentes do `values`.
        // Resiliente: nunca bloqueia por falha de leitura.
        // Gravando a etapa atual, a régua é a fonte da tela (rascunho incluído): sobra só o
        // que o kit não consegue reenviar. Outro formulário: o detector de sempre (GET /card).
        const dataLossCheck: DataLossCheck = options.allowDataLoss
          ? {
              checked: false,
              orphans: [],
              note: "Checagem de perda de dados desativada por --allow-data-loss."
            }
          : check.writesOrigin && check.carry
            ? dataLossFromCarry(check.carry, finalValues, targetFields, check.writtenFormId)
            : await detectDataLoss({ kit, payload, targetFields, card: check.card });

        if (dataLossCheck.orphans.length > 0 && options.failOnDataLoss) {
          throw new CangeValidationError(
            "Perda de dados detectada: há campos preenchidos no card ausentes do values. " +
              "Bloqueado por --fail-on-data-loss. Inclua-os no values ou remova a flag.",
            { details: dataLossCheck }
          );
        }

        // Obrigatório com condicional vazio não bloqueia (o kit não avalia a condicional): avisa.
        const keptInfo = {
          ...(check.kept.length > 0 && check.carry ? { kept: check.kept.length, keptFrom: check.carry.source } : {}),
          ...(check.autocompleted.length > 0 ? { autocompleted: check.autocompleted } : {})
        };
        if (options.dryRun) {
          return {
            ...createDryRunResult(payload),
            ...keptInfo,
            ...(validation ? { validation } : {}),
            ...(check.warning ? { warning: check.warning } : {}),
            dataLossCheck
          };
        }

        const result = await kit.contracts.moveCardStepWithValues(payload);
        const hasOrphans = dataLossCheck.orphans.length > 0;
        // Gravando a etapa atual, os órfãos são os "Não reenviados" que já estão no check.warning.
        const orphanNote = hasOrphans && !(check.writesOrigin && check.carry) ? [dataLossCheck.note] : [];
        const warnings = [...orphanNote, ...(check.warning ? [check.warning] : [])];
        if (warnings.length === 0) return { ...result, ...keptInfo };
        return { ...result, ...keptInfo, warning: warnings.join(" "), ...(hasOrphans ? { dataLossCheck } : {}) };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "Com --payload: resposta do move (+ dataLossCheck). Sem --payload: igual a `card move`.",
    fieldsLocation:
      "Prefira `card move --card-id N --to <etapa> --set ...` (1 passo). Mover exige os obrigatórios da etapa atual (sempre). Com --payload, o idForm é o form da etapa ATUAL e os values são só desse form; o kit reenvia o que o cartão já tem nele (o rascunho que a tela mostra), salvo com --allow-data-loss.",
    example: 'card move-step-with-values --card-id 1234 --to "Agendamento" --set "Data da ligação=06/10/2026"'
  });
}

/** Rótulo do formulário para as mensagens: etapa atual, destino, inicial. */
function describeForm(
  ctx: Awaited<ReturnType<typeof loadFlowContext>>,
  payload: { fromStepId: number; toStepId: number },
  formId: string
): string {
  const step = ctx.steps.find((item) => String(item.formId) === formId);
  if (!step) return ctx.formInitId === formId ? "formulário inicial" : `form ${formId}`;
  if (String(step.id) === String(payload.fromStepId)) return `${stepLabel(step)} (atual)`;
  if (String(step.id) === String(payload.toStepId)) return `${stepLabel(step)} (destino)`;
  return stepLabel(step);
}

function stepFormId(steps: Array<{ id?: number | string; formId?: number | string }>, stepId: number): string | undefined {
  const step = steps.find((item) => String(item.id) === String(stepId));
  return step?.formId !== undefined ? String(step.formId) : undefined;
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
