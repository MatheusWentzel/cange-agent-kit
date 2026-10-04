import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import type { CommentSummary } from "../../contracts/comments.js";
import { dropEmpty, htmlToMarkdown } from "../../utils/lean.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CommentListOptions {
  flowId?: string;
  cardId: string;
  summaryOnly?: boolean;
  full?: boolean;
  limit?: string;
}

/**
 * Cap do texto de cada comentário no modo digest (default). Comentários com
 * transcrições de reunião inteiras (77–107KB CADA, caso real do card 1079918)
 * estouravam o contexto do agente: o envelope antigo imprimia raw + summaries
 * (o MESMO texto 2×, 550KB no total). Digest = só summaries, texto capado.
 */
const DIGEST_DESCRIPTION_CAP = 800;

/**
 * Rodada 5 (saída enxuta, padrão): quantos comentários vêm sem `--limit`. O run
 * 153 leu 24 comentários (9K tokens), inclusive os relatórios anteriores da própria
 * agente. Os mais recentes bastam para o caso comum; `total` diz quantos existem.
 */
export const LEAN_COMMENTS_DEFAULT_LIMIT = 15;

function capDescription(description: string): string {
  if (description.length <= DIGEST_DESCRIPTION_CAP) return description;
  return (
    description.slice(0, DIGEST_DESCRIPTION_CAP) +
    ` […truncado ${description.length - DIGEST_DESCRIPTION_CAP} chars — use --full p/ o texto completo]`
  );
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CangeCliUsageError("Valor inválido para --limit. Use inteiro positivo.");
  }
  return n;
}

/** Mais recente primeiro (pela data de criação, quando todos têm). */
function newestFirst(summaries: CommentSummary[]): CommentSummary[] {
  if (summaries.some((s) => !s.dtCreated)) return summaries;
  return [...summaries].sort((a, b) => String(b.dtCreated).localeCompare(String(a.dtCreated)));
}

export function registerCardCommentListCommand(commentCommand: Command): void {
  const command = commentCommand
    .command("list")
    .description(
      "Lista comentários de um card por flow_id + card_id (enxuto: os 15 mais recentes em markdown; --limit para mais; --full para o texto completo)"
    )
    .option(
      "--flow-id <id>",
      "ID do flow (opcional). Se omitido, usa CANGE_CARD_FLOW_ID do ambiente (o runner injeta o flow do card)."
    )
    .requiredOption("--card-id <id>", "ID do card")
    .option("--summary-only", "Legado: hoje o digest já é o default (flag mantida por compatibilidade)")
    .option("--full", "Retorna raw + summaries com texto COMPLETO (pesado — só quando precisar do teor inteiro)")
    .option("--limit <n>", `Quantos comentários (mais recentes primeiro). Padrão no formato enxuto: ${LEAN_COMMENTS_DEFAULT_LIMIT}`)
    .action(
      createCommandAction(async ({ kit, profile }, options: CommentListOptions) => {
        const limit = parseLimit(options.limit);
        const result = await kit.contracts.listCommentsByCard({
          flowId: options.flowId,
          cardId: options.cardId
        });

        if (options.full) {
          return result;
        }

        if (profile === "full") {
          // Digest de antes: só summaries, texto capado. O marcador diz como obter
          // o inteiro: o agente decide se precisa, sem re-descobrir.
          const summaries = result.summaries.map((s) => {
            const description = typeof s.description === "string" ? s.description : "";
            if (description.length <= DIGEST_DESCRIPTION_CAP) return s;
            return { ...s, description: capDescription(description) };
          });
          return { summaries: limit !== undefined ? summaries.slice(0, limit) : summaries, total: result.total };
        }

        // Enxuto (rodada 5): mais recentes primeiro, HTML vira markdown (links
        // preservados) antes do corte, sem cardId/userId repetidos em todo item, sem
        // a data formatada duplicada e sem `fixed:false`/`attachmentsCount:0`.
        const ordered = newestFirst(result.summaries);
        const take = limit ?? LEAN_COMMENTS_DEFAULT_LIMIT;
        const shown = ordered.slice(0, take).map((s) => ({
          id: s.id,
          userName: s.userName,
          dtCreated: s.dtCreated,
          description: capDescription(htmlToMarkdown(typeof s.description === "string" ? s.description : "")),
          ...(s.fixed ? { fixed: true } : {}),
          ...(s.attachmentsCount > 0 ? { attachmentsCount: s.attachmentsCount } : {})
        }));
        return dropEmpty({
          total: result.total,
          shown: shown.length,
          ...(shown.length < result.total
            ? { more: `mostrando os ${shown.length} mais recentes de ${result.total}; use --limit ${result.total} para ver todos` }
            : {}),
          summaries: shown
        });
      })
    );

  annotateCommand(command, {
    envelope:
      "Enxuto (padrão): { total, shown, more?, summaries[{id, userName, dtCreated, description (markdown, capado em 800), fixed?, attachmentsCount?}] }, os 15 mais recentes (--limit N). " +
      "Com CANGE_OUTPUT_PROFILE=full: { summaries[], total } (digest de antes); com --full: { raw, summaries[], total } completos",
    fieldsLocation:
      "comentários legíveis (userName, description, dtCreated) vivem em `summaries[]`, ordenados newest-first",
    example: "comment list --card-id 1096611"
  });
}
