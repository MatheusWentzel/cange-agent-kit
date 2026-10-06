import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../client/errors.js";
import type { FlowStepSummary } from "../contracts/payload-builder.js";
import { extractFlowSteps } from "../contracts/payload-builder.js";
import { asRecord, extractPrimaryRecord } from "../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import {
  findMissingRequired,
  formatValueIssues,
  looksLikeTitleKey,
  normalizeText,
  resolveFieldValues,
  type CompanyUser,
  type FormScope,
  type ResolvedValue,
  type ResolverLookups,
  type ValueIssue
} from "../utils/valueResolver.js";

import { envCardId, envFlowId } from "./env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "./resource-ref.js";

/**
 * P5 (05/10, card #1367456): escrita em 1 passo. Toda escrita aceita valores
 * INLINE, sem arquivo de rascunho:
 *   --set "Campo=valor"   (repetível; o primeiro `=` separa)
 *   --values-json '{"Campo":"valor"}'
 * O `--payload <arquivo>` continua valendo; inline + payload = o inline vence.
 * A chave de cada valor segue a regra do P4 (hash, id ou título do campo).
 */

export interface InlineValueOptions {
  set?: string[];
  valuesJson?: string;
}

function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function addInlineValueOptions(command: Command, target = "campos"): Command {
  return command
    .option(
      "--set <campo=valor>",
      `Valor inline (repetível): "Campo=valor". Campo pelo título, id ou hash; o primeiro "=" separa (${target})`,
      collectRepeatable
    )
    .option("--values-json <json>", `Objeto JSON inline {"Campo": valor} (${target}); --set vence em conflito`);
}

/** Valores inline das flags, ou `undefined` quando nenhuma veio. */
export function parseInlineValues(options: InlineValueOptions): Record<string, unknown> | undefined {
  const hasSet = Array.isArray(options.set) && options.set.length > 0;
  if (!hasSet && options.valuesJson === undefined) return undefined;

  const values: Record<string, unknown> = {};
  if (options.valuesJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.valuesJson);
    } catch {
      throw new CangeCliUsageError(
        `--values-json precisa ser um objeto JSON (ex.: --values-json '{"Valor do Negócio": "2.500,00"}').`
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CangeCliUsageError(`--values-json precisa ser um objeto JSON {"Campo": valor}.`);
    }
    Object.assign(values, parsed);
  }
  for (const item of options.set ?? []) {
    const index = item.indexOf("=");
    const key = index > 0 ? item.slice(0, index).trim() : "";
    if (!key) {
      throw new CangeCliUsageError(`--set espera "Campo=valor" (recebido: ${item}).`);
    }
    values[key] = item.slice(index + 1).trim();
  }
  return values;
}

/** O payload (arquivo) precisa da estrutura de campos? Hash e chave técnica passam direto. */
export function needsFieldResolution(values: Record<string, unknown>, force: boolean): boolean {
  if (force) return true;
  return Object.keys(values).some((key) => /^#?\d+$/.test(key.trim()) || looksLikeTitleKey(key));
}

/** Busca de entrada de cadastro e lista de usuários sob demanda, com cache. */
export function createWriteLookups(kit: CangeAgentKit, ensureAuth: () => Promise<unknown>): ResolverLookups {
  let usersPromise: Promise<CompanyUser[]> | undefined;
  return {
    async searchRegisterEntries(registerId, text) {
      await ensureAuth();
      const result = await kit.contracts.getRegisterEntries({ registerId, search: text, pageSize: 20 });
      return result.entries
        .filter((entry) => entry.id !== undefined && Number.isFinite(Number(entry.id)))
        .map((entry) => ({ id: Number(entry.id), title: entry.title ?? String(entry.id) }));
    },
    listUsers() {
      usersPromise ??= (async () => {
        await ensureAuth();
        return (await kit.contracts.listCompanyUsers()).users;
      })();
      return usersPromise;
    }
  };
}

/** Autenticação uma vez só, sob demanda (o wrapper pula o login em --dry-run). */
export function authOnce(kit: CangeAgentKit, ensureAuth: () => Promise<unknown>): () => Promise<unknown> {
  let pending: Promise<unknown> | undefined;
  return () => {
    if (kit.client.getAccessToken()) return Promise.resolve();
    pending ??= ensureAuth();
    return pending;
  };
}

// ---------------------------------------------------------------------------
// Fluxo, etapas e formulários
// ---------------------------------------------------------------------------

export interface FlowContext {
  flowId: string;
  flowName?: string;
  formInitId?: string;
  steps: FlowStepSummary[];
  fields: NormalizedField[];
  flowRecord: Record<string, unknown>;
}

export async function loadFlowContext(kit: CangeAgentKit, flowId: string | number): Promise<FlowContext> {
  const [flow, fieldSet] = await Promise.all([
    kit.contracts.getFlow({ idFlow: String(flowId) }),
    kit.contracts.getFieldsByFlow({ flowId })
  ]);
  const record = extractPrimaryRecord(flow.raw) ?? asRecord(flow.raw) ?? {};
  return {
    flowId: String(flowId),
    ...(flow.summary.title ? { flowName: String(flow.summary.title) } : {}),
    ...(flow.summary.formInitId !== undefined ? { formInitId: String(flow.summary.formInitId) } : {}),
    steps: extractFlowSteps(flow.raw),
    fields: fieldSet.fields,
    flowRecord: record
  };
}

export function stepLabel(step: FlowStepSummary): string {
  return `etapa ${step.name ?? step.id}`;
}

export function formScope(fields: NormalizedField[], formId: string | number, label: string, priority: number): FormScope {
  return {
    formId: String(formId),
    label,
    priority,
    fields: fields.filter((field) => String(field.formId) === String(formId))
  };
}

export function initScope(ctx: FlowContext, priority: number): FormScope | undefined {
  return ctx.formInitId !== undefined ? formScope(ctx.fields, ctx.formInitId, "formulário inicial", priority) : undefined;
}

export function stepScope(ctx: FlowContext, step: FlowStepSummary, priority: number, suffix = ""): FormScope | undefined {
  if (step.formId === undefined) return undefined;
  return formScope(ctx.fields, step.formId, `${stepLabel(step)}${suffix}`, priority);
}

/** Formulários das etapas fora do escopo (só para dizer "esse campo é da etapa X"). */
export function otherStepScopes(ctx: FlowContext, exclude: ReadonlySet<string>): FormScope[] {
  const scopes: FormScope[] = [];
  for (const step of ctx.steps) {
    if (step.formId === undefined || exclude.has(String(step.formId))) continue;
    scopes.push(formScope(ctx.fields, step.formId, stepLabel(step), 9));
  }
  return scopes;
}

/**
 * Formulários de um fluxo agrupados só pelos campos (sem GET /flow): caminho do
 * payload por arquivo, que já traz o `idForm`.
 */
export function scopesFromFields(fields: NormalizedField[], targetFormId: string | number): {
  target: FormScope;
  others: FormScope[];
} {
  const target = formScope(fields, targetFormId, `form ${targetFormId}`, 0);
  const otherIds = Array.from(
    new Set(fields.map((field) => String(field.formId)).filter((id) => id !== String(targetFormId)))
  );
  return { target, others: otherIds.map((id) => formScope(fields, id, `form ${id}`, 9)) };
}

/** Etapa por id (`12`, `#12`) ou nome (sem maiúscula/acento). */
export function findStep(steps: FlowStepSummary[], ref: string): FlowStepSummary {
  const text = ref.trim();
  const list = (): string =>
    steps.map((step) => `${step.name ?? "?"} (id ${step.id})`).join(", ");
  if (/^#?\d+$/.test(text)) {
    const id = text.replace(/^#/, "");
    const hit = steps.find((step) => String(step.id) === id);
    if (hit) return hit;
  }
  const wanted = normalizeText(text);
  const exact = steps.filter((step) => step.name && normalizeText(step.name) === wanted);
  const pool = exact.length > 0 ? exact : steps.filter((step) => step.name && normalizeText(step.name).includes(wanted));
  if (pool.length === 1) return pool[0]!;
  if (pool.length === 0) {
    throw new CangeCliUsageError(`Etapa "${ref}" não existe neste fluxo. Etapas: ${list()}.`);
  }
  throw new CangeCliUsageError(
    `Etapa "${ref}" é ambígua: ${pool.map((step) => `${step.name} (id ${step.id})`).join(", ")}. Use o id.`
  );
}

/** Fluxo do cartão: --flow-id (ou link do cartão) > ambiente do run > GET /card/locate (já aplicado no parser). */
export function resolveWriteFlowId(flowId: string | number | undefined): string {
  const resolved = flowId !== undefined ? String(flowId) : envFlowId();
  if (!resolved) {
    throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);
  }
  return resolved;
}

export function requireCardId(cardId: string | number | undefined, command: string): string {
  if (cardId === undefined || String(cardId).trim() === "") {
    const fromEnv = envCardId();
    const hint = fromEnv ? ` (o cartão do run é ${fromEnv})` : "";
    throw new CangeCliUsageError(`Informe --card-id em \`cange ${command}\`${hint}.`);
  }
  return String(cardId);
}

// ---------------------------------------------------------------------------
// Resolução em camadas e erro compacto
// ---------------------------------------------------------------------------

/**
 * Resolve cada camada (payload, depois inline) e junta por campo: a camada de
 * depois vence. Assim `--set "Valor=10"` sobrescreve o hash do mesmo campo
 * que veio no arquivo, sem cair em "mesmo campo duas vezes".
 */
export async function resolveLayers(input: {
  layers: Array<Record<string, unknown> | undefined>;
  forms: FormScope[];
  outOfScope?: FormScope[];
  lookups?: ResolverLookups;
  passthroughUnknown?: boolean;
}): Promise<{ resolved: ResolvedValue[]; issues: ValueIssue[]; passthrough: Record<string, unknown> }> {
  const byField = new Map<string, ResolvedValue>();
  const issues: ValueIssue[] = [];
  const passthrough: Record<string, unknown> = {};
  for (const layer of input.layers) {
    if (!layer || Object.keys(layer).length === 0) continue;
    const result = await resolveFieldValues({
      values: layer,
      forms: input.forms,
      ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
      ...(input.lookups ? { lookups: input.lookups } : {}),
      ...(input.passthroughUnknown ? { passthroughUnknown: true } : {})
    });
    issues.push(...result.issues);
    Object.assign(passthrough, result.passthrough);
    for (const item of result.resolved) byField.set(item.field.name, item);
  }
  return { resolved: Array.from(byField.values()), issues, passthrough };
}

/** `values` final: chaves técnicas mantidas + campos resolvidos (estes vencem). */
export function mergedValues(result: { resolved: ResolvedValue[]; passthrough: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result.passthrough };
  for (const item of result.resolved) out[item.field.name] = item.value;
  return out;
}

export function validationSummary(issues: ValueIssue[]): { valid: true } | { valid: false; message: string } {
  const blocking = issues.filter((issue) => issue.blocking);
  return blocking.length === 0 ? { valid: true } : { valid: false, message: formatValueIssues(blocking) };
}

/** Erro de validação compacto (exit 2), nada gravado. */
export function throwIfInvalid(issues: ValueIssue[]): void {
  const summary = validationSummary(issues);
  if (!summary.valid) {
    throw new CangeValidationError(`Nada foi gravado.\n${summary.message}`, { code: "FIELD_VALIDATION" });
  }
}

/** "Data da ligação, Valor do Negócio" (para a linha de sucesso). */
export function fieldTitles(resolved: ResolvedValue[]): string {
  return resolved.map((item) => item.field.title ?? item.field.name).join(", ");
}

// ---------------------------------------------------------------------------
// Cadastro (register create/update)
// ---------------------------------------------------------------------------

/**
 * Resolve os values de um cadastro pelo formulário dele (`register.form_id`).
 * `formId` explícito (payload) evita o GET /register; sem ele, o kit descobre.
 */
export async function resolveRegisterValues(input: {
  kit: CangeAgentKit;
  auth: () => Promise<unknown>;
  registerId: string | number;
  formId?: string | number;
  layers: Array<Record<string, unknown> | undefined>;
  validate: boolean;
  requireRequired: boolean;
  passthroughUnknown: boolean;
}): Promise<{ formId: string; values: Record<string, unknown>; issues: ValueIssue[]; resolved: ResolvedValue[] }> {
  await input.auth();
  let formId = input.formId !== undefined ? String(input.formId) : undefined;
  let fields: NormalizedField[];
  if (formId === undefined || input.validate) {
    const context = await input.kit.contracts.getRegisterFormFields({ registerId: input.registerId });
    if (context.formId === undefined) {
      throw new CangeValidationError(`O cadastro ${input.registerId} não tem formulário (form_id).`);
    }
    if (formId !== undefined && String(context.formId) !== formId) {
      throw new CangeValidationError("idForm divergente do register.form_id.", {
        details: { payloadIdForm: formId, registerFormId: context.formId }
      });
    }
    formId = String(context.formId);
    fields = context.fields;
  } else {
    fields = (await input.kit.contracts.getFieldsByRegister({ registerId: input.registerId })).fields;
  }
  const { target, others } = scopesFromFields(fields, formId);
  const scope = { ...target, label: `cadastro ${input.registerId}` };
  const result = await resolveLayers({
    layers: input.layers,
    forms: [scope],
    outOfScope: others,
    lookups: createWriteLookups(input.kit, input.auth),
    passthroughUnknown: input.passthroughUnknown
  });
  const values = mergedValues(result);
  const issues = input.requireRequired
    ? [...result.issues, ...findMissingRequired(scope, values)]
    : result.issues;
  return { formId, values, issues, resolved: result.resolved };
}
