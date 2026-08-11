import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCardCommentPayloadSchema } from "../../schemas/comments.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CommentCreateOptions {
  payload: string;
  flowId?: string;
  dryRun?: boolean;
}

export function registerCardCommentCreateCommand(commentCommand: Command): void {
  commentCommand
    .command("create")
    .description("MUTAÇÃO: cria comentário em um card")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option(
      "--flow-id <id>",
      "ID do flow do card (opcional). Precedência: --flow-id > flowId no payload > CANGE_CARD_FLOW_ID do ambiente. Deixe em branco quando rodando pelo runner (ele injeta o flow do card)."
    )
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

        // --flow-id explícito vence o flowId do payload; se nenhum vier, o contrato resolve
        // de CANGE_CARD_FLOW_ID (injetado pelo runner). Não precisa saber o fluxo no payload.
        const input = {
          ...parsed.data,
          ...(options.flowId ? { flowId: Number(options.flowId) } : {})
        };

        if (options.dryRun) {
          return createDryRunResult(input);
        }

        return kit.contracts.createCardComment(input);
      })
    );
}
