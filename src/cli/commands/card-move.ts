import type { Command } from "commander";

import { CangeCliUsageError, CangeError, CangeValidationError } from "../../client/errors.js";
import type { CangeAgentKit } from "../../index.js";
import { valuesOf, type FormScope, type ValueIssue } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  autocompletedTitles,
  keptFields,
  notKeptWarning,
  originRequired,
  readOriginCarry,
  readWrittenFormCarry,
  resendableWritten
} from "../move-required.js";
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
 * - Decisão 1 (06/10): os obrigatórios da etapa atual são SEMPRE exigidos (com ou sem
 *   --validate-fields/--dry-run). Faltou: nada é gravado e o erro traz o comando pronto
 *   com os --set que faltam (ver `move-required.ts`).
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
      "MUTAÇÃO: move o cartão para outra etapa em 1 passo (origem = etapa atual). Exige os obrigatórios da etapa atual; --set grava campos da etapa atual, do destino ou do formulário inicial"
    )
    .option("--card-id <id>", "Cartão (número ou link)")
    .option("--to <etapa>", "Etapa de destino: nome ou id")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link do cartão ou do ambiente do run)");
  addInlineValueOptions(command);
  command
    .option(
      "--validate-fields",
      "Aceito sem efeito: os obrigatórios da etapa atual são sempre exigidos ao mover"
    )
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
      "{ ok, cardId, flowId, fromStepId, toStepId, written[], kept, keptFrom?, autocompleted?, summary, warning? }. --dry-run: { dryRun, executed:false, calls[{call, action, form, payload}], kept, keptFrom, autocompleted?, validation }. keptFrom: rascunho (pré-resposta da etapa, o que a tela mostra) | ultima-passagem | vazio (a tela abre o formulário vazio) | cartao (back sem a rota). autocompleted: campos vazios que o autocompletar da tela preenche (o mover leva o valor)",
    fieldsLocation:
      "Origem = etapa atual do cartão. Mover exige os obrigatórios da etapa atual (faltou = exit 2 com o comando pronto); peça ao usuário o que não estiver no pedido. Campo pelo título, id ou hash, de qualquer um dos 3 formulários (etapa atual, destino, inicial). Mesma etapa = use card update-values.",
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
  // EXTRA-06 D1: a fonte é a da tela (rascunho da etapa ou última passagem), não o GET /card.
  // A2-F2: etapa atual sem formulário (raro): o mover grava o do destino e o back apaga o
  // rascunho dele; o kit reenvia o que a tela mostra nesse formulário, com o --set por cima.
  const writesDestination = !origin && destination !== undefined && destination.formId !== ctx.formInitId;
  const originValues = origin ? valuesOf(resolved, origin.formId) : {};
  // R3-F1: a entrada na etapa (movimentos) pede o fluxo; R3-F4: o --set da etapa atual é o que a
  // tela teria no formulário (a origem do vínculo escolhida preenche o destino no blur).
  const readOptions = { flowId };
  const [carry, destRead] = await Promise.all([
    origin ? readOriginCarry(kit, card.raw, origin, cardId, ctx.fields, { ...readOptions, sent: originValues }) : Promise.resolve(undefined),
    writesDestination && destination
      ? readWrittenFormCarry(kit, card.raw, destination, cardId, readOptions)
      : Promise.resolve(undefined)
  ]);
  const destCarry = resendableWritten(destRead);
  /** O que vai reenviado no mover: a etapa atual ou, sem formulário nela, o destino. */
  const resent = carry ?? destCarry;
  const moveValues = { ...(carry?.values ?? {}), ...originValues };

  // Decisão 1 (06/10): SEMPRE, com ou sem --validate-fields/--dry-run. O que o cartão já
  // tem na etapa atual conta (o mover reenvia; os que não dá para reenviar caem no aviso).
  const required = originRequired({
    ctx,
    fromStep,
    toStep,
    origin,
    values: moveValues,
    ...(carry ? { filled: carry.filled, carry } : {}),
    cardId,
    ...(options.flowId !== undefined ? { flowId: options.flowId } : {}),
    repeatSent: inline !== undefined && Object.keys(inline).length > 0
  });
  const notKept = resent?.notKept ?? [];
  const dataLossIssues: ValueIssue[] =
    options.failOnDataLoss && notKept.length > 0
      ? [
          {
            kind: "invalid_value",
            blocking: true,
            text: `o mover não consegue reenviar ${notKept.map((item) => item.title ?? item.name).join(", ")} (ficariam vazios na ${origin ? "etapa atual" : stepLabel(toStep)}). Tire --fail-on-data-loss para mover assim mesmo`
          }
        ]
      : [];
  const allIssues = [...issues, ...required.issues, ...dataLossIssues];

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
      // Sem form na etapa atual (raro): o form do destino (o mesmo que o contrato resolveria).
      ...(origin ? { idForm: Number(origin.formId) } : writesDestination && destination ? { idForm: Number(destination.formId) } : {}),
      values: origin ? moveValues : { ...(destCarry?.values ?? {}), ...destValues },
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

  const notKeptText = origin ? notKeptWarning(fromStep, carry) : notKeptWarning(toStep, destCarry);
  const warnings = [
    ...(notKeptText ? [notKeptText] : []),
    // Obrigatório com condicional vazio não bloqueia (o kit não avalia a condicional): avisa.
    ...(required.warning ? [required.warning] : [])
  ];
  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;
  const kept = origin ? keptFields(carry, originValues).length : keptFields(destCarry, destValues).length;
  // F2: o que o autocompletar da tela preencheu e vai no mover (fora o que veio no --set).
  const autocompleted = autocompletedTitles(carry, originValues);
  const autoInfo = autocompleted.length > 0 ? { autocompleted } : {};

  if (options.dryRun) {
    const validation = validationSummary(allIssues);
    return withExitCode(
      {
        dryRun: true,
        executed: false,
        from: { stepId: Number(fromStep.id), name: fromStep.name },
        to: { stepId: Number(toStep.id), name: toStep.name },
        calls,
        kept,
        ...(resent ? { keptFrom: resent.source } : {}),
        ...autoInfo,
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
  return {
    ok: true,
    cardId: Number(cardId),
    flowId: Number(flowId),
    fromStepId: Number(fromStep.id),
    toStepId: Number(toStep.id),
    written,
    kept,
    ...(resent && kept > 0 ? { keptFrom: resent.source } : {}),
    ...autoInfo,
    summary:
      `Cartão ${cardId} movido de ${fromStep.name ?? fromStep.id} para ${toStep.name ?? toStep.id}` +
      (written.length > 0 ? `; gravou ${fieldTitles(resolved)}.` : "."),
    ...(warning ? { warning } : {})
  };
}

