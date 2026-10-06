import type { Command } from "commander";

import { CangeCliUsageError, CangeError, CangeValidationError } from "../../client/errors.js";
import type { CangeAgentKit } from "../../index.js";
import { readCarryOver } from "../../utils/carryOver.js";
import {
  findMissingRequired,
  valuesOf,
  type FormScope,
  type ValueIssue
} from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  addInlineValueOptions,
  authOnce,
  createWriteLookups,
  fieldTitles,
  findStep,
  initScope,
  loadFlowContext,
  otherStepScopes,
  parseInlineValues,
  requireCardId,
  resolveLayers,
  resolveWriteFlowId,
  stepLabel,
  stepScope,
  throwIfInvalid,
  validationSummary,
  type InlineValueOptions
} from "../write-support.js";

/**
 * P4/P5 (05/10, cards #1367455 e #1367456): mover em 1 passo.
 *
 *   cange card move --card-id 123 --to "Agendamento" --set "Data da ligação=06/10/2026"
 *
 * - Etapa de ORIGEM = a etapa atual do cartão (lida do cartão; nada de fromStepId).
 * - Destino por nome ou id.
 * - Cada campo é procurado nos formulários da etapa atual, do destino e no inicial,
 *   e vai para a chamada certa (o back aceita UM formulário por chamada):
 *     1. formulário inicial: PUT /form/answer, antes de mover;
 *     2. etapa atual: no próprio POST /card/v2/move-step (id_form = form da etapa
 *        atual, como a tela), junto com os campos que o cartão JÁ TEM nesse
 *        formulário (o mover grava um snapshot novo; sem reenviar, eles sumiriam);
 *     3. etapa de destino: PUT /form/answer, depois de mover.
 *   No caso comum (só campos da etapa atual, ou nenhum) é UMA chamada só.
 */

export interface MoveInlineOptions extends InlineValueOptions {
  cardId?: string;
  flowId?: string;
  to?: string;
  dryRun?: boolean;
  validateFields?: boolean;
  failOnDataLoss?: boolean;
}

interface PlannedCall {
  call: "PUT /form/answer" | "POST /card/v2/move-step";
  action: "card_update" | "card_move";
  form: string;
  payload: Record<string, unknown>;
}

export function registerCardMoveCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("move")
    .description(
      "MUTAÇÃO: move o cartão para outra etapa em 1 passo (origem = etapa atual). --set grava campos da etapa atual, do destino ou do formulário inicial"
    )
    .option("--card-id <id>", "Cartão (número ou link)")
    .option("--to <etapa>", "Etapa de destino: nome ou id")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link do cartão ou do ambiente do run)");
  addInlineValueOptions(command);
  command
    .option("--validate-fields", "Também exige os obrigatórios da etapa atual antes de mover")
    .option("--fail-on-data-loss", "Bloqueia se algum campo preenchido da etapa atual não puder ser reenviado")
    .option("--dry-run", "Mostra as chamadas resolvidas e a validação, sem gravar (exit 2 se inválido)")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: MoveInlineOptions) =>
        runInlineMove(kit, ensureAuth, options, "card move")
      )
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      "{ ok, cardId, flowId, fromStepId, toStepId, written[], kept, summary, warning? }. --dry-run: { dryRun, executed:false, calls[{call, action, form, payload}], validation }",
    fieldsLocation:
      "Origem = etapa atual do cartão. Campo pelo título, id ou hash, de qualquer um dos 3 formulários (etapa atual, destino, inicial). Mesma etapa = use card update-values.",
    example: 'card move --card-id 1234 --to "Agendamento" --set "Data da ligação=06/10/2026" --set "Valor do Negócio=2.500,00"'
  });
}

export async function runInlineMove(
  kit: CangeAgentKit,
  ensureAuth: () => Promise<unknown>,
  options: MoveInlineOptions,
  commandName: string
): Promise<unknown> {
  const cardId = requireCardId(options.cardId, commandName);
  if (!options.to || options.to.trim() === "") {
    throw new CangeCliUsageError(`Informe a etapa de destino: \`cange ${commandName} --card-id ${cardId} --to "<etapa>"\`.`);
  }
  const flowId = resolveWriteFlowId(options.flowId);
  const inline = parseInlineValues(options);
  const auth = authOnce(kit, ensureAuth);
  await auth();

  const [ctx, card] = await Promise.all([loadFlowContext(kit, flowId), kit.contracts.getCard({ flowId, cardId })]);

  const fromStep = ctx.steps.find((step) => String(step.id) === String(card.summary.currentStepId));
  if (!fromStep) {
    throw new CangeValidationError(
      `Não achei a etapa atual do cartão ${cardId} no fluxo ${flowId} (etapa ${String(card.summary.currentStepId ?? "?")}).`
    );
  }
  const toStep = findStep(ctx.steps, options.to);
  if (String(toStep.id) === String(fromStep.id)) {
    throw new CangeCliUsageError(
      `O cartão ${cardId} já está na ${stepLabel(fromStep)}. Para gravar campos sem mover: ` +
        `\`cange card update-values --card-id ${cardId} --set "Campo=valor"\`.`
    );
  }

  const origin = stepScope(ctx, fromStep, 0, " (atual)");
  const destination = stepScope(ctx, toStep, 1, " (destino)");
  const init = initScope(ctx, 2);
  const forms: FormScope[] = [];
  for (const scope of [origin, destination, init]) {
    if (scope && !forms.some((form) => form.formId === scope.formId)) forms.push(scope);
  }
  const outOfScope = otherStepScopes(ctx, new Set(forms.map((form) => form.formId)));

  const { resolved, issues } = await resolveLayers({
    layers: [inline],
    forms,
    outOfScope,
    lookups: createWriteLookups(kit, auth)
  });

  // Campos que o cartão já tem na etapa atual: reenviados no mover (a tela faz igual).
  const carry = origin ? readCarryOver(card.raw, origin.formId, origin.fields) : undefined;
  const originValues = origin ? valuesOf(resolved, origin.formId) : {};
  const moveValues = { ...(carry?.values ?? {}), ...originValues };

  const requiredIssues: ValueIssue[] = [];
  if (origin && (options.validateFields || options.dryRun) && !skipsRequired(ctx.flowRecord, fromStep, toStep)) {
    requiredIssues.push(...findMissingRequired(origin, moveValues, carry?.filled));
  }
  const notKept = carry?.notKept ?? [];
  const dataLossIssues: ValueIssue[] =
    options.failOnDataLoss && notKept.length > 0
      ? [
          {
            kind: "invalid_value",
            blocking: true,
            text: `o mover não consegue reenviar ${notKept.map((item) => item.title ?? item.name).join(", ")} (ficariam vazios na etapa atual). Tire --fail-on-data-loss para mover assim mesmo`
          }
        ]
      : [];
  const allIssues = [...issues, ...requiredIssues, ...dataLossIssues];

  const isEnd = String(toStep.raw.isEndStep ?? toStep.raw.is_end_step ?? "") === "1";
  const calls: PlannedCall[] = [];
  const base = { flowId: Number(flowId), cardId: Number(cardId) };
  const initValues = init && init.formId !== origin?.formId ? valuesOf(resolved, init.formId) : {};
  const destValues =
    destination && destination.formId !== origin?.formId ? valuesOf(resolved, destination.formId) : {};

  if (Object.keys(initValues).length > 0 && init) {
    calls.push({
      call: "PUT /form/answer",
      action: "card_update",
      form: init.label,
      payload: { ...base, idForm: Number(init.formId), values: initValues }
    });
  }
  calls.push({
    call: "POST /card/v2/move-step",
    action: "card_move",
    form: origin?.label ?? `${stepLabel(toStep)} (destino)`,
    payload: {
      ...base,
      fromStepId: Number(fromStep.id),
      toStepId: Number(toStep.id),
      // Sem form na etapa atual (raro): o contrato resolve o form do destino.
      ...(origin ? { idForm: Number(origin.formId) } : {}),
      values: origin ? moveValues : destValues,
      complete: isEnd ? "S" : "N",
      isFromCurrentStep: true
    }
  });
  if (origin && Object.keys(destValues).length > 0 && destination) {
    calls.push({
      call: "PUT /form/answer",
      action: "card_update",
      form: destination.label,
      payload: { ...base, idForm: Number(destination.formId), values: destValues }
    });
  }

  const warning =
    notKept.length > 0
      ? `Não reenviados (ficam vazios na ${stepLabel(fromStep)}): ${notKept.map((item) => item.title ?? item.name).join(", ")}.`
      : undefined;

  if (options.dryRun) {
    const validation = validationSummary(allIssues);
    return withExitCode(
      {
        dryRun: true,
        executed: false,
        from: { stepId: Number(fromStep.id), name: fromStep.name },
        to: { stepId: Number(toStep.id), name: toStep.name },
        calls,
        kept: Object.keys(carry?.values ?? {}).filter((name) => !(name in originValues)).length,
        validation,
        ...(warning ? { warning } : {})
      },
      validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
    );
  }
  throwIfInvalid(allIssues);

  const done: string[] = [];
  for (const planned of calls) {
    try {
      if (planned.action === "card_move") {
        await kit.contracts.moveCardStepWithValues(planned.payload as Parameters<CangeAgentKit["contracts"]["moveCardStepWithValues"]>[0]);
      } else {
        await kit.contracts.updateCardValues(planned.payload as Parameters<CangeAgentKit["contracts"]["updateCardValues"]>[0]);
      }
      done.push(`${planned.call} (${planned.form})`);
    } catch (error) {
      if (done.length === 0) throw error;
      return withExitCode(
        {
          ok: false,
          partial: true,
          cardId: Number(cardId),
          done,
          failed: `${planned.call} (${planned.form})`,
          error: error instanceof CangeError || error instanceof Error ? error.message : String(error),
          warning:
            "A operação saiu PELA METADE: o que está em `done` foi gravado, o resto NÃO. Leia o cartão antes de repetir."
        },
        EXIT_CODES.PARTIAL
      );
    }
  }

  const written = resolved.map((item) => item.field.title ?? item.field.name);
  const kept = Object.keys(carry?.values ?? {}).filter((name) => !(name in originValues)).length;
  return {
    ok: true,
    cardId: Number(cardId),
    flowId: Number(flowId),
    fromStepId: Number(fromStep.id),
    toStepId: Number(toStep.id),
    written,
    kept,
    summary:
      `Cartão ${cardId} movido de ${fromStep.name ?? fromStep.id} para ${toStep.name ?? toStep.id}` +
      (written.length > 0 ? `; gravou ${fieldTitles(resolved)}.` : "."),
    ...(warning ? { warning } : {})
  };
}

/** Voltar etapa num fluxo com "pular obrigatórios ao voltar" ligado (como a tela). */
function skipsRequired(
  flow: Record<string, unknown>,
  from: { index?: number | string },
  to: { index?: number | string }
): boolean {
  const flag = String(flow.skipRequiredOnBackwardMove ?? "");
  if (flag !== "1" && flag !== "S" && flag !== "true") return false;
  const fromIndex = Number(from.index);
  const toIndex = Number(to.index);
  return Number.isFinite(fromIndex) && Number.isFinite(toIndex) && toIndex < fromIndex;
}

