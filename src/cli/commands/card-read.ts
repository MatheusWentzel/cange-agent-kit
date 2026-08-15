import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CardReadOptions {
  flowId: string;
  cardId: string;
  fieldIds?: string;
}

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
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--card-id <id>", "ID do card")
    .option(
      "--field-ids <ids>",
      "Filtra fieldValues por IDs de field (lista separada por vírgula)"
    )
    .action(
      createCommandAction(async ({ kit }, options: CardReadOptions) => {
        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId
        });

        const s = result.summary as Record<string, unknown>;
        const extracted = extractValuesAndLinks(result.raw);

        // Preferência: valores agregados do raw (multi-valor vira array, deletado
        // sai); fallback no summary legado quando o raw não tiver form_answers.
        let fieldValues =
          extracted.fieldValues ??
          ((s.fieldValues ?? s.fields ?? {}) as Record<string, unknown>);

        const requested = (options.fieldIds ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (requested.length > 0) {
          const filtered: Record<string, unknown> = {};
          for (const id of requested) {
            filtered[id] = id in fieldValues ? fieldValues[id] : null;
          }
          fieldValues = filtered;
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
            : {})
        };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ cardId, title, flowId, flowName, stepId, stepName, createdAt, archived, complete, fieldValues, links? }",
    fieldsLocation:
      "fieldValues: chave = field id, valor = texto legível (multi-valor vira array). links: vínculos COMBO_BOX_FLOW_FIELD por field id — [{cardId, label}] (é assim que se acham os FILHOS de um card pai)",
    example: "card read --flow-id 22792 --card-id 1219728"
  });
}

interface CardLink {
  cardId: number | string;
  label?: string;
}

interface ExtractedCard {
  fieldValues?: Record<string, unknown>;
  links?: Record<string, CardLink[]>;
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
    }
  }

  if (valuesByField.size === 0 && linksByField.size === 0) return {};

  const fieldValues: Record<string, unknown> = {};
  for (const [key, values] of valuesByField) {
    fieldValues[key] = values.length === 1 ? values[0] : values;
  }
  const links: Record<string, CardLink[]> = {};
  for (const [key, list] of linksByField) {
    links[key] = list;
  }

  return {
    fieldValues: Object.keys(fieldValues).length > 0 ? fieldValues : undefined,
    links: Object.keys(links).length > 0 ? links : undefined
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
