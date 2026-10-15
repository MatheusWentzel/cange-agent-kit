import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { collectCardAttachments } from "../card-attachments.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "../resource-ref.js";

interface AttachmentListOptions {
  cardId?: string;
  flowId?: string;
}

/**
 * C2 (onda 1): `cange attachment list --card-id <id>`, LEITURA. Os arquivos do cartão nos
 * campos de anexo (com os tipos que cada campo aceita) e nos comentários, cada um com o
 * `attachmentId` que o `attachment download --attachment-id` baixa e que o
 * `comment create --attachment-id` e o `attachment link-field` usam.
 */
export function registerAttachmentListCommand(attachmentCommand: Command): void {
  const command = attachmentCommand
    .command("list")
    .description(
      "LEITURA: lista os arquivos do cartão nos campos de anexo e nos comentários, com o attachmentId de cada um"
    )
    .option("--card-id <id>", "Cartão (número ou link; padrão: o cartão do run)")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link, do número do cartão ou do run)")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentListOptions) => {
        const cardId = options.cardId ?? envCardId();
        if (!cardId) {
          throw new CangeCliUsageError("Informe o cartão: `cange attachment list --card-id <id>`.");
        }
        const flowId = options.flowId ?? envFlowId();
        if (!flowId) throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);

        const found = await collectCardAttachments(kit, { flowId: Number(flowId), cardId: Number(cardId) });
        const total =
          found.fields.reduce((sum, field) => sum + field.files.length, 0) +
          found.comments.reduce((sum, comment) => sum + comment.files.length, 0);
        return {
          cardId: found.cardId,
          flowId: found.flowId,
          total,
          fields: found.fields,
          comments: found.comments,
          next:
            total > 0
              ? `cange attachment download --card-id ${found.cardId} --attachment-id <id> --out <pasta>`
              : undefined
        };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ cardId, flowId, total, fields[{fieldId, title, allowedTypes?, files[{attachmentId, fileName, mimeType, sizeKb}]}], " +
      "comments[{commentId, author, createdAt, files[...]}], next? }",
    fieldsLocation:
      "Campo de anexo sem arquivo também aparece (o título e os tipos aceitos servem para o `attachment link-field`). " +
      "Comentário só aparece quando tem arquivo.",
    example: "attachment list --card-id 1234"
  });
}
