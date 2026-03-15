import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCardCommentPayloadSchema } from "../../schemas/comments.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CommentCreateOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardCommentCreateCommand(commentCommand: Command): void {
  commentCommand
    .command("create")
    .description("MUTAÇÃO: cria comentário em um card")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: CommentCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createCardCommentPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para comment create.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.createCardComment(parsed.data);
      })
    );
}
