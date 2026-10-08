import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import type { FlowTagSummary } from "../../contracts/cards.js";
import type { FlowUserSummary } from "../../contracts/users.js";
import type { CangeAgentKit } from "../../index.js";
import { updateCardPayloadSchema } from "../../schemas/cards.js";
import {
  cardStateOf,
  dueInvalidMessage,
  dueLabel,
  parseDueInput,
  type CardState,
  type DueInput
} from "../../utils/cardState.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { FORCED_DRY_RUN_NOTE, isForceDryRun } from "../../utils/forceDryRun.js";
import { normalizeText } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { SPEAKER_OUTSIDE_CHAT_MESSAGE, envSpeakerUserId, isSpeakerRef } from "../env-defaults.js";
import { EXIT_CODES } from "../exit-codes.js";
import { readPayloadFile } from "../helpers.js";
import { authOnce, requireCardId, resolveWriteFlowId } from "../write-support.js";

interface CardUpdateOptions {
  payload?: string;
  cardId?: string;
  flowId?: string;
  due?: string;
  responsible?: string;
  addTag?: string[];
  removeTag?: string[];
  dryRun?: boolean;
  /** Aceito e ignorado (P7). */
  validateFields?: boolean;
}

function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * v9 (g, decisão de 08/10; conversa 857, run 1119: o vencimento custou 18 passos e bateu o
 * teto, porque o `card update` exigia arquivo e flowId): vencimento, responsável e etiqueta
 * com 1 comando curto.
 *
 *   cange card update --card-id 1234 --due 27/10/2026
 *   cange card update --card-id 1234 --responsible eu
 *   cange card update --card-id 1234 --add-tag "Quente"
 *
 * Gate (contrato C3): 1 comando = 1 permissão = no máximo 1 aprovação. Vencimento e
 * responsável vão juntos num único `PUT /card` (ação card_update); etiqueta é outra
 * permissão (card_link: `POST`/`DELETE /flow-tag/card`) e nunca vai junto, uma por comando.
 * O `--dry-run` (e o CANGE_FORCE_DRY_RUN) só lê e devolve o plano em `calls[]`.
 */
export function registerCardUpdateCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("update")
    .description(
      'MUTAÇÃO: vencimento, responsável ou etiqueta do cartão em 1 passo (ex.: card update --card-id 1234 --due 27/10/2026). Campos do formulário: `card update-values`'
    )
    .option("--card-id <id>", "Cartão (número ou link)")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link do cartão, do ambiente do run ou do número do cartão)")
    .option(
      "--due <data>",
      'Vencimento: dd/mm/aaaa, dd/mm/aaaa HH:MM, dd/mm, aaaa-mm-dd [HH:MM], hoje, amanhã (sem hora = 00:00, hora de Brasília). "limpar" tira o vencimento'
    )
    .option(
      "--responsible <pessoa>",
      'Responsável: id, e-mail ou nome de quem a tela deixa escolher no fluxo; "eu" = quem conversa com o agente; "ninguém" tira o responsável'
    )
    .option("--add-tag <etiqueta>", "Põe uma etiqueta do fluxo (nome ou id). Uma por comando; o kit não cria etiqueta", collectRepeatable)
    .option("--remove-tag <etiqueta>", "Tira uma etiqueta do cartão (nome ou id). Uma por comando", collectRepeatable)
    .option("--payload <path>", "AVANÇADO: arquivo JSON {flowId, cardId, userId?, dtDue?, complete?, archived?}")
    .option("--dry-run", "Mostra o plano (calls) sem gravar")
    // P7 (05/10): toda outra escrita aceita --validate-fields e o agente repetia o
    // hábito aqui (erro de opção desconhecida). Aceito e ignorado.
    .option(
      "--validate-fields",
      "Aceito sem efeito: card update não grava values (para campos do formulário use `card update-values --validate-fields`)"
    )
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardUpdateOptions) => {
        const inlineUsed =
          options.due !== undefined ||
          options.responsible !== undefined ||
          (options.addTag?.length ?? 0) > 0 ||
          (options.removeTag?.length ?? 0) > 0;
        if (options.payload !== undefined) {
          if (inlineUsed) {
            throw new CangeCliUsageError(
              "Use --payload OU as opções --due, --responsible, --add-tag e --remove-tag, não os dois."
            );
          }
          return runPayloadMode(kit, options);
        }
        return runInlineMode(kit, authOnce(kit, ensureAuth), options);
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      '{ ok, cardId, flowId, changed: { due?: "27/10/2026 00:00" | null, responsible?: {id, name} | null, tagAdded?: {id, name}, tagRemoved?: {id, name} }, unchanged?: [frases], noop?: true, summary }. ' +
      "--dry-run: { dryRun, executed:false, cardId, flowId, calls: [{call, action, payload}], unchanged, noop?, validation }. " +
      "Com --payload: resposta da API",
    fieldsLocation:
      "Vencimento e responsável vão juntos no mesmo comando (uma gravação, action card_update). Etiqueta é outra permissão " +
      "(Vincular/rotular, action card_link): uma etiqueta por comando, nunca junto com vencimento ou responsável. " +
      "O que já está igual não grava (sai em unchanged). Vencimento sem hora = 00:00, hora de Brasília. Para ler: card read (due, responsible, tags).",
    example: 'card update --card-id 1234 --due 27/10/2026  ·  card update --card-id 1234 --responsible eu  ·  card update --card-id 1234 --add-tag "Quente"'
  });
}

// ---------------------------------------------------------------------------
// Modo --payload (avançado, o de antes)
// ---------------------------------------------------------------------------

async function runPayloadMode(kit: CangeAgentKit, options: CardUpdateOptions): Promise<unknown> {
  const payloadRaw = await readPayloadFile<unknown>(options.payload!);
  const record =
    payloadRaw !== null && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
      ? (payloadRaw as Record<string, unknown>)
      : undefined;
  // v9 (g): o PUT /card ignora flow_tag_id e devolvia 200 (falso sucesso). Etiqueta é outra
  // permissão (Vincular/rotular): não redireciona por baixo de uma classificação card_update.
  if (record && (record.flowTagId !== undefined || record.flow_tag_id !== undefined)) {
    const cardRef = record.cardId ?? record.card_id;
    throw new CangeCliUsageError(
      "card update não grava etiqueta pelo flowTagId (o Cange ignora esse campo). " +
        `Use cange card update --card-id ${cardRef !== undefined ? String(cardRef) : "<id>"} --add-tag "<etiqueta>".`
    );
  }
  const parsed = updateCardPayloadSchema.safeParse(payloadRaw);
  if (!parsed.success) {
    const hasValues = record !== undefined && "values" in record;
    throw new CangeValidationError(
      hasValues
        ? "card update não grava values (só userId, dtDue, complete, archived). Para campos do formulário use `cange card update-values --payload <arquivo>`."
        : "Payload inválido para card update.",
      {
        details: parsed.error.format()
      }
    );
  }

  if (options.dryRun) {
    return createDryRunResult(parsed.data);
  }

  return kit.contracts.updateCard(parsed.data);
}

// ---------------------------------------------------------------------------
// Modo inline (v9)
// ---------------------------------------------------------------------------

type TagOp = { kind: "add" | "remove"; ref: string };

/** Uma chamada do plano (contrato C3 com o gate). */
export interface CardUpdatePlanCall {
  call: "PUT /card" | "POST /flow-tag/card" | "DELETE /flow-tag/card";
  action: "card_update" | "card_link";
  payload: Record<string, unknown>;
}

/** Valor entre aspas para os comandos prontos das mensagens. */
function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function tagCommand(cardId: string, op: TagOp): string {
  return `cange card update --card-id ${cardId} --${op.kind === "add" ? "add" : "remove"}-tag ${quoteArg(op.ref)}`;
}

async function runInlineMode(
  kit: CangeAgentKit,
  auth: () => Promise<unknown>,
  options: CardUpdateOptions
): Promise<unknown> {
  const tagOps: TagOp[] = [
    ...(options.addTag ?? []).map((ref) => ({ kind: "add" as const, ref })),
    ...(options.removeTag ?? []).map((ref) => ({ kind: "remove" as const, ref }))
  ];
  const wantsDue = options.due !== undefined;
  const wantsResponsible = options.responsible !== undefined;

  if (tagOps.length === 0 && !wantsDue && !wantsResponsible) {
    throw new CangeCliUsageError(
      "Informe o que mudar: --due, --responsible, --add-tag ou --remove-tag (ex.: cange card update --card-id 123 --due 27/10/2026)."
    );
  }
  const cardId = requireCardId(options.cardId, "card update");
  if (tagOps.length > 1) {
    throw new CangeCliUsageError(
      ["Uma etiqueta por comando: rode um comando para cada.", ...tagOps.map((op) => tagCommand(cardId, op))].join("\n")
    );
  }
  if (tagOps.length === 1 && (wantsDue || wantsResponsible)) {
    const first = [
      `cange card update --card-id ${cardId}`,
      ...(wantsDue ? [`--due ${quoteArg(options.due!)}`] : []),
      ...(wantsResponsible ? [`--responsible ${quoteArg(options.responsible!)}`] : [])
    ].join(" ");
    throw new CangeCliUsageError(
      ["Etiqueta usa outra permissão (Vincular/rotular): rode em dois comandos.", first, tagCommand(cardId, tagOps[0]!)].join("\n")
    );
  }

  const flowId = resolveWriteFlowId(options.flowId);
  const problems: string[] = [];

  // A data é conferida antes da rede (formato inválido não lê nada a mais do que precisa).
  let due: DueInput | undefined;
  if (wantsDue) {
    due = parseDueInput(options.due!);
    if (!due) problems.push(dueInvalidMessage(options.due!));
  }

  await auth();
  const card = await kit.contracts.getCard({ flowId, cardId });
  const state = cardStateOf(card.raw);

  let responsible: { id: number; name?: string } | null | undefined;
  if (wantsResponsible) {
    const outcome = await resolveResponsible(kit, flowId, options.responsible!);
    if (outcome.ok) responsible = outcome.user;
    else problems.push(`Responsável: ${outcome.error}`);
  }

  let tag: { op: TagOp; tag: FlowTagSummary } | undefined;
  if (tagOps.length === 1) {
    const op = tagOps[0]!;
    const { tags } = await kit.contracts.listFlowTags({ flowId });
    let outcome = resolveTag(op.ref, tags, `#${flowId}`);
    // O GET /card não traz o nome do fluxo: só no erro o kit lê (a mensagem diz o fluxo pelo nome).
    if (!outcome.ok) outcome = resolveTag(op.ref, tags, await flowNameOf(kit, flowId, card.summary.flowName));
    if (outcome.ok) tag = { op, tag: outcome.tag };
    else problems.push(outcome.error);
  }

  const base = { cardId: Number(cardId), flowId: Number(flowId) };
  if (problems.length > 0) {
    const message = problems.join("\n");
    if (options.dryRun) {
      return withExitCode(
        { dryRun: true, executed: false, ...base, calls: [], unchanged: [], validation: { valid: false, message } },
        EXIT_CODES.USAGE
      );
    }
    throw new CangeValidationError(message.includes("nada foi gravado") ? message : `${message}\nNada foi gravado.`, {
      code: "CARD_UPDATE_INVALID"
    });
  }

  const plan = buildPlan(base, state, due, responsible, wantsResponsible, tag);

  if (options.dryRun) {
    return {
      dryRun: true,
      executed: false,
      ...base,
      calls: plan.calls,
      unchanged: plan.unchanged,
      ...(plan.calls.length === 0 ? { noop: true } : {}),
      validation: { valid: true },
      note: isForceDryRun() ? FORCED_DRY_RUN_NOTE : "Mutação não executada porque --dry-run foi informado."
    };
  }

  if (plan.calls.length === 0) {
    return {
      ok: true,
      ...base,
      noop: true,
      unchanged: plan.unchanged,
      summary: `Nada mudou: ${plan.unchanged.map(lowerFirst).map(stripDot).join("; ")}.`
    };
  }

  for (const call of plan.calls) {
    if (call.call === "PUT /card") {
      await kit.contracts.updateCard({
        flowId: base.flowId,
        cardId: base.cardId,
        ...(call.payload.dtDue !== undefined ? { dtDue: call.payload.dtDue as string | null } : {}),
        ...(call.payload.userId !== undefined ? { userId: call.payload.userId as number | null } : {})
      });
    } else if (call.call === "POST /flow-tag/card") {
      await kit.contracts.addCardLabel({ flowId: base.flowId, cardId: base.cardId, flowTagId: Number(call.payload.flowTagId) });
    } else {
      await kit.contracts.removeCardLabel({ flowId: base.flowId, cardId: base.cardId, flowTagId: Number(call.payload.flowTagId) });
    }
  }

  return {
    ok: true,
    ...base,
    changed: plan.changed,
    ...(plan.unchanged.length > 0 ? { unchanged: plan.unchanged } : {}),
    summary: `Cartão ${cardId}: ${plan.summaryParts.join(", ")}.`
  };
}

async function flowNameOf(kit: CangeAgentKit, flowId: string, known: string | undefined): Promise<string> {
  if (known) return known;
  try {
    const title = (await kit.contracts.getFlow({ idFlow: flowId })).summary.title;
    return title ? String(title) : `#${flowId}`;
  } catch {
    return `#${flowId}`;
  }
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function stripDot(text: string): string {
  return text.replace(/\.$/, "");
}

interface Plan {
  calls: CardUpdatePlanCall[];
  unchanged: string[];
  changed: Record<string, unknown>;
  summaryParts: string[];
}

/** O que muda de fato (o que já está igual não vira requisição). Exportado para os testes. */
export function buildPlan(
  base: { cardId: number; flowId: number },
  state: CardState,
  due: DueInput | undefined,
  responsible: { id: number; name?: string } | null | undefined,
  wantsResponsible: boolean,
  tag: { op: TagOp; tag: FlowTagSummary } | undefined
): Plan {
  const calls: CardUpdatePlanCall[] = [];
  const unchanged: string[] = [];
  const changed: Record<string, unknown> = {};
  const summaryParts: string[] = [];
  const put: Record<string, unknown> = {};

  if (due) {
    if (due.kind === "clear") {
      if (state.due === null) {
        unchanged.push("O cartão já estava sem vencimento.");
      } else {
        put.dtDue = null;
        put.dueLabel = null;
        changed.due = null;
        summaryParts.push("vencimento removido");
      }
    } else if (state.due === due.wall) {
      unchanged.push(`O vencimento já era ${dueLabel(due.wall)}.`);
    } else {
      put.dtDue = due.wall;
      put.dueLabel = dueLabel(due.wall);
      changed.due = dueLabel(due.wall);
      summaryParts.push(`vencimento ${dueLabel(due.wall)}`);
    }
  }

  if (wantsResponsible && responsible !== undefined) {
    const current = state.responsible;
    if (responsible === null) {
      if (current === null) {
        unchanged.push("O cartão já estava sem responsável.");
      } else {
        put.userId = null;
        put.responsibleName = null;
        changed.responsible = null;
        summaryParts.push("sem responsável");
      }
    } else if (current !== null && current.id === responsible.id) {
      unchanged.push(`O responsável já era ${responsible.name ?? current.name ?? `o usuário ${responsible.id}`}.`);
    } else {
      put.userId = responsible.id;
      put.responsibleName = responsible.name ?? null;
      changed.responsible = { id: responsible.id, ...(responsible.name ? { name: responsible.name } : {}) };
      summaryParts.push(`responsável ${responsible.name ?? `usuário ${responsible.id}`}`);
    }
  }

  if (Object.keys(put).length > 0) {
    calls.push({ call: "PUT /card", action: "card_update", payload: { ...base, ...put } });
  }

  if (tag) {
    const present = state.tags.some((item) => item.id === tag.tag.id);
    const info = { id: tag.tag.id, name: tag.tag.name };
    const payload = { ...base, flowTagId: tag.tag.id, tagName: tag.tag.name };
    if (tag.op.kind === "add") {
      if (present) {
        unchanged.push(`A etiqueta ${tag.tag.name} já estava no cartão.`);
      } else {
        calls.push({ call: "POST /flow-tag/card", action: "card_link", payload });
        changed.tagAdded = info;
        summaryParts.push(`etiqueta ${tag.tag.name} adicionada`);
      }
    } else if (!present) {
      unchanged.push(`A etiqueta ${tag.tag.name} não estava no cartão.`);
    } else {
      calls.push({ call: "DELETE /flow-tag/card", action: "card_link", payload });
      changed.tagRemoved = info;
      summaryParts.push(`etiqueta ${tag.tag.name} removida`);
    }
  }

  return { calls, unchanged, changed, summaryParts };
}

// ---------------------------------------------------------------------------
// Responsável
// ---------------------------------------------------------------------------

const CLEAR_RESPONSIBLE = new Set(["ninguem", "nenhum", "limpar"]);

type ResponsibleOutcome = { ok: true; user: { id: number; name?: string } | null } | { ok: false; error: string };

/**
 * Candidatos = a lista do seletor de responsável da tela (`GET /user/by-flow?id_flow`, sem o
 * leitor). Régua do `--mention`: id, e-mail exato, nome exato sem acento e caixa, depois
 * trecho único. `eu` = RUNNER_SPEAKER_USER_ID, que também precisa estar na lista.
 */
async function resolveResponsible(kit: CangeAgentKit, flowId: string, ref: string): Promise<ResponsibleOutcome> {
  const text = ref.trim().replace(/^@/, "");
  if (CLEAR_RESPONSIBLE.has(normalizeText(text))) return { ok: true, user: null };
  let speaker: number | undefined;
  if (isSpeakerRef(text)) {
    speaker = envSpeakerUserId();
    if (speaker === undefined) return { ok: false, error: SPEAKER_OUTSIDE_CHAT_MESSAGE };
  }
  const { users } = await kit.contracts.listUsersByFlow({ flowId });
  return pickResponsible(text, users.filter((user) => user.flowUserType !== "V"), speaker);
}

/** Exportado para os testes. */
export function pickResponsible(ref: string, users: FlowUserSummary[], speaker?: number): ResponsibleOutcome {
  const text = ref.trim().replace(/^@/, "");
  const notFound: ResponsibleOutcome = {
    ok: false,
    error: `nenhum usuário "${text}" entre os que a tela deixa escolher neste fluxo.`
  };
  const one = (user: FlowUserSummary): ResponsibleOutcome => ({
    ok: true,
    user: { id: user.id, ...(user.name ? { name: user.name } : {}) }
  });
  const asId = speaker ?? (/^#?\d+$/.test(text) ? Number(text.replace(/^#/, "")) : undefined);
  if (asId !== undefined) {
    const hit = users.find((user) => user.id === asId);
    return hit ? one(hit) : notFound;
  }
  let pool: FlowUserSummary[];
  if (text.includes("@")) {
    pool = users.filter((user) => user.email?.toLowerCase() === text.toLowerCase());
  } else {
    const wanted = normalizeText(text);
    if (wanted === "") return notFound;
    const exact = users.filter((user) => user.name && normalizeText(user.name) === wanted);
    pool = exact.length > 0 ? exact : users.filter((user) => user.name && normalizeText(user.name).includes(wanted));
  }
  if (pool.length === 1) return one(pool[0]!);
  if (pool.length === 0) return notFound;
  return {
    ok: false,
    error: `"${text}" é ambíguo: ${pool
      .slice(0, 8)
      .map((user) => `${user.name ?? "?"} (id ${user.id}${user.email ? `, ${user.email}` : ""})`)
      .join(", ")}${pool.length > 8 ? ", ..." : ""}.`
  };
}

// ---------------------------------------------------------------------------
// Etiqueta
// ---------------------------------------------------------------------------

/** Exportado para os testes. Nunca cria etiqueta. */
export function resolveTag(
  ref: string,
  tags: FlowTagSummary[],
  flowName: string
): { ok: true; tag: FlowTagSummary } | { ok: false; error: string } {
  const text = ref.trim();
  if (tags.length === 0) {
    return {
      ok: false,
      error: `O fluxo ${flowName} não tem etiquetas. Quem administra o fluxo cria na tela do fluxo; nada foi gravado.`
    };
  }
  if (/^#?\d+$/.test(text)) {
    const hit = tags.find((tag) => tag.id === Number(text.replace(/^#/, "")));
    if (hit) return { ok: true, tag: hit };
  }
  const wanted = normalizeText(text);
  const exact = wanted === "" ? [] : tags.filter((tag) => normalizeText(tag.name) === wanted);
  const pool = exact.length > 0 || wanted === "" ? exact : tags.filter((tag) => normalizeText(tag.name).includes(wanted));
  if (pool.length === 1) return { ok: true, tag: pool[0]! };
  if (pool.length > 1) {
    return {
      ok: false,
      error: `Etiqueta "${text}" é ambígua no fluxo ${flowName}: ${pool
        .map((tag) => `${tag.name} (id ${tag.id})`)
        .join(", ")}. Use o nome inteiro ou o id; nada foi gravado.`
    };
  }
  const names = [...tags]
    .map((tag) => tag.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const listed = names.slice(0, 20).join(", ") + (names.length > 20 ? ", ..." : "");
  return {
    ok: false,
    error: `Etiqueta "${text}" não existe no fluxo ${flowName}. Etiquetas do fluxo: ${listed}. O kit não cria etiqueta; nada foi gravado.`
  };
}
