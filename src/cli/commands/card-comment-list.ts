import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface CommentListOptions {
  flowId: string;
  cardId: string;
  summaryOnly?: boolean;
}

export function registerCardCommentListCommand(commentCommand: Command): void {
  const command = commentCommand
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

  annotateCommand(command, {
    envelope: "{ raw, summaries[], total } (só { summaries, total } com --summary-only)",
    fieldsLocation:
      "comentários legíveis (author, text, createdAt) vivem em `summaries[]`, ordenados newest-first",
    example: "comment list --flow-id 192 --card-id 1096611 --summary-only"
  });
}
