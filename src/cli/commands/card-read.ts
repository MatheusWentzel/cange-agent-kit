import type { Command } from "commander";

import { CangeCliUsageError, CangeError } from "../../client/errors.js";
import type { BatchAbort } from "../../utils/batchRunner.js";
import {
  BACKEND_READ_RPS_LIMIT,
  DEFAULT_READ_RPS,
  isRateLimitError,
  mapWithThrottle,
  retryAfterMs
} from "../../utils/rateLimit.js";
import { dropEmpty, htmlToMarkdown, looksLikeHtml, type OutputProfile } from "../../utils/lean.js";
import { listFieldTitles, matchFieldsByKey } from "../../utils/valueResolver.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "../resource-ref.js";
import { exitCodeForBatch } from "../exit-codes.js";

interface CardReadOptions {
  flowId?: string;
  cardId?: string;
  cardIds?: string;
  fieldIds?: string;
  fields?: string;
  rps?: string;
}

/**
 * Pedido de campos da leitura. `original` (--field-ids): valor cru, para reescrever.
 * `readable` (--fields): valor legível (markdown) INTEIRO, sem o corte do padrão.
 */
interface FieldRequest {
  ids: string[];
  mode: "original" | "readable";
  /** Título de cada id pedido (do fluxo): campo vazio no cartão sai com o título. */
  titles: Record<string, string>;
}

/** Teto do batch: acima disso o output deixa de ser "enxuto" e vira despejo. */
const READ_MANY_MAX = 30;
/**
 * Concorrência do batch. Sozinha ela NÃO limita a taxa: 5 leituras em voo de
 * 60 ms cada dão ~80 req/s, muito acima do teto de GET do backend (10 req/s) —
 * e estourar bloqueia a chave por 5 minutos. Quem limita a taxa é o `rps`.
 */
const READ_MANY_CONCURRENCY = 5;
/**
 * Bloqueio do `apiRateLimiter` do backend (`blockTimeInMinutes` = 5). Piso
 * usado quando o 429 vem sem `Retry-After` — hoje, sempre.
 */
const RATE_LIMIT_BLOCK_FALLBACK_SECONDS = 300;

/**
 * `cange card read` — leitura ENXUTA de um card, feita para agentes.
 *
 * `card get` devolve o envelope completo com `raw` (a resposta crua pode passar
 * de 1 MB) e o agente paga esse tamanho em tokens de contexto. Este comando faz
 * a MESMA consulta e devolve só o que um agente precisa para decidir.
 *
 * Dois problemas reais que este comando resolve (runs do agente Comprador,
 * cards 1219728/1219776):
 *   · O summary legado COLAPSA campo multi-valor (o último valor vence): um
 *     vínculo "Itens do Pedido" com 3 cards mostrava só 1. Aqui `fieldValues`
 *     agrega multi-valor em ARRAY e ignora respostas deletadas.
 *   · Os VÍNCULOS entre flows (COMBO_BOX_FLOW_FIELD) não apareciam com os ids
 *     dos cards apontados — o agente tinha que baixar o raw de 1,3 MB do pai só
 *     para achar os filhos. Aqui `links` traz `{ fieldId: [{cardId, label}] }`
 *     prontos (direção pai -> filhos; a direção inversa é `card relationship`).
 */
export function registerCardReadCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("read")
    .description(
      "LEITURA ENXUTA do card (etapa atual + valores legíveis + vínculos, sem raw) — use este por padrão; `card get` só quando precisar do raw"
    )
    .option("--flow-id <id>", "ID do flow (default: RUNNER_FLOW_ID/CANGE_CARD_FLOW_ID do ambiente do runner)")
    .option("--card-id <id>", "ID do card (default: RUNNER_CARD_ID do ambiente do runner)")
    .option(
      "--card-ids <ids>",
      `Lote: lista de card ids separados por vírgula (máx ${READ_MANY_MAX}) — 1 comando lê N cards do mesmo flow`
    )
    .option(
      "--fields <campos>",
      'Só estes campos, pelo TÍTULO (sem diferença de maiúscula/acento), id ou hash, separados por vírgula: --fields "Valor,Data da ligação". Valor legível e INTEIRO (sem o corte de ' +
        "600 caracteres do padrão)"
    )
    .option(
      "--field-ids <ids>",
      "Filtra por IDs de field (lista separada por vírgula) e devolve o valor ORIGINAL (HTML do rich text), para reescrever"
    )
    .option(
      "--rps <n>",
      `Lote: requisições por segundo (default ${DEFAULT_READ_RPS}; teto do backend em leitura: ${BACKEND_READ_RPS_LIMIT}/s, e estourar bloqueia a chave por ~5 min)`
    )
    .action(
      createCommandAction(async ({ kit, profile }, options: CardReadOptions) => {
        // Defaults do ambiente do runner (flag explícita vence). Sem os dois →
        // erro CLARO aqui, não um usage error genérico.
        const flowId = options.flowId ?? envFlowId();
        if (!flowId) {
          throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);
        }
        options.flowId = flowId;
        if (!options.cardId && !options.cardIds) {
          options.cardId = envCardId();
        }
        const request = await resolveFieldRequest(kit, flowId, options);

        // ── Modo LOTE (redução de custo do agente: 1 passo lê N cards — em
        // pedidos com 10-20 itens, cada passo economizado poupa o contexto
        // inteiro re-lido pelo modelo).
        if (options.cardIds) {
          if (options.cardId) {
            throw new CangeCliUsageError("Use --card-id OU --card-ids, não os dois.");
          }
          const ids = options.cardIds
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          if (ids.length === 0) {
            throw new CangeCliUsageError("--card-ids vazio.");
          }
          if (ids.length > READ_MANY_MAX) {
            throw new CangeCliUsageError(
              `--card-ids aceita no máximo ${READ_MANY_MAX} cards por chamada (recebi ${ids.length}).`
            );
          }
          let errors = 0;
          let notAttempted = 0;
          let firstError: unknown;
          // Disjuntor de bloqueio: com a chave bloqueada (429) TODA leitura
          // seguinte falha — e cada uma ainda gasta os retries internos do
          // cliente. Ao primeiro 429 o lote para e o resto volta como NÃO
          // TENTADO, para o agente saber o que reprocessar.
          let aborted: BatchAbort | undefined;
          const cards = await mapWithThrottle(
            ids,
            { rps: parseRps(options.rps), concurrency: READ_MANY_CONCURRENCY },
            async (cardId) => {
              if (aborted) {
                notAttempted += 1;
                return {
                  cardId: Number(cardId),
                  notAttempted: true,
                  error: "não tentado — leitura interrompida por bloqueio de rate limit (429)"
                };
              }
              try {
                const result = await kit.contracts.getCard({ flowId, cardId });
                return buildLeanRead(result, request, profile);
              } catch (error) {
                // Um card com erro não derruba o lote — vira entrada de erro
                // legível E entra na contagem: lote incompleto sai com exit 5,
                // nunca como leitura completa (ver EXIT_CODES.PARTIAL).
                errors += 1;
                firstError ??= error;
                if (isRateLimitError(error)) {
                  const waitMs = retryAfterMs(error);
                  aborted = {
                    reason: "RATE_LIMIT_BLOCK",
                    message:
                      "Teto de requisições da API estourado (429). A chave fica bloqueada por ~5 minutos e, " +
                      "enquanto isso, TODA leitura falha: o lote foi INTERROMPIDO para não queimar requisições " +
                      "e o tempo da execução. Espere o bloqueio passar e leia de novo SÓ os cards que faltaram.",
                    retryAfterSeconds:
                      waitMs !== undefined ? Math.round(waitMs / 1000) : RATE_LIMIT_BLOCK_FALLBACK_SECONDS
                  };
                }
                return { cardId: Number(cardId), error: describeError(error) };
              }
            }
          );
          const envelope = {
            count: cards.length,
            ok: cards.length - errors - notAttempted,
            errors,
            ...(notAttempted > 0 ? { notAttempted } : {}),
            ...(aborted ? { aborted } : {}),
            cards: profile === "lean" ? cards.map((card) => dropEmpty(card)) : cards
          };
          // `errors > 0 ? PARTIAL` mentia quando NADA foi lido (flow errado ⇒
          // 30 falhas com exit 5, que o contrato define como "parte passou").
          return withExitCode(
            envelope,
            exitCodeForBatch({ succeeded: envelope.ok, failed: errors + notAttempted, firstError })
          );
        }

        if (!options.cardId) {
          throw new CangeCliUsageError("Informe --card-id (ou --card-ids para lote).");
        }

        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId
        });
        const read = buildLeanRead(result, request, profile);
        return profile === "lean" ? dropEmpty(read) : read;
      })
    );

  annotateCommand(command, {
    envelope:
      "Enxuto (padrão): { cardId, title, flowId, flowName, stepId, stepName, dueDate?, completedAt?, responsibleName?, archived, complete, fields: [{id, title, value} | {id, title, cards: [{cardId, label}]} | {id, title, entries: [{entryId, label}]}] } (rich text em markdown; valor acima de 600 caracteres sai cortado com a dica do --fields; --fields \"<título>\" traz só esses campos, inteiros; --field-ids devolve o valor original). " +
      "Com --full: { cardId, title, flowId, flowName, stepId, stepName, createdAt, archived, complete, fieldValues, links?, registerLinks? } — com --card-ids: { count, ok, errors, notAttempted?, aborted?, cards: [<mesmo shape>; card que falhou vira {cardId, error}] }. Lote parcial sai com exit code 5; lote em que NADA foi lido sai com a categoria do erro (ex.: 4). Em 429 o lote PARA e o restante volta como notAttempted.",
    fieldsLocation:
      "fieldValues: chave = field id, valor = texto legível (multi-valor vira array). links: vínculos COMBO_BOX_FLOW_FIELD — [{cardId, label}] (acha os FILHOS de um pai). registerLinks: COMBO_BOX_REGISTER_FIELD — [{entryId, label}] (o entryId pronto p/ usar em campo de register de outro card)",
    example: 'card read --card-id 1223901 --fields "Valor,Data da ligação"  ·  card read --flow-id 22795 --card-ids 1223901,1223902'
  });
}

/** Monta a visão enxuta a partir do envelope do getCard (single e lote usam o mesmo). */
function buildLeanRead(
  result: { raw: unknown; summary: unknown },
  request: FieldRequest | undefined,
  profile: OutputProfile = "full"
): Record<string, unknown> {
  const s = result.summary as Record<string, unknown>;
  const extracted = extractValuesAndLinks(result.raw);
  if (profile === "lean") {
    return buildAgentRead(s, extracted, request);
  }
  const requestedFieldIds = request?.ids ?? [];

  // Preferência: valores agregados do raw (multi-valor vira array, deletado
  // sai); fallback no summary legado quando o raw não tiver form_answers.
  let fieldValues =
    extracted.fieldValues ??
    ((s.fieldValues ?? s.fields ?? {}) as Record<string, unknown>);

  if (requestedFieldIds.length > 0) {
    const filtered: Record<string, unknown> = {};
    for (const id of requestedFieldIds) {
      filtered[id] = id in fieldValues ? fieldValues[id] : null;
    }
    fieldValues = filtered;
  } else {
    // Cap de campo gigante (só quando NÃO foi pedido campo específico): um
    // rich-text com ata de reunião inteira (14KB, caso real do card 1079918)
    // dominava o digest e era relido a cada turno do agente. Pedir o campo
    // explicitamente (--field-ids) devolve o valor completo.
    fieldValues = capOversizedFieldValues(fieldValues);
  }

  return {
    cardId: s.cardId ?? s.id_card,
    title: s.title,
    flowId: s.flowId ?? s.flow_id,
    flowName: s.flowName,
    stepId: s.currentStepId ?? s.step_id,
    stepName: s.stepName,
    createdAt: s.createdAt,
    archived: s.archived,
    complete: s.complete,
    fieldValues,
    ...(extracted.links && Object.keys(extracted.links).length > 0
      ? { links: extracted.links }
      : {}),
    ...(extracted.registerLinks && Object.keys(extracted.registerLinks).length > 0
      ? { registerLinks: extracted.registerLinks }
      : {})
  };
}

/**
 * Rodada 5 (saída enxuta, padrão): o TÍTULO de cada campo vem junto do valor (o
 * agente rodava `map` só para saber o que era `fieldValues[381929]`), o vínculo
 * aparece uma vez só, dentro do campo (antes o rótulo vinha em `fieldValues` E em
 * `links`), e rich text vira markdown com os links preservados antes do corte.
 * `--field-ids` devolve o valor ORIGINAL (sem converter nem cortar): é o que se
 * usa para reescrever um campo.
 */
function buildAgentRead(
  s: Record<string, unknown>,
  extracted: ExtractedCard,
  request: FieldRequest | undefined
): Record<string, unknown> {
  const values: Record<string, unknown> =
    extracted.fieldValues ?? ((s.fieldValues ?? s.fields ?? {}) as Record<string, unknown>);
  const titles = { ...(request?.titles ?? {}), ...(extracted.fieldTitles ?? {}) };
  const links = extracted.links ?? {};
  const registerLinks = extracted.registerLinks ?? {};
  const requested = request !== undefined && request.ids.length > 0;

  const order: string[] = requested
    ? request.ids
    : Array.from(new Set([...Object.keys(values), ...Object.keys(links), ...Object.keys(registerLinks)]));

  const fields = order.map((fieldId) => {
    const entry: Record<string, unknown> = {
      id: /^\d+$/.test(fieldId) ? Number(fieldId) : fieldId,
      title: titles[fieldId]
    };
    if (links[fieldId]) {
      entry.cards = links[fieldId];
    } else if (registerLinks[fieldId]) {
      entry.entries = registerLinks[fieldId];
    } else {
      const value = fieldId in values ? values[fieldId] : null;
      if (requested && request.mode === "original") {
        entry.value = value;
      } else {
        // C4: sem --fields o valor longo é cortado em 600 caracteres; com --fields sai inteiro.
        const readable = readableValue(value, requested ? undefined : cutHint(fieldId, titles[fieldId]));
        entry.value = readable.value;
        // R5-KR-07: o valor convertido de HTML para markdown vem MARCADO. Gravar o
        // markdown de volta num campo rich text mostraria `[texto](url)` literal:
        // antes de reescrever, o agente busca o original com `--field-ids`.
        if (readable.converted) entry.format = "markdown";
      }
    }
    return entry;
  });

  return {
    cardId: s.cardId ?? s.id_card,
    title: s.title,
    flowId: s.flowId ?? s.flow_id,
    flowName: s.flowName,
    stepId: s.currentStepId ?? s.step_id,
    stepName: s.stepName,
    createdAt: s.createdAt,
    dueDate: s.dueDate,
    completedAt: s.completedAt,
    responsibleUserId: s.responsibleUserId,
    responsibleName: s.responsibleName,
    archived: s.archived,
    complete: s.complete,
    fields
  };
}

/**
 * Valor legível: HTML vira markdown e o que passa do teto é cortado com marcador.
 * `converted` diz se algum item veio de HTML (o campo sai com `format: "markdown"`).
 */
function readableValue(value: unknown, hint: string | undefined): { value: unknown; converted: boolean } {
  let converted = false;
  const one = (item: unknown): unknown => {
    if (typeof item !== "string") return item;
    const isHtml = looksLikeHtml(item);
    if (isHtml) converted = true;
    const text = isHtml ? htmlToMarkdown(item) : item;
    if (hint === undefined || text.length <= LEAN_FIELD_VALUE_CAP) return text;
    return `${text.slice(0, LEAN_FIELD_VALUE_CAP)}…(cortado: use ${hint} para ler inteiro)`;
  };
  const out = Array.isArray(value) ? value.map(one) : one(value);
  return { value: out, converted };
}

/**
 * C4 (card #1367459): teto do valor no padrão enxuto. Ler o cartão era 8% do custo
 * em produção, com 62 releituras do mesmo cartão: o rich text inteiro (ata de
 * reunião) ia junto em cada uma. O inteiro vem com `--fields "<título>"`.
 */
const LEAN_FIELD_VALUE_CAP = 600;

/** `--fields "<título>"` (ou o id, quando o título falta ou tem aspas/vírgula). */
function cutHint(fieldId: string, title: string | undefined): string {
  const key = title && !/[",]/.test(title) ? title : fieldId;
  return `--fields "${key}"`;
}

/**
 * Resolve `--fields` (título, id ou hash, como nas escritas) e `--field-ids` (ids).
 * `--fields` consulta os campos do fluxo uma vez (também no lote).
 */
async function resolveFieldRequest(
  kit: { contracts: { getFieldsByFlow: (input: { flowId: string | number }) => Promise<{ fields: NormalizedField[] }> } },
  flowId: string,
  options: CardReadOptions
): Promise<FieldRequest | undefined> {
  const split = (text: string | undefined): string[] =>
    (text ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  const keys = split(options.fields);
  const fieldIds = split(options.fieldIds);
  if (keys.length > 0 && fieldIds.length > 0) {
    throw new CangeCliUsageError(
      "Use --fields (valor legível, inteiro) OU --field-ids (valor original, para reescrever), não os dois."
    );
  }
  if (fieldIds.length > 0) return { ids: fieldIds, mode: "original", titles: {} };
  if (keys.length === 0) return undefined;

  const { fields } = await kit.contracts.getFieldsByFlow({ flowId });
  const ids: string[] = [];
  const titles: Record<string, string> = {};
  const unknown: string[] = [];
  for (const key of keys) {
    const hits = matchFieldsByKey(key, fields);
    if (hits.length === 0) {
      unknown.push(key);
      continue;
    }
    for (const field of hits) {
      const id = String(field.id ?? field.name);
      if (!ids.includes(id)) ids.push(id);
      if (field.title) titles[id] = field.title;
    }
  }
  if (unknown.length > 0) {
    throw new CangeCliUsageError(
      `Campo ${unknown.map((key) => `"${key}"`).join(", ")} não existe no fluxo ${flowId} (campos: ${listFieldTitles(fields)}).`
    );
  }
  return { ids, mode: "readable", titles };
}

/**
 * Cap por CAMPO no digest do card read: valores string acima de 2.000 chars são
 * truncados com marcador dizendo como obter o inteiro (`--field-ids <id>`).
 * Multi-valor (array) tem cada item capado individualmente.
 */
const FIELD_VALUE_CAP = 2_000;

function capOversizedFieldValues(fieldValues: Record<string, unknown>): Record<string, unknown> {
  const capOne = (fieldId: string, value: unknown): unknown => {
    if (typeof value !== "string" || value.length <= FIELD_VALUE_CAP) return value;
    return (
      value.slice(0, FIELD_VALUE_CAP) +
      ` […truncado ${value.length - FIELD_VALUE_CAP} chars — use --field-ids ${fieldId} p/ o valor completo]`
    );
  };
  const out: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(fieldValues)) {
    out[fieldId] = Array.isArray(value)
      ? value.map((item) => capOne(fieldId, item))
      : capOne(fieldId, value);
  }
  return out;
}

function parseRps(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_READ_RPS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CangeCliUsageError(`--rps inválido: "${raw}" (esperado número > 0).`);
  }
  if (value > BACKEND_READ_RPS_LIMIT) {
    throw new CangeCliUsageError(
      `--rps ${value} passa do teto de leitura do backend (${BACKEND_READ_RPS_LIMIT} req/s) — estourar bloqueia a chave por ~5 minutos.`
    );
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof CangeError && error.status !== undefined) {
    return `[${error.status}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

interface CardLink {
  cardId: number | string;
  label?: string;
}

interface RegisterLink {
  entryId: number;
  label?: string;
}

interface ExtractedCard {
  fieldValues?: Record<string, unknown>;
  /** Rodada 5: título de cada campo (do `field` do raw), para a saída enxuta. */
  fieldTitles?: Record<string, string>;
  links?: Record<string, CardLink[]>;
  registerLinks?: Record<string, RegisterLink[]>;
}

/**
 * Reconstrói valores e vínculos direto do raw do card: agrega multi-valor,
 * filtra respostas/answer-fields deletados (`deleted === "S"`) e materializa os
 * COMBO_BOX_FLOW_FIELD como `{cardId, label}` (value = id do card apontado,
 * valueString = título dele).
 */
function extractValuesAndLinks(raw: unknown): ExtractedCard {
  const record = asRecord(raw);
  const formAnswers = record ? toRecordArray(record.form_answers) : [];
  if (formAnswers.length === 0) return {};

  const valuesByField = new Map<string, unknown[]>();
  const titlesByField = new Map<string, string>();
  const linksByField = new Map<string, CardLink[]>();
  const registerLinksByField = new Map<string, RegisterLink[]>();

  for (const answer of formAnswers) {
    if (isDeleted(answer)) continue;
    for (const answerField of toRecordArray(answer.form_answer_fields)) {
      if (isDeleted(answerField)) continue;

      const field = asRecord(answerField.field);
      const fieldId = pickIdish(answerField, ["field_id", "id_field", "id"]) ?? pickIdish(field ?? {}, ["id_field", "field_id", "id"]);
      if (fieldId === undefined) continue;
      const key = String(fieldId);
      const fieldTitle = field ? pickText(field, ["title"]) : undefined;
      if (fieldTitle !== undefined && !titlesByField.has(key)) titlesByField.set(key, fieldTitle);

      const valueString = pickText(answerField, ["valueString", "value_string"]);
      const rawValue = pickText(answerField, ["value"]);
      const display = valueString ?? rawValue;
      if (display !== undefined) {
        const bucket = valuesByField.get(key) ?? [];
        bucket.push(display);
        valuesByField.set(key, bucket);
      }

      const fieldType = field ? String(field.type ?? "") : "";
      if (fieldType === "COMBO_BOX_FLOW_FIELD" && rawValue !== undefined && /^\d+$/.test(String(rawValue))) {
        const bucket = linksByField.get(key) ?? [];
        bucket.push({
          cardId: Number(rawValue),
          ...(valueString !== undefined ? { label: valueString } : {})
        });
        linksByField.set(key, bucket);
      }
      // 5.1 (retro runs 16-19): o id da ENTRADA do cadastro (value numérico do
      // COMBO_BOX_REGISTER_FIELD) era invisível — 3 de 4 runs queimaram passos
      // parseando o raw para achá-lo (é o que o card create exige no campo de
      // register). Agora sai pronto em `registerLinks`.
      if (fieldType === "COMBO_BOX_REGISTER_FIELD" && rawValue !== undefined && /^\d+$/.test(String(rawValue))) {
        const bucket = registerLinksByField.get(key) ?? [];
        bucket.push({
          entryId: Number(rawValue),
          ...(valueString !== undefined ? { label: valueString } : {})
        });
        registerLinksByField.set(key, bucket);
      }
    }
  }

  if (valuesByField.size === 0 && linksByField.size === 0 && registerLinksByField.size === 0) return {};

  const fieldValues: Record<string, unknown> = {};
  for (const [key, values] of valuesByField) {
    fieldValues[key] = values.length === 1 ? values[0] : values;
  }
  const links: Record<string, CardLink[]> = {};
  for (const [key, list] of linksByField) {
    links[key] = list;
  }
  const registerLinks: Record<string, RegisterLink[]> = {};
  for (const [key, list] of registerLinksByField) {
    registerLinks[key] = list;
  }

  return {
    fieldValues: Object.keys(fieldValues).length > 0 ? fieldValues : undefined,
    fieldTitles: titlesByField.size > 0 ? Object.fromEntries(titlesByField) : undefined,
    links: Object.keys(links).length > 0 ? links : undefined,
    registerLinks: Object.keys(registerLinks).length > 0 ? registerLinks : undefined
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

function isDeleted(record: Record<string, unknown>): boolean {
  return typeof record.deleted === "string" && record.deleted.trim().toUpperCase() === "S";
}

function pickIdish(record: Record<string, unknown>, keys: string[]): number | string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function pickText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}
