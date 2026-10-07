import { CangeValidationError } from "../client/errors.js";
import type { FlowStepSummary } from "../contracts/payload-builder.js";
import { asRecord } from "../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import { readCarryOver, readStepCarryOver, type CarryOverResult } from "../utils/carryOver.js";
import { checkListProgress, isHiddenOnForm, requiresAllChecked } from "../utils/requiredFields.js";
import {
  describeExpected,
  missingRequiredFields,
  missingRequiredIssue,
  normalizeText,
  type FormScope,
  type ValueIssue
} from "../utils/valueResolver.js";

import { loadFlowContext, stepLabel, stepScope, type FlowContext } from "./write-support.js";

/**
 * DECISÃO 1 do Matheus (06/10/2026): mover exige os obrigatórios da etapa ATUAL, sempre.
 *
 * É a regra base da plataforma: a tela só move depois de validar o formulário da etapa em
 * que o cartão está. Vale para todo caminho de mover do kit (`card move`,
 * `card move-step-with-values` com ou sem `--payload`, `card move-step`), com ou sem
 * `--validate-fields` e `--dry-run`. Antes o kit só cobrava com essas flags, e o back
 * (`POST /card/v2/move-step`) não cobra: o agente movia deixando obrigatório vazio.
 *
 * - Origem = etapa atual, lida do cartão. Conta o que vai no mover mais o que o cartão já
 *   tem e o mover mantém.
 * - Destino: a tela não pede o formulário do destino ao entrar; os obrigatórios dele valem
 *   quando o cartão SAIR de lá. O que vier no --set para o destino é validado no formato.
 * - Única exceção, igual à tela: voltar etapa num fluxo com "pular obrigatórios ao voltar"
 *   (`skipRequiredOnBackwardMove`) ligado. É configuração do fluxo, não escolha do agente.
 * - Igual à tela, campo OCULTO no formulário (`show_on_form = "S"`) não é cobrado: o
 *   FormBuilder zera o obrigatório dele antes de validar (ver `isHiddenOnForm`).
 * - Campo com CONDICIONAL de campo (Exibir/Esconder) não bloqueia: a tela só cobra quando
 *   a condicional exibe o campo, e o kit ainda não avalia condicionais. Vazio, ele vira
 *   aviso (`warning` no resultado) e entra na dica quando outro obrigatório bloqueia.
 * - O erro diz quais campos faltam e traz o comando pronto para gravar e mover no mesmo
 *   passo: `card move --set` grava os campos da etapa atual dentro do próprio mover.
 * - EXTRA-06 (07/10): o que o cartão TEM na etapa vem da mesma fonte da tela, a
 *   pré-resposta (`readOriginCarry`), e é reenviado no mover; obrigatório é o que a tela
 *   cobra (regra `required` do campo, ver `isRequiredOnScreen`); check list "exigir todos
 *   concluídos" (`formula = '1'`) com item sem marcar bloqueia, como a tela.
 */

export const MOVE_REQUIRED_RULE = "Mover exige os obrigatórios da etapa atual (regra da plataforma, igual à tela).";

/** Voltar etapa num fluxo com "pular obrigatórios ao voltar" ligado (a tela também pula). */
export function skipsRequiredOnBackwardMove(
  flow: Record<string, unknown>,
  from: { index?: number | string } | undefined,
  to: { index?: number | string } | undefined
): boolean {
  const flag = String(flow.skipRequiredOnBackwardMove ?? flow.skip_required_on_backward_move ?? "");
  if (flag !== "1" && flag !== "S" && flag !== "true") return false;
  const fromIndex = Number(from?.index);
  const toIndex = Number(to?.index);
  return Number.isFinite(fromIndex) && Number.isFinite(toIndex) && toIndex < fromIndex;
}

/**
 * Campos do formulário da etapa com condicional de campo ("Exibir/Esconder campo").
 * O GET /flow traz `flow_steps[].form.fields[].conditionals`; o GET /field/by-flow não.
 */
export function conditionalFieldNames(step: FlowStepSummary | undefined): Set<string> {
  const names = new Set<string>();
  const fields = asRecord(step?.raw.form)?.fields;
  if (!Array.isArray(fields)) return names;
  for (const item of fields) {
    const field = asRecord(item);
    if (!field || typeof field.name !== "string") continue;
    if (Array.isArray(field.conditionals) && field.conditionals.length > 0) names.add(field.name);
  }
  return names;
}

interface RequiredSplit {
  /** Sem condicional: a tela sempre cobra, então bloqueia o mover. */
  blocking: NormalizedField[];
  /** Com condicional: a tela só cobra se a condicional exibir o campo; vira aviso. */
  conditional: NormalizedField[];
}

function splitByConditional(missing: NormalizedField[], step: FlowStepSummary): RequiredSplit {
  const names = conditionalFieldNames(step);
  return {
    blocking: missing.filter((field) => !names.has(field.name)),
    conditional: missing.filter((field) => names.has(field.name))
  };
}

function fieldList(fields: NormalizedField[]): string {
  return fields.map((field) => `${field.title ?? field.name} (${describeExpected(field)})`).join(", ");
}

/** "na etapa Triagem (atual)" / "no formulário inicial". */
function inLabel(label: string): string {
  return `${/^etapa\b/i.test(label) ? "na" : "no"} ${label}`;
}

/** Aviso (não bloqueia) dos obrigatórios com condicional que ficaram vazios. */
export function conditionalRequiredWarning(origin: FormScope, fields: NormalizedField[]): string | undefined {
  if (fields.length === 0) return undefined;
  return (
    `Obrigatórios com condicional vazios ${inLabel(origin.label)}: ${fieldList(fields)}. ` +
    "A tela só os exige quando a condicional exibe o campo, e o kit não avalia condicionais: " +
    "se o campo aparece para este cartão, mande o valor com --set no mover (ou confira com o usuário)."
  );
}

interface HintInput {
  missing: NormalizedField[];
  origin: FormScope;
  steps: FlowStepSummary[];
  toStep: FlowStepSummary | undefined;
  toStepId?: number | string;
  cardId: string | number;
  flowId?: string | number;
  /** O pedido já trazia --set/--values-json: a dica pede para repetir. */
  repeatSent?: boolean;
  /** Veio por --payload: a dica lembra do values do arquivo. */
  payloadMode?: boolean;
  /** --payload: campos que já iam no values (e nos --set). O `card move` da dica só os grava se vierem de novo. */
  payloadSent?: string[];
  /** Obrigatórios com condicional também vazios: a dica cita, sem bloquear por eles. */
  conditional?: NormalizedField[];
}

/**
 * A dica que vai no fim do erro: a regra, o "pergunte ao usuário" e o comando pronto
 * (`card move --set` grava na etapa atual e move numa execução só).
 */
export function moveRequiredHint(input: HintInput): ValueIssue {
  const sets = input.missing.map((field) => `--set "${setKey(field, input.origin)}=<${placeholder(field)}>"`).join(" ");
  const flow = input.flowId !== undefined && String(input.flowId).trim() !== "" ? ` --flow-id ${input.flowId}` : "";
  const command = `cange card move --card-id ${input.cardId}${flow} --to ${stepRef(input.steps, input.toStep, input.toStepId)} ${sets}`;
  const sent = input.payloadSent ?? [];
  const extra = input.repeatSent
    ? " (repita os --set que você já mandou)"
    : input.payloadMode
      ? sent.length > 0
        ? ` (repita como --set o que já ia no payload: ${listTitles(sent)}; ou inclua os que faltam no values do payload)`
        : " (ou inclua esses campos no values do payload)"
      : "";
  const conditional =
    input.conditional && input.conditional.length > 0
      ? `Também vazios, com condicional (a tela só exige se o campo aparecer para este cartão): ${fieldList(input.conditional)}. `
      : "";
  return {
    kind: "hint",
    blocking: false,
    text:
      `${MOVE_REQUIRED_RULE} Se os valores não estão no pedido, pergunte ao usuário (não invente). ${conditional}` +
      `Com eles, grave e mova no mesmo passo:\n${command}${extra}`
  };
}

export interface OriginRequiredInput {
  ctx: FlowContext;
  fromStep: FlowStepSummary;
  toStep: FlowStepSummary;
  /** Formulário da etapa atual (sem formulário = nada a exigir). */
  origin: FormScope | undefined;
  /** O que vai para o formulário da etapa atual nesta escrita (hash → valor). */
  values: Record<string, unknown>;
  /** Hashes que o cartão já tem preenchidos e continuam valendo depois do mover. */
  filled?: ReadonlySet<string>;
  cardId: string | number;
  flowId?: string | number;
  repeatSent?: boolean;
}

export interface OriginRequiredResult {
  /** Obrigatórios da etapa atual ainda vazios + a dica do comando (vazio = pode mover). */
  issues: ValueIssue[];
  /** Obrigatórios com condicional vazios, quando nada bloqueia: aviso no resultado. */
  warning?: string;
}

/** Obrigatórios da etapa atual no `card move` (e no move-step-with-values sem --payload). */
export function originRequired(input: OriginRequiredInput): OriginRequiredResult {
  const { origin } = input;
  if (!origin) return { issues: [] };
  if (skipsRequiredOnBackwardMove(input.ctx.flowRecord, input.fromStep, input.toStep)) return { issues: [] };
  const missing = missingRequiredFields(origin, input.values, input.filled);
  const { blocking, conditional } = splitByConditional(missing, input.fromStep);
  const checklist = pendingChecklists(origin, input.fromStep, input.values);
  if (blocking.length === 0) {
    const warning = joinWarnings(conditionalRequiredWarning(origin, conditional), checklist.warning);
    return { issues: checklist.issues, ...(warning ? { warning } : {}) };
  }
  return {
    issues: [
      ...blocking.map((field) => missingRequiredIssue(origin, field)),
      ...checklist.issues,
      moveRequiredHint({
        missing: blocking,
        origin,
        steps: input.ctx.steps,
        toStep: input.toStep,
        cardId: input.cardId,
        conditional,
        ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
        ...(input.repeatSent ? { repeatSent: true } : {})
      })
    ],
    ...(checklist.warning ? { warning: checklist.warning } : {})
  };
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const list = warnings.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length > 0 ? list.join(" ") : undefined;
}

/**
 * EXTRA-06 D5: check list com "exigir todos os itens concluídos" (`formula = '1'`). A tela
 * (FormBuilder) não move com item sem marcar. Igual aos obrigatórios: campo oculto não
 * conta e campo com condicional vira aviso (o kit não avalia a condicional).
 */
export function pendingChecklists(
  origin: FormScope,
  fromStep: FlowStepSummary,
  values: Record<string, unknown>
): { issues: ValueIssue[]; warning?: string } {
  const conditionalNames = conditionalFieldNames(fromStep);
  const issues: ValueIssue[] = [];
  const conditional: string[] = [];
  for (const field of origin.fields) {
    if (!requiresAllChecked(field) || isHiddenOnForm(field)) continue;
    const progress = checkListProgress(values[field.name]);
    if (!progress || progress.pending === 0) continue;
    const label = `${field.title ?? field.name} (${progress.pending} de ${progress.total} sem marcar)`;
    if (conditionalNames.has(field.name)) {
      conditional.push(label);
      continue;
    }
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `no campo ${label} existem itens a concluir na lista. A tela só move com todos os itens marcados ` +
        "(o check list exige todos concluídos): conclua os itens ou confirme com o usuário antes de mover"
    });
  }
  const warning =
    conditional.length > 0
      ? `Check list com itens a concluir e condicional ${inLabel(origin.label)}: ${conditional.join(", ")}. ` +
        "A tela só exige se o campo aparece para este cartão."
      : undefined;
  return { issues, ...(warning ? { warning } : {}) };
}

/**
 * EXTRA-06 D1 (P0): o que o cartão tem no formulário da etapa atual, pela mesma fonte da
 * tela (`GET /form/pre-answer`): o rascunho da etapa ou, sem ele, a última passagem
 * confirmada. O `GET /card` não traz o rascunho, e o mover apaga o rascunho.
 */
export async function readOriginCarry(
  kit: CangeAgentKit,
  cardRaw: unknown,
  origin: FormScope,
  cardId: number | string
): Promise<CarryOverResult> {
  const pre = await kit.contracts.getPreAnswer({ cardId, formId: origin.formId });
  return readStepCarryOver({ cardRaw, preAnswerRaw: pre?.raw, formId: origin.formId, fields: origin.fields });
}

/** Aviso dos preenchidos que o mover não consegue reenviar (anexo, fórmula, ID automático). */
export function notKeptWarning(step: FlowStepSummary, carry: CarryOverResult | undefined): string | undefined {
  const notKept = carry?.notKept ?? [];
  if (notKept.length === 0) return undefined;
  return `Não reenviados (ficam vazios na ${stepLabel(step)}): ${notKept.map((item) => item.title ?? item.name).join(", ")}.`;
}

export interface PayloadMove {
  flowId: number;
  cardId: number;
  fromStepId: number;
  toStepId: number;
  idForm?: number;
  values: Record<string, unknown>;
  /** Cartão de modo teste (deleted 'T'): o GET /card só acha com isTestMode=true. */
  isTestMode?: boolean;
}

export interface PayloadMoveCheck {
  ctx: FlowContext;
  card: { raw: unknown };
  /** Formulário que o mover vai gravar (idForm do payload ou, sem ele, o do destino). */
  writtenFormId: string;
  /** Formulário da etapa atual do cartão (undefined = etapa sem formulário). */
  originFormId?: string;
  issues: ValueIssue[];
  /** Obrigatórios com condicional vazios, quando nada bloqueia por obrigatório: aviso. */
  warning?: string;
  /**
   * O `values` que o mover deve mandar. Gravando a etapa atual: o que o cartão já tem
   * nela (rascunho incluído) com o do payload por cima, como a tela. Sem `resend`, só o
   * do payload.
   */
  values: Record<string, unknown>;
  /** Campos do cartão reenviados sem estar no payload. */
  kept: string[];
  /** O mover grava o formulário da etapa atual. */
  writesOrigin: boolean;
  /** O que o cartão tem na etapa atual (fonte da tela). */
  carry?: CarryOverResult;
}

export interface PayloadMoveOptions {
  /**
   * Reenviar o que o cartão já tem na etapa atual quando o payload grava esse formulário
   * (padrão: sim, como a tela e o `card move`). false = `--allow-data-loss`.
   */
  resend?: boolean;
  /** `--allow-data-loss`: aceita perder o rascunho da etapa atual ao gravar outro formulário. */
  allowDataLoss?: boolean;
}

/**
 * Caminho do `--payload` (`card move-step-with-values` e `card move-step`): lê o fluxo e o
 * cartão e confere os obrigatórios da etapa ATUAL do cartão (não a do `fromStepId`).
 *
 * O mover pelo payload grava um formulário NOVO só com o `values` e o back apaga o
 * rascunho da etapa (EXTRA-06 D1). Quando o payload grava a etapa atual, o kit reenvia o
 * que o cartão já tem nela (o rascunho que a tela mostra, com o do payload por cima) e
 * os obrigatórios contam o resultado; com `resend: false` (`--allow-data-loss`), só conta
 * o `values` e obrigatório preenchido fora dele é problema próprio. Payload que grava
 * outro formulário (ex.: o do destino) não toca a etapa atual: conta o que o cartão já
 * tem, e rascunho só da etapa atual bloqueia (o back o apaga ao sair da etapa).
 */
export async function checkPayloadMove(
  kit: CangeAgentKit,
  payload: PayloadMove,
  values: Record<string, unknown> = payload.values,
  preloaded?: FlowContext,
  options: PayloadMoveOptions = {}
): Promise<PayloadMoveCheck> {
  const [ctx, card] = await Promise.all([
    preloaded ? Promise.resolve(preloaded) : loadFlowContext(kit, payload.flowId),
    kit.contracts.getCard({
      flowId: payload.flowId,
      cardId: payload.cardId,
      ...(payload.isTestMode === true ? { isTestMode: true } : {})
    })
  ]);
  const currentId = card.summary.currentStepId;
  const fromStep = findStepById(ctx.steps, currentId ?? payload.fromStepId);
  if (!fromStep) {
    throw new CangeValidationError(
      `Não achei a etapa atual do cartão ${payload.cardId} no fluxo ${payload.flowId} ` +
        `(etapa ${String(currentId ?? payload.fromStepId)}). Nada foi gravado. ` +
        `Use \`cange card move --card-id ${payload.cardId} --to "<etapa>"\` (a origem é lida do cartão).`,
      { code: "FIELD_VALIDATION" }
    );
  }
  const toStep = findStepById(ctx.steps, payload.toStepId);
  const writtenFormId = String(payload.idForm ?? toStep?.formId ?? "");
  const issues: ValueIssue[] = [];

  if (currentId !== undefined && String(currentId) !== String(payload.fromStepId)) {
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `o cartão ${payload.cardId} está na ${stepLabel(fromStep)} (id ${String(fromStep.id)}), não na etapa ` +
        `${payload.fromStepId} do fromStepId. Corrija o payload ou use \`cange card move --card-id ${payload.cardId} ` +
        `--to ${payload.toStepId}\`, que lê a origem do cartão`
    });
  }

  const origin = stepScope(ctx, fromStep, 0, " (atual)");
  if (!origin) {
    return { ctx, card, writtenFormId, issues, values, kept: [], writesOrigin: false };
  }

  const writesOrigin = writtenFormId === origin.formId;
  const carry = await readOriginCarry(kit, card.raw, origin, payload.cardId);
  const resend = writesOrigin && options.resend !== false;
  const sendValues = resend ? { ...carry.values, ...values } : values;
  const kept = resend ? Object.keys(carry.values).filter((name) => !(name in values)) : [];
  const notKept = resend ? notKeptWarning(fromStep, carry) : undefined;
  const base = { ctx, card, writtenFormId, originFormId: origin.formId, values: sendValues, kept, writesOrigin, carry };

  // Gravando outro formulário, o rascunho da etapa atual some ao sair dela (o back apaga).
  if (!writesOrigin && carry.source === "rascunho" && !options.allowDataLoss) {
    const draftOnly = draftOnlyFields(card.raw, origin, carry);
    if (draftOnly.length > 0) {
      issues.push({
        kind: "move_conflict",
        blocking: true,
        text:
          `o rascunho da ${stepLabel(fromStep)} tem ${listTitles(draftOnly)} e o mover grava outro formulário ` +
          `(form ${writtenFormId}): ao sair da etapa o back apaga o rascunho e esses valores somem. Use ` +
          `\`cange card move --card-id ${payload.cardId} --to ${payload.toStepId}\` (manda a etapa atual no mover, como a tela) ` +
          "ou repita com --allow-data-loss"
      });
    }
  }

  if (skipsRequiredOnBackwardMove(ctx.flowRecord, fromStep, toStep)) {
    return { ...base, issues, ...(notKept ? { warning: notKept } : {}) };
  }

  const counted = writesOrigin ? sendValues : {};
  const filled = writesOrigin && !resend ? new Set<string>() : carry.filled;
  const missing = missingRequiredFields(origin, counted, filled);
  const { blocking, conditional } = splitByConditional(missing, fromStep);
  // Preenchido no cartão e fora do values (só com --allow-data-loss): motivo próprio. Mandado vazio = falta.
  const notResent = blocking.filter((field) => carry.filled.has(field.name) && !(field.name in counted));
  const empty = blocking.filter((field) => !notResent.includes(field));

  for (const field of notResent) {
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `${field.title ?? field.name} está preenchido no cartão mas não veio no values: o mover grava o formulário ` +
        "da etapa atual de novo e ele ficaria vazio. Inclua no values (sem --allow-data-loss o kit reenvia o que o cartão já tem)"
    });
  }
  const checklist = pendingChecklists(origin, fromStep, writesOrigin ? sendValues : carry.values);
  issues.push(...checklist.issues);
  if (empty.length > 0) {
    issues.push(...empty.map((field) => missingRequiredIssue(origin, field)));
    issues.push(
      moveRequiredHint({
        missing: empty,
        origin,
        steps: ctx.steps,
        toStep,
        toStepId: payload.toStepId,
        cardId: payload.cardId,
        flowId: payload.flowId,
        payloadMode: true,
        payloadSent: sentTitles(ctx, values),
        conditional
      })
    );
  }
  // Sem a dica (nada vazio sem condicional), os com condicional vão no aviso.
  const warning = joinWarnings(
    notKept,
    empty.length === 0 ? conditionalRequiredWarning(origin, conditional) : undefined,
    checklist.warning
  );
  return { ...base, issues, ...(warning ? { warning } : {}) };
}

/** Campos preenchidos no rascunho da etapa com valor que as respostas confirmadas não têm. */
function draftOnlyFields(cardRaw: unknown, origin: FormScope, carry: CarryOverResult): string[] {
  const confirmed = readCarryOver(cardRaw, origin.formId, origin.fields);
  const titles: string[] = [];
  for (const [name, text] of carry.stored) {
    if (confirmed.stored.get(name) === text) continue;
    const field = origin.fields.find((item) => item.name === name);
    titles.push(field?.title ?? name);
  }
  return titles;
}

function findStepById(steps: FlowStepSummary[], id: number | string | undefined): FlowStepSummary | undefined {
  if (id === undefined || id === null) return undefined;
  return steps.find((step) => String(step.id) === String(id));
}

/** Títulos dos campos que o payload já mandava preenchidos (para a dica pedir de novo). */
function sentTitles(ctx: FlowContext, values: Record<string, unknown>): string[] {
  const titles: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const field = ctx.fields.find((item) => item.name === key);
    const title = field?.title ?? key;
    if (!titles.includes(title)) titles.push(title);
  }
  return titles;
}

function listTitles(titles: string[]): string {
  return titles.slice(0, 10).join(", ") + (titles.length > 10 ? ", ..." : "");
}

/**
 * O que o shell interpreta dentro de aspas duplas (ou fecha as aspas). A dica é um comando
 * para colar no Bash do runner: nome de campo ou de etapa com isso vira hash ou id, e o
 * placeholder sai escapado.
 */
const SHELL_UNSAFE = /["$`\\]/;

/** Destino na dica: o nome quando ele acha a etapa sozinho, senão o id. */
function stepRef(steps: FlowStepSummary[], step: FlowStepSummary | undefined, fallbackId?: number | string): string {
  if (!step) return fallbackId !== undefined ? String(fallbackId) : '"<etapa>"';
  const name = step.name?.trim();
  if (name && !SHELL_UNSAFE.test(name) && !/^#?\d+$/.test(name)) {
    const wanted = normalizeText(name);
    const same = steps.filter((item) => item.name && normalizeText(item.name) === wanted);
    if (same.length === 1) return `"${name}"`;
  }
  return String(step.id);
}

/** Chave do --set: o título quando ele acha o campo sozinho, senão o hash. */
function setKey(field: NormalizedField, form: FormScope): string {
  const title = field.title?.trim();
  if (!title || title.includes("=") || SHELL_UNSAFE.test(title) || /^#?\d+$/.test(title)) return field.name;
  const wanted = normalizeText(title);
  const same = form.fields.filter((item) => item.title && normalizeText(item.title) === wanted);
  return same.length === 1 ? title : field.name;
}

/** Placeholder do valor, seguro dentro das aspas duplas do --set. */
function placeholder(field: NormalizedField): string {
  const text = /ATTACH/i.test(String(field.type ?? "")) ? "id do anexo" : describeExpected(field);
  return text.replace(/["$`\\]/g, "\\$&");
}
