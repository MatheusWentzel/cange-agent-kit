import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";

interface CardReadOptions {
  flowId?: string;
  cardId?: string;
  cardIds?: string;
  fieldIds?: string;
}

/** Teto do batch: acima disso o output deixa de ser "enxuto" e vira despejo. */
const READ_MANY_MAX = 30;
/** Concorrência das leituras do batch (gentil com a API, rápido o bastante). */
const READ_MANY_CONCURRENCY = 5;

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
      "--field-ids <ids>",
      "Filtra fieldValues por IDs de field (lista separada por vírgula)"
    )
    .action(
      createCommandAction(async ({ kit }, options: CardReadOptions) => {
        // Defaults do ambiente do runner (flag explícita vence). Sem os dois →
        // erro CLARO aqui, não um usage error genérico.
        const flowId = options.flowId ?? envFlowId();
        if (!flowId) {
          throw new CangeCliUsageError(
            "--flow-id é obrigatório (em automação, RUNNER_FLOW_ID/CANGE_CARD_FLOW_ID do ambiente são usados como default)."
          );
        }
        options.flowId = flowId;
        if (!options.cardId && !options.cardIds) {
          options.cardId = envCardId();
        }
        const requested = (options.fieldIds ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);

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
          const cards = await mapWithConcurrency(ids, READ_MANY_CONCURRENCY, async (cardId) => {
            try {
              const result = await kit.contracts.getCard({ flowId, cardId });
              return buildLeanRead(result, requested);
            } catch (error) {
              // Um card com erro não derruba o lote — vira entrada de erro legível.
              return { cardId: Number(cardId), error: error instanceof Error ? error.message : String(error) };
            }
          });
          return { count: cards.length, cards };
        }

        if (!options.cardId) {
          throw new CangeCliUsageError("Informe --card-id (ou --card-ids para lote).");
        }

        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId
        });
        return buildLeanRead(result, requested);
      })
    );

  annotateCommand(command, {
    envelope:
      "{ cardId, title, flowId, flowName, stepId, stepName, createdAt, archived, complete, fieldValues, links?, registerLinks? } — com --card-ids: { count, cards: [<mesmo shape>] }",
    fieldsLocation:
      "fieldValues: chave = field id, valor = texto legível (multi-valor vira array). links: vínculos COMBO_BOX_FLOW_FIELD — [{cardId, label}] (acha os FILHOS de um pai). registerLinks: COMBO_BOX_REGISTER_FIELD — [{entryId, label}] (o entryId pronto p/ usar em campo de register de outro card)",
    example: "card read --flow-id 22795 --card-ids 1223901,1223902,1223903"
  });
}

/** Monta a visão enxuta a partir do envelope do getCard (single e lote usam o mesmo). */
function buildLeanRead(
  result: { raw: unknown; summary: unknown },
  requestedFieldIds: string[]
): Record<string, unknown> {
  const s = result.summary as Record<string, unknown>;
  const extracted = extractValuesAndLinks(result.raw);

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

/** Promise.all com teto de concorrência (ordem do input preservada). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
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
