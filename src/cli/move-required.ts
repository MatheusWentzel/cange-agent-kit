import { CangeValidationError } from "../client/errors.js";
import type { FlowStepSummary } from "../contracts/payload-builder.js";
import { asRecord } from "../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import {
  needsStepEntry,
  readCarryOver,
  readStepCarryOver,
  requestRegisterAutoFill,
  resolveByCards,
  resolveByRegister,
  stepEntryFromMovements,
  stepExitFromMovements,
  type CarryOverResult,
  type CarrySource
} from "../utils/carryOver.js";
import { checkListProgress, isRequiredOnScreen, requiresAllChecked } from "../utils/requiredFields.js";
import { screenFormatError } from "../utils/screenFormat.js";
import {
  describeExpected,
  missingRequiredFields,
  missingRequiredIssue,
  normalizeText,
  type FormScope,
  type ValueIssue
} from "../utils/valueResolver.js";

import { resolveScreenReferences } from "./screen-refs.js";
import { formScope, loadFlowContext, stepLabel, stepScope, type FlowContext } from "./write-support.js";

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
 * - Autocompletar (F2, 07/10): campo sem valor que o autocompletar da tela preenche conta
 *   como preenchido e o valor vai no mover (`carry.autoFilled`). Obrigatório vazio com
 *   autocompletar que o kit não calcula (`carry.autoPending`) não bloqueia: vira aviso,
 *   como o da condicional. Com a origem do autocompletar vazia no cartão a tela não preenche,
 *   e o kit cobra igual (A2-F1: o campo nem chega ao `autoPending`).
 * - O mover apaga o rascunho do formulário que GRAVA (A2-F2): fora da etapa atual (o
 *   formulário do destino, por `--payload` ou pelo `card move` de etapa sem formulário), o kit
 *   reenvia o que a tela mostra nesse formulário, como na etapa atual (`readWrittenFormCarry`).
 * - Revisão 3 (07/10): check list "exigir todos concluídos" bloqueia mesmo oculto ou com
 *   condicional, como o FormBuilder (R3-F5); obrigatório preenchido que o kit não consegue
 *   reenviar bloqueia, porque o mover o deixaria vazio (R3-F2); `--allow-data-loss` aceita
 *   perder só a etapa atual, e o rascunho do formulário gravado segue reenviado (R3-F3).
 * - Revisão 4 (07/10): referência gravada que a tela não resolve (usuário fora da lista, cartão
 *   conectado excluído, opção que não existe, anexo que não carrega) a tela mostra vazia: o kit
 *   tira do mover e, no obrigatório, bloqueia com o motivo (POP-1/R4-P1); documento e telefone
 *   com o formato que a tela recusa bloqueiam, obrigatório ou não e oculto também (R4-P2);
 *   autocompletar com origem no cartão é o by-cards da tela, e todo autocompletar que o kit não
 *   calcula sai no aviso, obrigatório ou não (POP-2).
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
  /** Com autocompletar que o kit não calcula: a tela preencheria; vira aviso. */
  autoPending: NormalizedField[];
}

/**
 * `values` = o que vai no mover. Campo com autocompletar pendente que veio nele foi mandado
 * pelo agente (o kit não calculou o autocompletar, então não o pôs ali): mandado vazio é
 * campo limpo e bloqueia, como na tela (o autocompletar só roda ao abrir o cartão).
 */
function splitByConditional(
  missing: NormalizedField[],
  step: FlowStepSummary,
  carry?: Pick<CarryOverResult, "autoPending">,
  values: Record<string, unknown> = {}
): RequiredSplit {
  const names = conditionalFieldNames(step);
  const pending = new Set((carry?.autoPending ?? []).map((item) => item.name).filter((name) => !(name in values)));
  return {
    blocking: missing.filter((field) => !names.has(field.name) && !pending.has(field.name)),
    conditional: missing.filter((field) => names.has(field.name)),
    autoPending: missing.filter((field) => !names.has(field.name) && pending.has(field.name))
  };
}

function fieldList(fields: NormalizedField[]): string {
  return fields.map((field) => `${field.title ?? field.name} (${describeExpected(field)})`).join(", ");
}

/** "na etapa Triagem (atual)" / "no formulário inicial". */
function inLabel(label: string): string {
  return `${/^etapa\b/i.test(label) ? "na" : "no"} ${label}`;
}

/**
 * Aviso (não bloqueia) dos campos vazios com autocompletar que o kit não calcula (F2; POP-2: todo
 * campo, obrigatório ou não): a tela preencheria pelo autocompletar ao abrir; o mover vai sem ele.
 * `values` = o que vai no mover (o campo mandado não entra no aviso).
 */
export function autoPendingWarning(
  origin: FormScope,
  carry?: Pick<CarryOverResult, "autoPending">,
  values: Record<string, unknown> = {}
): string | undefined {
  const pending = (carry?.autoPending ?? []).filter((item) => !(item.name in values));
  if (pending.length === 0) return undefined;
  const titles = new Map(origin.fields.map((field) => [field.name, field.title ?? field.name]));
  const list = pending.map((item) => `${titles.get(item.name) ?? item.title ?? item.name} (${item.reason})`).join(", ");
  return (
    `Campos com autocompletar que o kit não calcula ${inLabel(origin.label)}: ${list}. ` +
    "Ao abrir o cartão a tela tenta preencher esses campos pelo autocompletar (e cobra o obrigatório que ficar vazio); " +
    "o mover do kit vai sem eles: confira o valor na tela e mande com --set no mover (ou confirme com o usuário)."
  );
}

/**
 * POP-1/R4-P1: aviso dos valores gravados que a tela não mostra (e o mover leva igual: sem eles,
 * ou só com a parte que a tela resolve). O obrigatório que ficou vazio bloqueia à parte.
 * REG-F1: e dos que o kit não conferiu no prazo das leituras (vão como estão gravados).
 */
export function unresolvedWarning(
  origin: FormScope,
  carry: Pick<CarryOverResult, "unresolved" | "unchecked"> | undefined,
  values: Record<string, unknown>,
  blocking: ReadonlySet<string> = new Set()
): string | undefined {
  const list = (carry?.unresolved ?? []).filter((item) => !blocking.has(item.name) && !(item.emptied && item.name in values));
  const unchecked = carry?.unchecked ?? [];
  if (list.length === 0 && unchecked.length === 0) return undefined;
  const titles = new Map(origin.fields.map((field) => [field.name, field.title ?? field.name]));
  const titleOf = (item: { name: string; title?: string }): string => titles.get(item.name) ?? item.title ?? item.name;
  return joinWarnings(
    list.length > 0
      ? `Gravados no cartão que a tela não mostra ${inLabel(origin.label)}: ` +
          list.map((item) => `${titleOf(item)} (${item.reason})`).join(", ") +
          ". O mover vai como a tela: sem esses valores (confira com o usuário se precisa mandar outro com --set)."
      : undefined,
    unchecked.length > 0
      ? `Não conferidos no prazo ${inLabel(origin.label)}: ` +
          unchecked.map((item) => `${titleOf(item)} (${item.what})`).join(", ") +
          ". O kit lê o que a tela resolve (anexo, usuário, cartão conectado) no ritmo do teto de leitura do back e parou no " +
          "prazo da conferência: o mover leva esses valores como estão gravados. Se a tela mostrar algum deles vazio, mande o valor com --set."
      : undefined
  );
}

/** POP-1/R4-P1: obrigatórios que a tela mostra vazios porque não resolve o valor gravado. */
function unresolvedRequired(
  origin: FormScope,
  carry: Pick<CarryOverResult, "unresolved"> | undefined,
  values: Record<string, unknown>
): NormalizedField[] {
  const emptied = new Set((carry?.unresolved ?? []).filter((item) => item.emptied && !item.passesRequired).map((item) => item.name));
  return origin.fields.filter((field) => emptied.has(field.name) && !(field.name in values) && isRequiredOnScreen(field));
}

function unresolvedRequiredIssue(field: NormalizedField, carry: Pick<CarryOverResult, "unresolved"> | undefined): ValueIssue {
  const reason = carry?.unresolved.find((item) => item.name === field.name)?.reason ?? "valor que a tela não resolve";
  return {
    kind: "move_conflict",
    blocking: true,
    text:
      `${field.title ?? field.name} está gravado no cartão, mas a tela mostra o campo vazio (${reason}) e cobra o obrigatório. ` +
      `Mande --set com um valor válido (${describeExpected(field)}) depois de conferir com o usuário`
  };
}

/**
 * R4-P2: documento e telefone que a tela recusa ao mover (o `createYupSchema` valida o formato
 * sempre: obrigatório ou não, oculto e com condicional também), sobre o que vai no mover.
 */
function formatInvalid(origin: FormScope, values: Record<string, unknown>): Array<{ field: NormalizedField; error: string }> {
  const out: Array<{ field: NormalizedField; error: string }> = [];
  for (const field of origin.fields) {
    if (!(field.name in values)) continue;
    const error = screenFormatError(field.type, field.variation ?? field.raw?.variation, values[field.name]);
    if (error) out.push({ field, error });
  }
  return out;
}

function formatIssue(item: { field: NormalizedField; error: string }, values: Record<string, unknown>): ValueIssue {
  return {
    kind: "invalid_value",
    blocking: true,
    text:
      `${item.field.title ?? item.field.name} (${describeExpected(item.field)}): ${JSON.stringify(values[item.field.name])} ` +
      `não passa na tela (${item.error}). A tela recusa o mover com esse valor, mesmo fora do obrigatório: mande o valor corrigido com --set`
  };
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
  /** Obrigatórios com autocompletar que o kit não calcula, também vazios: a dica cita. */
  autoPending?: NormalizedField[];
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
    (input.conditional && input.conditional.length > 0
      ? `Também vazios, com condicional (a tela só exige se o campo aparecer para este cartão): ${fieldList(input.conditional)}. `
      : "") +
    (input.autoPending && input.autoPending.length > 0
      ? `Também vazios, com autocompletar que o kit não calcula (a tela tenta preencher ao abrir o cartão): ${fieldList(input.autoPending)}. `
      : "");
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
  /** O que o cartão tem na etapa (o `autoPending` vira aviso em vez de bloquear). */
  carry?: CarryOverResult;
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
  const unresolvedNote = (blockingNames: ReadonlySet<string>): string | undefined =>
    unresolvedWarning(origin, input.carry, input.values, blockingNames);
  // Voltar etapa com "pular obrigatórios ao voltar": a tela pula a validação do formulário inteira.
  if (skipsRequiredOnBackwardMove(input.ctx.flowRecord, input.fromStep, input.toStep)) {
    const warning = unresolvedNote(new Set());
    return { issues: [], ...(warning ? { warning } : {}) };
  }
  // R4-P2: o formato do documento e do telefone (obrigatório ou não, oculto também).
  const badFormat = formatInvalid(origin, input.values);
  const formatIssues = badFormat.map((item) => formatIssue(item, input.values));
  const formatFields = badFormat.map((item) => item.field);
  const lost = notKeptRequired(origin, input.carry, input.values);
  const missing = missingRequiredFields(origin, input.values, withoutNames(input.filled, lost));
  const split = splitByConditional(missing, input.fromStep, input.carry, input.values);
  const { conditional, autoPending } = split;
  // POP-1/R4-P1: o obrigatório vazio porque a tela não resolve o valor gravado tem motivo próprio.
  const unresolved = unresolvedRequired(origin, input.carry, input.values);
  const blocking = split.blocking.filter((field) => !lost.includes(field) && !unresolved.includes(field));
  const unresolvedBlocking = split.blocking.filter((field) => unresolved.includes(field));
  const checklist = pendingChecklists(origin, input.fromStep, input.values);
  const lostIssues = lost.map((field) => notKeptRequiredIssue(field));
  const toAsk = [...blocking, ...lost, ...unresolvedBlocking, ...formatFields.filter((field) => !blocking.includes(field))];
  const warning = joinWarnings(
    toAsk.length === 0 ? conditionalRequiredWarning(origin, conditional) : undefined,
    autoPendingWarning(origin, input.carry, input.values),
    unresolvedNote(new Set(unresolvedBlocking.map((field) => field.name)))
  );
  if (toAsk.length === 0) {
    return { issues: checklist.issues, ...(warning ? { warning } : {}) };
  }
  return {
    issues: [
      ...blocking.map((field) => missingRequiredIssue(origin, field)),
      ...lostIssues,
      ...unresolvedBlocking.map((field) => unresolvedRequiredIssue(field, input.carry)),
      ...formatIssues,
      ...checklist.issues,
      hintFor(input, origin, toAsk, conditional, autoPending)
    ],
    ...(warning ? { warning } : {})
  };
}

function hintFor(
  input: OriginRequiredInput,
  origin: FormScope,
  missing: NormalizedField[],
  conditional: NormalizedField[],
  autoPending: NormalizedField[]
): ValueIssue {
  return moveRequiredHint({
    missing,
    origin,
    steps: input.ctx.steps,
    toStep: input.toStep,
    cardId: input.cardId,
    conditional,
    autoPending,
    ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
    ...(input.repeatSent ? { repeatSent: true } : {})
  });
}

/**
 * R3-F2: obrigatório (da tela) que o cartão tem preenchido mas o kit não consegue reenviar
 * (`notKept`: valor gravado que não remonta, fórmula, ID automático) e que não veio no mover.
 * O mover grava a resposta nova sem ele e apaga o rascunho: o obrigatório ficaria vazio, o
 * que a decisão 1 proíbe. Bloqueia com o motivo próprio (não é "Falta": a tela o mostra).
 */
function notKeptRequired(
  origin: FormScope,
  carry: Pick<CarryOverResult, "notKept"> | undefined,
  values: Record<string, unknown>
): NormalizedField[] {
  const names = new Set((carry?.notKept ?? []).map((item) => item.name));
  return origin.fields.filter((field) => names.has(field.name) && !(field.name in values) && isRequiredOnScreen(field));
}

function notKeptRequiredIssue(field: NormalizedField): ValueIssue {
  return {
    kind: "move_conflict",
    blocking: true,
    text:
      `${field.title ?? field.name} está preenchido no cartão, mas o kit não consegue reenviar o valor gravado: ` +
      "o mover gravaria a etapa sem ele e o obrigatório ficaria vazio. Mande o valor no mover (--set) depois de conferir com o usuário"
  };
}

function withoutNames(filled: ReadonlySet<string> | undefined, fields: NormalizedField[]): ReadonlySet<string> | undefined {
  if (!filled || fields.length === 0) return filled;
  const next = new Set(filled);
  for (const field of fields) next.delete(field.name);
  return next;
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const list = warnings.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length > 0 ? list.join(" ") : undefined;
}

/**
 * EXTRA-06 D5: check list com "exigir todos os itens concluídos" (`formula = '1'`). A tela
 * (FormBuilder.handleSubDefault) não move com item sem marcar, e checa TODO check list com a
 * regra, pelo valor do formulário: o oculto (`show_on_form = 'S'`, montado com display none,
 * entra no `getData`; o laço do oculto só zera o obrigatório) e o com condicional também
 * (R3-F5: antes o kit pulava o oculto e só avisava no condicional). Item sem descrição a tela
 * descarta antes (o `getValue` do CheckListField), e o kit também (`checkListProgress`).
 */
export function pendingChecklists(
  origin: FormScope,
  _fromStep: FlowStepSummary,
  values: Record<string, unknown>
): { issues: ValueIssue[] } {
  const issues: ValueIssue[] = [];
  for (const field of origin.fields) {
    if (!requiresAllChecked(field)) continue;
    const progress = checkListProgress(values[field.name]);
    if (!progress || progress.pending === 0) continue;
    const label = `${field.title ?? field.name} (${progress.pending} de ${progress.total} sem marcar)`;
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `no campo ${label} existem itens a concluir na lista. A tela só move com todos os itens marcados ` +
        "(o check list exige todos concluídos, mesmo oculto ou com condicional): conclua os itens ou confirme com o usuário antes de mover"
    });
  }
  return { issues };
}

/**
 * EXTRA-06 D1 (P0): o que o cartão tem no formulário da etapa atual, pela mesma fonte da
 * tela (`GET /form/pre-answer`): o rascunho da etapa ou, sem ele, a última passagem
 * confirmada. O `GET /card` não traz o rascunho, e o mover apaga o rascunho.
 */
export interface CarryReadOptions {
  /** Fluxo do cartão (o `GET /card/moviment`, o by-cards e o by-register pedem). Sem ele: o do cartão. */
  flowId?: number | string;
  /** R3-F4: o que vai no mover para o formulário da etapa atual (os --set, o values do payload). */
  sent?: Record<string, unknown>;
}

export async function readOriginCarry(
  kit: CangeAgentKit,
  cardRaw: unknown,
  origin: FormScope,
  cardId: number | string,
  options: CarryReadOptions = {}
): Promise<CarryOverResult> {
  const pre = await kit.contracts.getPreAnswer({ cardId, formId: origin.formId });
  const flowId = options.flowId ?? cardFlowId(cardRaw);
  const stepEntry = await readPassageStart(kit, cardRaw, pre?.raw, origin, cardId, flowId, stepEntryFromMovements);
  const carry = readStepCarryOver({
    cardRaw,
    preAnswerRaw: pre?.raw,
    formId: origin.formId,
    fields: origin.fields,
    ...(stepEntry !== undefined ? { stepEntry } : {}),
    ...(options.sent ? { sent: options.sent } : {})
  });
  const preFields = asRecord(pre?.raw)?.fields;
  if (carry.byCards.length > 0 && flowId !== undefined) {
    // POP-2: o mesmo POST que a tela faz ao abrir o cartão, com a mesma lista na mesma ordem.
    let response: unknown;
    try {
      response = await kit.contracts.getAutoCompleteByCards({
        cardId,
        items: carry.byCards.map((item) => ({
          flowId,
          fieldId: item.parentFieldId,
          ...(item.childFieldId !== undefined ? { childFieldId: item.childFieldId } : {})
        }))
      });
    } catch {
      response = undefined;
    }
    resolveByCards(carry, origin.fields, response, { cardId, flowId });
  }
  // R3-F4: destino de vínculo que ficou vazio ao abrir e cuja origem vem no mover (o blur da tela).
  if (pre !== undefined) requestRegisterAutoFill(carry, preFields, origin.fields, options.sent);
  if (carry.byRegister.length > 0 && flowId !== undefined) {
    let response: unknown;
    try {
      response = await kit.contracts.getAutoCompleteByRegister({
        items: carry.byRegister.map((item) => ({
          flowId,
          fieldId: item.parentFieldId,
          childFieldId: item.childFieldId,
          currValue: item.currValue
        }))
      });
    } catch {
      response = undefined;
    }
    resolveByRegister(carry, origin.fields, response);
  }
  // POP-1/R4-P1: o que o componente da tela faz com cada valor (usuário, cartão, anexo, opção...).
  await resolveScreenReferences(kit, {
    carry,
    fields: origin.fields,
    ...(preFields !== undefined ? { preFields } : {}),
    ...(flowId !== undefined ? { flowId } : {})
  });
  return carry;
}

/**
 * R3-F1/R4-F1: o começo da passagem que conta, pelos movimentos do cartão, só se houver
 * confirmada mais nova que o rascunho para disputar com ele. Falha da leitura = não se sabe
 * (nenhuma confirmada disputa).
 */
async function readPassageStart(
  kit: CangeAgentKit,
  cardRaw: unknown,
  preAnswerRaw: unknown,
  scope: FormScope,
  cardId: number | string,
  flowId: number | string | undefined,
  pick: (movementsRaw: unknown) => number | undefined
): Promise<number | undefined> {
  if (flowId === undefined) return undefined;
  if (!needsStepEntry({ cardRaw, preAnswerRaw, formId: scope.formId, fields: scope.fields })) return undefined;
  try {
    const movements = await kit.contracts.getCardMovements({ cardId, flowId });
    return movements ? pick(movements.raw) : undefined;
  } catch {
    return undefined;
  }
}

function cardFlowId(cardRaw: unknown): number | string | undefined {
  const root = asRecord(cardRaw);
  const card = root && root.flow_id === undefined ? (asRecord(root.card) ?? asRecord(root.data) ?? root) : root;
  const flowId = card?.flow_id;
  return typeof flowId === "number" || (typeof flowId === "string" && flowId.trim() !== "") ? flowId : undefined;
}

/**
 * A2-F2 (revisão 07/10): o `/card/v2/move-step` apaga o rascunho do formulário que GRAVA
 * (`MoveCardWithAnswerService`, passo 1: o form_answer do cartão com `form_id = id_form` e
 * `flow_step_id` NULL), no fluxo com ou sem o Flow Query V2, e grava a resposta nova só com o
 * `values`. Gravando o formulário de outra etapa (o do destino, o `idForm` omitido, que cai no
 * destino, ou o `card move` de etapa sem formulário), o rascunho dele sumia e a tela passava a
 * abrir esse formulário vazio (cartão 494824: 3 anexos da automação no rascunho do destino;
 * 8.780 cartões ativos com rascunho preenchido fora da etapa atual no cange_local).
 *
 * Fonte = a da tela para esse formulário (`GET /form/pre-answer`: o rascunho, ou a última
 * passagem que o back remonta). Sem o autocompletar: a tela só autocompleta quando o cartão
 * estiver na etapa dele, e o que ficar sem linha ela ainda preenche nessa hora. Sem a resolução
 * das referências (POP-1): o mover só preserva esse formulário, a tela não o valida agora.
 */
export async function readWrittenFormCarry(
  kit: CangeAgentKit,
  cardRaw: unknown,
  scope: FormScope,
  cardId: number | string,
  options: CarryReadOptions & {
    /**
     * R4-F1: a etapa dona do formulário gravado. O corte da confirmada é a SAÍDA da última
     * passagem do cartão por ela (a resposta dessa saída é da passagem anterior; o rascunho é o
     * que a tela vai mostrar), não a entrada na etapa atual. Sem ela, nenhuma confirmada disputa.
     */
    ownerStepId?: number | string;
  } = {}
): Promise<CarryOverResult> {
  const pre = await kit.contracts.getPreAnswer({ cardId, formId: scope.formId });
  const owner = options.ownerStepId;
  const stepEntry =
    owner === undefined
      ? undefined
      : await readPassageStart(kit, cardRaw, pre?.raw, scope, cardId, options.flowId ?? cardFlowId(cardRaw), (raw) =>
          stepExitFromMovements(raw, owner)
        );
  return readStepCarryOver({
    cardRaw,
    preAnswerRaw: pre?.raw,
    formId: scope.formId,
    fields: scope.fields,
    autoComplete: false,
    ...(stepEntry !== undefined ? { stepEntry } : {})
  });
}

/**
 * O que reenviar no formulário que o mover grava fora da etapa atual: só o que a tela
 * mostra nele (rascunho ou última passagem). `vazio` não tem nada; `cartao` (back sem a rota)
 * fica com o detector de perda de sempre, sem reenvio.
 */
export function resendableWritten(carry: CarryOverResult | undefined): CarryOverResult | undefined {
  return carry && (carry.source === "rascunho" || carry.source === "ultima-passagem") ? carry : undefined;
}

/** Campos do cartão reenviados sem estar no que foi mandado (o autocompletar sai à parte). */
export function keptFields(carry: CarryOverResult | undefined, sent: Record<string, unknown>): string[] {
  if (!carry) return [];
  const auto = new Set(carry.autoFilled.map((item) => item.name));
  return Object.keys(carry.values).filter((name) => !(name in sent) && !auto.has(name));
}

/** Títulos dos campos que o autocompletar da tela preencheu e o mover leva (fora os mandados). */
export function autocompletedTitles(carry: CarryOverResult | undefined, sent: Record<string, unknown>): string[] {
  return (carry?.autoFilled ?? []).filter((item) => !(item.name in sent)).map((item) => item.title ?? item.name);
}

/** Aviso dos preenchidos que o mover não consegue reenviar (fórmula, ID automático, anexo fora da pré-resposta). */
export function notKeptWarning(step: FlowStepSummary, carry: CarryOverResult | undefined): string | undefined {
  return notKeptText(stepLabel(step), carry);
}

/** O mesmo aviso, com o rótulo do formulário ("etapa Triagem", "form 902"). */
function notKeptText(label: string, carry: CarryOverResult | undefined): string | undefined {
  const notKept = carry?.notKept ?? [];
  if (notKept.length === 0) return undefined;
  const where = /^etapa\b/i.test(label) ? `na ${label}` : `no ${label}`;
  return `Não reenviados (ficam vazios ${where}): ${notKept.map((item) => item.title ?? item.name).join(", ")}.`;
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
  /** Campos que o autocompletar da tela preencheu e o mover leva (títulos). */
  autocompleted: string[];
  /** O mover grava o formulário da etapa atual. */
  writesOrigin: boolean;
  /** O que o cartão tem na etapa atual (fonte da tela). */
  carry?: CarryOverResult;
  /**
   * O que a tela mostra no formulário que o mover grava, quando o kit o reenvia (a etapa
   * atual, ou outro formulário com rascunho ou última passagem, A2-F2). É a régua do
   * detector de perda; undefined = sem reenvio (o detector de sempre, pelo `GET /card`).
   */
  writtenCarry?: CarryOverResult;
  /** De onde veio o que foi reenviado (`kept`). */
  keptFrom?: CarrySource;
}

export interface PayloadMoveOptions {
  /**
   * Reenviar o que o cartão já tem na ETAPA ATUAL quando o payload a grava (padrão: sim, como a
   * tela e o `card move`). false = `--allow-data-loss`. O rascunho de OUTRO formulário gravado
   * (o do destino) é sempre reenviado (R3-F3): a tela nunca grava esse formulário no mover.
   */
  resend?: boolean;
  /** `--allow-data-loss`: aceita perder o que o cartão tem na etapa atual (não o formulário gravado). */
  allowDataLoss?: boolean;
}

/**
 * Caminho do `--payload` (`card move-step-with-values` e `card move-step`): lê o fluxo e o
 * cartão e confere os obrigatórios da etapa ATUAL do cartão (não a do `fromStepId`).
 *
 * O mover pelo payload grava um formulário NOVO só com o `values` e o back apaga o
 * rascunho do formulário gravado (EXTRA-06 D1). Quando o payload grava a etapa atual, o kit
 * reenvia o que o cartão já tem nela (o rascunho que a tela mostra, com o do payload por
 * cima) e os obrigatórios contam o resultado; com `resend: false` (`--allow-data-loss`), só
 * conta o `values` e obrigatório preenchido fora dele é problema próprio. Payload que grava
 * outro formulário (ex.: o do destino) não toca a etapa atual: conta o que o cartão já
 * tem, e rascunho só da etapa atual bloqueia (o back o apaga ao sair da etapa; o
 * `--allow-data-loss` aceita essa perda e ela volta no aviso); o que a tela mostra no
 * formulário gravado (rascunho ou última passagem) vai SEMPRE com o `values` por cima
 * (A2-F2; R3-F3: a flag não desliga esse reenvio).
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
  // idForm omitido: o contrato grava o form do destino (resolveMoveForm).
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
  const writesOrigin = origin !== undefined && writtenFormId === origin.formId;
  // A2-F2: gravando outro formulário, o back apaga o rascunho DELE; o kit reenvia o que a tela mostra nele.
  // O form de criação o contrato recusa no mover (guard do form_init): nada a ler.
  const writtenScope =
    !writesOrigin && writtenFormId !== "" && writtenFormId !== String(ctx.formInitId ?? "")
      ? formScope(ctx.fields, writtenFormId, formLabel(ctx, writtenFormId), 1)
      : undefined;
  const readOptions = { flowId: payload.flowId };
  const ownerStep = ctx.steps.find((step) => step.formId !== undefined && String(step.formId) === writtenFormId);
  const [originCarry, writtenRead] = await Promise.all([
    origin
      ? readOriginCarry(kit, card.raw, origin, payload.cardId, {
          ...readOptions,
          // R3-F4: o values só vai para a etapa atual quando o payload grava o formulário dela.
          ...(writesOrigin ? { sent: values } : {})
        })
      : Promise.resolve(undefined),
    writtenScope
      ? readWrittenFormCarry(kit, card.raw, writtenScope, payload.cardId, {
          ...readOptions,
          ...(ownerStep ? { ownerStepId: ownerStep.id } : {})
        })
      : Promise.resolve(undefined)
  ]);
  const written = resendableWritten(writtenRead);
  const writtenNotKept = written && writtenScope ? notKeptText(writtenScope.label, written) : undefined;

  if (!origin || !originCarry) {
    const sendValues = written ? { ...written.values, ...values } : values;
    return {
      ctx,
      card,
      writtenFormId,
      issues,
      values: sendValues,
      kept: keptFields(written, values),
      autocompleted: [],
      writesOrigin: false,
      ...(written ? { writtenCarry: written, keptFrom: written.source } : {}),
      ...(writtenNotKept ? { warning: writtenNotKept } : {})
    };
  }

  const carry = originCarry;
  const resend = writesOrigin && options.resend !== false;
  const resent = resend ? carry : written;
  const sendValues = resent ? { ...resent.values, ...values } : values;
  const kept = keptFields(resent, values);
  const autocompleted = resend ? autocompletedTitles(carry, values) : [];
  const notKept = resend ? notKeptWarning(fromStep, carry) : writtenNotKept;
  const base = {
    ctx,
    card,
    writtenFormId,
    originFormId: origin.formId,
    values: sendValues,
    kept,
    autocompleted,
    writesOrigin,
    carry,
    ...(resent ? { writtenCarry: resent, keptFrom: resent.source } : {})
  };

  // Gravando outro formulário, o rascunho da etapa atual some ao sair dela: o back apaga
  // (MoveCardService, clearPreAnswerAndSnapshotForCardLeavingStep) só no fluxo com o Flow
  // Query V2 ligado. No fluxo sem ele o rascunho fica e volta a aparecer na tela quando o
  // cartão voltar à etapa: não há perda e o kit não bloqueia.
  let lostDraft: string | undefined;
  if (!writesOrigin && carry.source === "rascunho" && clearsDraftOnLeave(ctx.flowRecord)) {
    const draftOnly = draftOnlyFields(card.raw, origin, carry);
    if (draftOnly.length > 0 && !options.allowDataLoss) {
      issues.push({
        kind: "move_conflict",
        blocking: true,
        text:
          `o rascunho da ${stepLabel(fromStep)} tem ${listTitles(draftOnly)} e o mover grava outro formulário ` +
          `(form ${writtenFormId}): ao sair da etapa o back apaga o rascunho e esses valores somem. Use ` +
          `\`cange card move --card-id ${payload.cardId} --to ${payload.toStepId}\` (manda a etapa atual no mover, como a tela) ` +
          `ou repita com --allow-data-loss (aceita perder esses campos da ${stepLabel(fromStep)}; o rascunho do form ${writtenFormId} segue reenviado)`
      });
    } else if (draftOnly.length > 0) {
      // R3-F3: a perda aceita pela flag fica visível no resultado.
      lostDraft =
        `Com --allow-data-loss, o rascunho da ${stepLabel(fromStep)} some ao sair da etapa: ${listTitles(draftOnly)}.`;
    }
  }

  if (skipsRequiredOnBackwardMove(ctx.flowRecord, fromStep, toStep)) {
    const warning = joinWarnings(notKept, lostDraft);
    return { ...base, issues, ...(warning ? { warning } : {}) };
  }

  const counted = writesOrigin ? sendValues : {};
  /** O que a tela teria no formulário da etapa atual ao mover (é ele que ela valida). */
  const screenValues = writesOrigin ? sendValues : carry.values;
  // R3-F2: obrigatório preenchido que o reenvio não consegue levar fica vazio no mover: bloqueia.
  const lost = resend ? notKeptRequired(origin, carry, counted) : [];
  const filled = writesOrigin && !resend ? new Set<string>() : withoutNames(carry.filled, lost);
  const missing = missingRequiredFields(origin, counted, filled);
  // O autocompletar só vai quando o mover grava a etapa atual com o reenvio; sem ele, o
  // obrigatório com autocompletar pendente segue bloqueando (nada o preencheria).
  const split = splitByConditional(missing, fromStep, resend ? carry : undefined, counted);
  const { conditional, autoPending } = split;
  // POP-1/R4-P1: o obrigatório vazio porque a tela não resolve o valor gravado tem motivo próprio.
  const unresolved = unresolvedRequired(origin, carry, counted);
  const unresolvedBlocking = split.blocking.filter((field) => unresolved.includes(field));
  const blocking = split.blocking.filter((field) => !lost.includes(field) && !unresolved.includes(field));
  // Preenchido no cartão e fora do values (só com --allow-data-loss): motivo próprio. Mandado vazio = falta.
  const notResent = blocking.filter((field) => carry.filled.has(field.name) && !(field.name in counted));
  const empty = blocking.filter((field) => !notResent.includes(field));
  // R4-P2: documento e telefone que a tela recusa (obrigatório ou não, oculto também).
  const badFormat = formatInvalid(origin, screenValues);

  for (const field of notResent) {
    issues.push({
      kind: "move_conflict",
      blocking: true,
      text:
        `${field.title ?? field.name} está preenchido no cartão mas não veio no values: o mover grava o formulário ` +
        "da etapa atual de novo e ele ficaria vazio. Inclua no values (sem --allow-data-loss o kit reenvia o que o cartão já tem)"
    });
  }
  issues.push(...lost.map((field) => notKeptRequiredIssue(field)));
  issues.push(...unresolvedBlocking.map((field) => unresolvedRequiredIssue(field, carry)));
  issues.push(...badFormat.map((item) => formatIssue(item, screenValues)));
  const checklist = pendingChecklists(origin, fromStep, screenValues);
  issues.push(...checklist.issues);
  const formatFields = badFormat.map((item) => item.field).filter((field) => !empty.includes(field));
  const toAsk = [...empty, ...lost, ...unresolvedBlocking, ...formatFields];
  if (empty.length > 0) issues.push(...empty.map((field) => missingRequiredIssue(origin, field)));
  if (toAsk.length > 0) {
    issues.push(
      moveRequiredHint({
        missing: toAsk,
        origin,
        steps: ctx.steps,
        toStep,
        toStepId: payload.toStepId,
        cardId: payload.cardId,
        flowId: payload.flowId,
        payloadMode: true,
        payloadSent: sentTitles(ctx, values),
        conditional,
        autoPending
      })
    );
  }
  // Sem a dica (nada vazio sem condicional), os com condicional vão no aviso.
  const warning = joinWarnings(
    notKept,
    lostDraft,
    toAsk.length === 0 ? conditionalRequiredWarning(origin, conditional) : undefined,
    resend ? autoPendingWarning(origin, carry, counted) : undefined,
    unresolvedWarning(origin, carry, screenValues, new Set(unresolvedBlocking.map((field) => field.name)))
  );
  return { ...base, issues, ...(warning ? { warning } : {}) };
}

/**
 * O back apaga o rascunho da etapa que o cartão deixa (`use_query_v2 = 'S'`). Sem o campo
 * no fluxo (back antigo, fluxo montado à mão), conta como apaga: o bloqueio é o lado seguro.
 */
export function clearsDraftOnLeave(flow: Record<string, unknown>): boolean {
  const flag = flow.use_query_v2 ?? flow.useQueryV2;
  if (flag === undefined || flag === null || String(flag).trim() === "") return true;
  return String(flag).trim().toUpperCase() === "S";
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

/** Rótulo do formulário gravado fora da etapa atual: "etapa Agendamento" ou "form 902". */
function formLabel(ctx: FlowContext, formId: string): string {
  const step = ctx.steps.find((item) => item.formId !== undefined && String(item.formId) === formId);
  return step ? stepLabel(step) : `form ${formId}`;
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
