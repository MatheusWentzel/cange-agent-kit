import type { Command } from "commander";

import { CangeCliUsageError, CangeError, CangeValidationError } from "../../client/errors.js";
import type { CangeAgentKit } from "../../index.js";
import { updateCardValuesPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import type { FormScope, ResolvedValue } from "../../utils/valueResolver.js";
import { valuesOf } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import { readPayloadFile } from "../helpers.js";
import {
  addInlineValueOptions,
  authOnce,
  createWriteLookups,
  fieldTitles,
  formattedInfo,
  formattedOf,
  initScope,
  loadFlowContext,
  mergedValues,
  otherStepScopes,
  parseInlineValues,
  requireCardId,
  resolveLayers,
  resolveWriteFlowId,
  scopesFromFields,
  stepScope,
  throwIfInvalid,
  validationSummary,
  type InlineValueOptions
} from "../write-support.js";

interface CardUpdateValuesOptions extends InlineValueOptions {
  payload?: string;
  cardId?: string;
  flowId?: string;
  validateFields?: boolean;
  dryRun?: boolean;
}

interface UpdateCall {
  idForm: number;
  flowId: number;
  cardId: number;
  values: Record<string, unknown>;
}

export function registerCardUpdateValuesCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("update-values")
    .description(
      "MUTAÇÃO: grava campos do cartão sem mover (1 passo: --card-id + --set). Campo pelo título, id ou hash; o formulário é descoberto pelo campo"
    )
    .option("--card-id <id>", "Cartão (número ou link)")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link do cartão ou do ambiente do run)")
    .option("--payload <path>", "AVANÇADO: arquivo JSON {idForm, flowId, cardId, values}");
  addInlineValueOptions(command);
  command
    .option("--validate-fields", "Também recusa chave desconhecida (o --payload é sempre convertido pelos campos; no modo inline a validação já é sempre feita)")
    .option("--dry-run", "Mostra o payload resolvido e a validação, sem gravar (exit 2 se inválido)")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardUpdateValuesOptions) => {
        const inline = parseInlineValues(options);
        const auth = authOnce(kit, ensureAuth);

        if (options.payload) {
          return runPayloadMode(kit, auth, options, inline);
        }
        if (!inline) {
          throw new CangeCliUsageError(
            'Informe os campos: `cange card update-values --card-id <id> --set "Campo=valor"` (ou --values-json / --payload).'
          );
        }
        return runInlineMode(kit, auth, options, inline);
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      "{ ok, cardId, flowId, updated: [títulos], summary } (inline). --dry-run: { dryRun, executed:false, calls[{idForm, values}], validation }",
    fieldsLocation:
      "Chave do campo: título, id ou hash. Campos de formulários diferentes (etapa atual e inicial) viram uma gravação por formulário.",
    example: 'card update-values --card-id 1234 --set "Valor do Negócio=R$ 2.500,00" --set "Data da ligação=06/10/2026"'
  });
}

async function runInlineMode(
  kit: CangeAgentKit,
  auth: () => Promise<unknown>,
  options: CardUpdateValuesOptions,
  inline: Record<string, unknown>
): Promise<unknown> {
  const cardId = requireCardId(options.cardId, "card update-values");
  const flowId = resolveWriteFlowId(options.flowId);
  await auth();

  const [ctx, card] = await Promise.all([
    loadFlowContext(kit, flowId),
    kit.contracts.getCard({ flowId, cardId })
  ]);
  const currentStepId = card.summary.currentStepId;
  const currentStep = ctx.steps.find((step) => String(step.id) === String(currentStepId));

  // Escopo: etapa atual > formulário inicial > etapas que o cartão já respondeu.
  const forms: FormScope[] = [];
  const current = currentStep ? stepScope(ctx, currentStep, 0, " (atual)") : undefined;
  if (current) forms.push(current);
  const init = initScope(ctx, 1);
  if (init && !forms.some((form) => form.formId === init.formId)) forms.push(init);
  const answered = answeredFormIds(card.raw);
  for (const step of ctx.steps) {
    if (step.formId === undefined || !answered.has(String(step.formId))) continue;
    if (forms.some((form) => form.formId === String(step.formId))) continue;
    const scope = stepScope(ctx, step, 2);
    if (scope) forms.push(scope);
  }
  const outOfScope = otherStepScopes(ctx, new Set(forms.map((form) => form.formId)));

  const { resolved, issues } = await resolveLayers({
    layers: [inline],
    forms,
    outOfScope,
    lookups: createWriteLookups(kit, auth)
  });

  const calls = buildCalls(resolved, forms, Number(flowId), Number(cardId));
  // v9 (h): telefone e documento já vão nos `calls[].payload` como a tela grava.
  const formatted = formattedInfo(formattedOf(resolved));
  if (options.dryRun) {
    const validation = validationSummary(issues);
    return withExitCode(
      { dryRun: true, executed: false, calls, validation, ...formatted },
      validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
    );
  }
  throwIfInvalid(issues);
  if (calls.length === 0) {
    throw new CangeCliUsageError("Nenhum campo para gravar.");
  }

  const done: ResolvedValue[] = [];
  for (const call of calls) {
    try {
      await kit.contracts.updateCardValues(call);
    } catch (error) {
      if (done.length === 0) throw error;
      return withExitCode(
        {
          ok: false,
          partial: true,
          cardId: Number(cardId),
          updated: done.map((item) => item.field.title ?? item.field.name),
          failedForm: call.idForm,
          error: error instanceof CangeError || error instanceof Error ? error.message : String(error),
          warning: "Parte dos campos foi gravada e parte NÃO. Confira o cartão e grave só o que falta."
        },
        EXIT_CODES.PARTIAL
      );
    }
    done.push(...resolved.filter((item) => Number(item.form.formId) === call.idForm));
  }

  return {
    ok: true,
    cardId: Number(cardId),
    flowId: Number(flowId),
    updated: resolved.map((item) => item.field.title ?? item.field.name),
    ...formatted,
    summary: `Cartão ${cardId}: gravou ${fieldTitles(resolved)}.`
  };
}

function buildCalls(resolved: ResolvedValue[], forms: FormScope[], flowId: number, cardId: number): UpdateCall[] {
  const calls: UpdateCall[] = [];
  for (const form of forms) {
    const values = valuesOf(resolved, form.formId);
    if (Object.keys(values).length === 0) continue;
    calls.push({ idForm: Number(form.formId), flowId, cardId, values });
  }
  return calls;
}

/** Formulários com resposta no cartão (form_answers ativos). */
function answeredFormIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const card = Array.isArray(root.form_answers)
    ? root
    : ((root.card ?? root.data ?? root.raw ?? {}) as Record<string, unknown>);
  for (const answer of Array.isArray(card.form_answers) ? card.form_answers : []) {
    if (!answer || typeof answer !== "object") continue;
    const record = answer as Record<string, unknown>;
    if (String(record.deleted ?? "").toUpperCase() === "S") continue;
    const formId = record.form_id ?? record.id_form;
    if (formId !== undefined && formId !== null) ids.add(String(formId));
  }
  return ids;
}

async function runPayloadMode(
  kit: CangeAgentKit,
  auth: () => Promise<unknown>,
  options: CardUpdateValuesOptions,
  inline: Record<string, unknown> | undefined
): Promise<unknown> {
  const payloadRaw = await readPayloadFile<unknown>(options.payload!);
  const parsed = updateCardValuesPayloadSchema.safeParse(payloadRaw);
  if (!parsed.success) {
    throw new CangeValidationError("Payload inválido para card update-values.", {
      details: parsed.error.format()
    });
  }
  const payload = parsed.data;
  // K-01: o modo payload converte SEMPRE (rótulo de opção, dd/mm/aaaa, R$, nome, máscara), com
  // ou sem --validate-fields. O gate confere com `--dry-run --validate-fields` e a execução real
  // vem sem a flag: os `values` gravados têm de ser os mesmos que a aprovação mostrou. A flag só
  // acrescenta a validação (chave desconhecida vira erro em vez de seguir como veio).
  await auth();
  const { fields } = await kit.contracts.getFieldsByFlow({ flowId: payload.flowId });
  const { target, others } = scopesFromFields(fields, payload.idForm);
  if (target.fields.length === 0) {
    throw new CangeValidationError(
      `Nenhum campo do fluxo ${payload.flowId} pertence ao idForm ${payload.idForm}. Use \`cange card update-values --card-id ${payload.cardId} --set "Campo=valor"\` (o kit acha o formulário pelo campo).`
    );
  }
  const { resolved, issues, passthrough } = await resolveLayers({
    layers: [payload.values, inline],
    forms: [target],
    outOfScope: others,
    lookups: createWriteLookups(kit, auth),
    passthroughUnknown: options.validateFields !== true
  });
  const values = mergedValues({ resolved, passthrough });
  const formatted = formattedInfo(formattedOf(resolved));
  if (options.dryRun) {
    const validation = validationSummary(issues);
    return withExitCode(
      { ...createDryRunResult({ ...payload, values }), validation, ...formatted },
      validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
    );
  }
  throwIfInvalid(issues);
  payload.values = values;

  return { ...(await kit.contracts.updateCardValues(payload)), ...formatted };
}
