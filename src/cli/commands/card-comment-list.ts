import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface CommentListOptions {
  flowId: string;
  cardId: string;
  summaryOnly?: boolean;
}

export function registerCardCommentListCommand(commentCommand: Command): void {
  commentCommand
    .command("list")
    .description("Lista comentários de um card por flow_id + card_id")
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--card-id <id>", "ID do card")
    .option("--summary-only", "Retorna somente summaries (sem raw)")
    .action(
      createCommandAction(async ({ kit }, options: CommentListOptions) => {
        const result = await kit.contracts.listCommentsByCard({
          flowId: options.flowId,
          cardId: options.cardId
        });

        if (options.summaryOnly) {
          return {
            summaries: result.summaries,
            total: result.total
          };
        }

        return result;
      })
    );
}
