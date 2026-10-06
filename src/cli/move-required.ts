import { CangeValidationError } from "../client/errors.js";
import type { FlowStepSummary } from "../contracts/payload-builder.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import { readCarryOver } from "../utils/carryOver.js";
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
 * - O erro diz quais campos faltam e traz o comando pronto para gravar e mover no mesmo
 *   passo: `card move --set` grava os campos da etapa atual dentro do próprio mover.
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
}

/**
 * A dica que vai no fim do erro: a regra, o "pergunte ao usuário" e o comando pronto
 * (`card move --set` grava na etapa atual e move numa execução só).
 */
export function moveRequiredHint(input: HintInput): ValueIssue {
  const sets = input.missing.map((field) => `--set "${setKey(field, input.origin)}=<${placeholder(field)}>"`).join(" ");
  const flow = input.flowId !== undefined && String(input.flowId).trim() !== "" ? ` --flow-id ${input.flowId}` : "";
  const command = `cange card move --card-id ${input.cardId}${flow} --to ${stepRef(input.steps, input.toStep, input.toStepId)} ${sets}`;
  const extra = input.repeatSent
    ? " (repita os --set que você já mandou)"
    : input.payloadMode
      ? " (ou inclua esses campos no values do payload)"
      : "";
  return {
    kind: "hint",
    blocking: false,
    text:
      `${MOVE_REQUIRED_RULE} Se os valores não estão no pedido, pergunte ao usuário (não invente). ` +
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

/** Obrigatórios da etapa atual ainda vazios + a dica do comando (vazio = pode mover). */
export function originRequiredIssues(input: OriginRequiredInput): ValueIssue[] {
  const { origin } = input;
  if (!origin) return [];
  if (skipsRequiredOnBackwardMove(input.ctx.flowRecord, input.fromStep, input.toStep)) return [];
  const missing = missingRequiredFields(origin, input.values, input.filled);
  if (missing.length === 0) return [];
  return [
    ...missing.map((field) => missingRequiredIssue(origin, field)),
    moveRequiredHint({
      missing,
      origin,
      steps: input.ctx.steps,
      toStep: input.toStep,
      cardId: input.cardId,
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      ...(input.repeatSent ? { repeatSent: true } : {})
    })
  ];
}

export interface PayloadMove {
  flowId: number;
  cardId: number;
  fromStepId: number;
  toStepId: number;
  idForm?: number;
  values: Record<string, unknown>;
}

export interface PayloadMoveCheck {
  ctx: FlowContext;
  card: { raw: unknown };
  /** Formulário que o mover vai gravar (idForm do payload ou, sem ele, o do destino). */
  writtenFormId: string;
  /** Formulário da etapa atual do cartão (undefined = etapa sem formulário). */
  originFormId?: string;
  issues: ValueIssue[];
}

/**
 * Caminho do `--payload` (`card move-step-with-values` e `card move-step`): lê o fluxo e o
 * cartão e confere os obrigatórios da etapa ATUAL do cartão (não a do `fromStepId`).
 *
 * O mover pelo payload grava um formulário NOVO da etapa atual só com o `values` (o
 * `card move` reenvia sozinho o que o cartão tem; o payload, não). Então, quando o payload
 * grava a etapa atual, só conta o que está no `values`: campo preenchido no cartão e
 * ausente do `values` ficaria vazio e entra como problema próprio. Payload que grava outro
 * formulário (ex.: o do destino) não toca a etapa atual: conta o que o cartão já tem.
 */
export async function checkPayloadMove(
  kit: CangeAgentKit,
  payload: PayloadMove,
  values: Record<string, unknown> = payload.values,
  preloaded?: FlowContext
): Promise<PayloadMoveCheck> {
  const [ctx, card] = await Promise.all([
    preloaded ? Promise.resolve(preloaded) : loadFlowContext(kit, payload.flowId),
    kit.contracts.getCard({ flowId: payload.flowId, cardId: payload.cardId })
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
  if (!origin || skipsRequiredOnBackwardMove(ctx.flowRecord, fromStep, toStep)) {
    return { ctx, card, writtenFormId, ...(origin ? { originFormId: origin.formId } : {}), issues };
  }

  const writesOrigin = writtenFormId === origin.formId;
  const carry = readCarryOver(card.raw, origin.formId, origin.fields);
  const missing = missingRequiredFields(origin, writesOrigin ? values : {}, writesOrigin ? new Set() : carry.filled);
  const notResent = missing.filter((field) => carry.filled.has(field.name));
  const empty = missing.filter((field) => !carry.filled.has(field.name));

  for (const field of notResent) {
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `${field.title ?? field.name} está preenchido no cartão mas não veio no values: o mover grava o formulário ` +
        "da etapa atual de novo e ele ficaria vazio. Inclua no values (ou use `cange card move`, que reenvia o que o cartão já tem)"
    });
  }
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
        payloadMode: true
      })
    );
  }
  return { ctx, card, writtenFormId, originFormId: origin.formId, issues };
}

function findStepById(steps: FlowStepSummary[], id: number | string | undefined): FlowStepSummary | undefined {
  if (id === undefined || id === null) return undefined;
  return steps.find((step) => String(step.id) === String(id));
}

/** Destino na dica: o nome quando ele acha a etapa sozinho, senão o id. */
function stepRef(steps: FlowStepSummary[], step: FlowStepSummary | undefined, fallbackId?: number | string): string {
  if (!step) return fallbackId !== undefined ? String(fallbackId) : '"<etapa>"';
  const name = step.name?.trim();
  if (name && !name.includes('"') && !/^#?\d+$/.test(name)) {
    const wanted = normalizeText(name);
    const same = steps.filter((item) => item.name && normalizeText(item.name) === wanted);
    if (same.length === 1) return `"${name}"`;
  }
  return String(step.id);
}

/** Chave do --set: o título quando ele acha o campo sozinho, senão o hash. */
function setKey(field: NormalizedField, form: FormScope): string {
  const title = field.title?.trim();
  if (!title || /[="]/.test(title) || /^#?\d+$/.test(title)) return field.name;
  const wanted = normalizeText(title);
  const same = form.fields.filter((item) => item.title && normalizeText(item.title) === wanted);
  return same.length === 1 ? title : field.name;
}

function placeholder(field: NormalizedField): string {
  if (/ATTACH/i.test(String(field.type ?? ""))) return "id do anexo";
  return describeExpected(field);
}
