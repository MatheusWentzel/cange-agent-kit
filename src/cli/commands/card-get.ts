import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";

interface CardGetOptions {
  flowId?: string;
  cardId?: string;
  companyId?: string;
  fieldIds?: string;
  summaryOnly?: boolean;
  raw?: boolean;
  rawFull?: boolean;
}

export function registerCardGetCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("get")
    .description("Busca um cartão por flow_id + id_card (summary por padrão; --raw p/ resposta crua)")
    .option("--flow-id <id>", "ID do flow (default: RUNNER_FLOW_ID/CANGE_CARD_FLOW_ID do ambiente do runner)")
    .option("--card-id <id>", "ID do card (default: RUNNER_CARD_ID do ambiente do runner)")
    .option("--company-id <id>", "ID da company")
    .option(
      "--field-ids <ids>",
      "Filtra summary.fieldValues por IDs de field (lista separada por vírgula)"
    )
    .option("--summary-only", "Legado: hoje o summary já é o default (flag mantida por compatibilidade)")
    .option("--raw", "Inclui a resposta crua da API com vínculos COMPACTADOS (valueCardFlow vira {id_card, title})")
    .option("--raw-full", "Resposta crua INTOCADA (pode passar de 8MB em card com muitos vínculos — evite)")
    .action(
      createCommandAction(async ({ kit }, options: CardGetOptions) => {
        // Defaults do ambiente do runner (flag explícita vence).
        options.flowId = options.flowId ?? envFlowId();
        options.cardId = options.cardId ?? envCardId();
        if (!options.flowId || !options.cardId) {
          throw new CangeCliUsageError(
            "--flow-id e --card-id são obrigatórios (em automação, RUNNER_FLOW_ID/RUNNER_CARD_ID do ambiente são usados como default)."
          );
        }
        const result = await kit.contracts.getCard({
          flowId: options.flowId,
          cardId: options.cardId,
          companyId: options.companyId
        });

        const requestedFieldIds = parseFieldIds(options.fieldIds);
        let summary = result.summary as Record<string, unknown>;
        if (requestedFieldIds.length > 0) {
          const sourceFields =
            (summary.fieldValues as Record<string, unknown>) ??
            (summary.fields as Record<string, unknown>) ??
            {};
          const filteredFieldValues: Record<string, unknown> = {};
          for (const fieldId of requestedFieldIds) {
            filteredFieldValues[fieldId] =
              fieldId in sourceFields ? sourceFields[fieldId] : null;
          }
          summary = { ...summary, fieldValues: filteredFieldValues, fields: filteredFieldValues };
        }

        // Digest (default): só o summary. O raw do GET /card/ chega a 8,3MB num
        // card com 30 vínculos (cada COMBO_BOX_FLOW_FIELD embute o card apontado
        // INTEIRO — 95,7% do payload é isso; medição de 21/08 no card 1079918).
        // O agente que precisar do cru pede --raw (vínculos compactados) ou
        // --raw-full (intocado, escape hatch).
        if (!options.raw && !options.rawFull) {
          return {
            summary,
            ...(requestedFieldIds.length > 0 ? { requestedFieldIds } : {})
          };
        }

        const raw = options.rawFull ? result.raw : stripValueCardFlow(result.raw);
        return {
          raw,
          summary,
          ...(requestedFieldIds.length > 0 ? { requestedFieldIds } : {})
        };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ summary } (default; + requestedFieldIds com --field-ids) — com --raw: { raw, summary } com vínculos compactados; --raw-full: raw intocado",
    fieldsLocation:
      "campos legíveis (title, stepName, fieldValues) vivem em `summary`; `raw` é a resposta crua da API (opt-in)",
    example: "card get --flow-id 192 --card-id 1096611"
  });
}

function parseFieldIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Compacta `valueCardFlow` (e o irmão `valueCardRegister`) na resposta crua:
 * cada vínculo embute o card/entrada apontados INTEIROS (~142KB por vínculo).
 * Aqui viram `{ id_card, title }` — o suficiente pra navegar; quem precisar do
 * conteúdo do vinculado usa `card read --card-ids` nele.
 */
function stripValueCardFlow(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map((item) => stripValueCardFlow(item));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((key === "valueCardFlow" || key === "valueCardRegister") && value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      out[key] = {
        id_card: v.id_card ?? v.id ?? null,
        title: v.title ?? v.name ?? null,
        _compacted: true
      };
      continue;
    }
    out[key] = stripValueCardFlow(value);
  }
  return out;
}
