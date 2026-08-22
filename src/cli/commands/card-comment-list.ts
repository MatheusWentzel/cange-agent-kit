import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CommentListOptions {
  flowId?: string;
  cardId: string;
  summaryOnly?: boolean;
  full?: boolean;
}

/**
 * Cap do texto de cada comentário no modo digest (default). Comentários com
 * transcrições de reunião inteiras (77–107KB CADA, caso real do card 1079918)
 * estouravam o contexto do agente: o envelope antigo imprimia raw + summaries
 * (o MESMO texto 2×, 550KB no total). Digest = só summaries, texto capado.
 */
const DIGEST_DESCRIPTION_CAP = 800;

export function registerCardCommentListCommand(commentCommand: Command): void {
  const command = commentCommand
    .command("list")
    .description("Lista comentários de um card por flow_id + card_id (digest por padrão; --full para o texto completo)")
    .option(
      "--flow-id <id>",
      "ID do flow (opcional). Se omitido, usa CANGE_CARD_FLOW_ID do ambiente (o runner injeta o flow do card)."
    )
    .requiredOption("--card-id <id>", "ID do card")
    .option("--summary-only", "Legado: hoje o digest já é o default (flag mantida por compatibilidade)")
    .option("--full", "Retorna raw + summaries com texto COMPLETO (pesado — só quando precisar do teor inteiro)")
    .action(
      createCommandAction(async ({ kit }, options: CommentListOptions) => {
        const result = await kit.contracts.listCommentsByCard({
          flowId: options.flowId,
          cardId: options.cardId
        });

        if (options.full) {
          return result;
        }

        // Digest (default): só summaries, texto capado. O marcador diz como
        // obter o inteiro — o agente decide se precisa, sem re-descobrir.
        const summaries = result.summaries.map((s) => {
          const description = typeof s.description === "string" ? s.description : "";
          if (description.length <= DIGEST_DESCRIPTION_CAP) return s;
          return {
            ...s,
            description:
              description.slice(0, DIGEST_DESCRIPTION_CAP) +
              ` […truncado ${description.length - DIGEST_DESCRIPTION_CAP} chars — use --full p/ o texto completo]`
          };
        });

        return { summaries, total: result.total };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ summaries[], total } (digest, texto capado em 800 chars) — com --full: { raw, summaries[], total } completos",
    fieldsLocation:
      "comentários legíveis (author, text, createdAt) vivem em `summaries[]`, ordenados newest-first",
    example: "comment list --card-id 1096611"
  });
}
