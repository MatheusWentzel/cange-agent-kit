import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { linkAttachmentPayloadSchema, uploadAttachmentInputSchema } from "../schemas/attachments.js";

export interface AttachmentsContracts {
  uploadAttachment: (input: { filePath: string }) => Promise<{ raw: unknown }>;
  linkAttachmentToCard: (input: {
    attachmentId: number;
    flowId: number;
    cardId: number;
  }) => Promise<{ raw: unknown }>;
}

export function createAttachmentsContracts(client: CangeClient): AttachmentsContracts {
  return {
    async uploadAttachment(input) {
      const parsed = uploadAttachmentInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetro inválido para uploadAttachment.", {
          details: parsed.error.format()
        });
      }

      let fileBuffer: Buffer;
      try {
        fileBuffer = await readFile(parsed.data.filePath);
      } catch (error) {
        throw new CangeValidationError("Não foi possível ler o arquivo para upload.", {
          details: { filePath: parsed.data.filePath },
          cause: error
        });
      }

      const fileName = basename(parsed.data.filePath);
      const file = new File([new Uint8Array(fileBuffer)], fileName);
      const formData = new FormData();
      formData.append("file", file);

      const raw = await client.post<unknown>("/attachment", {
        body: formData,
        contentType: "multipart",
        retry: false
      });
      return { raw };
    },

    async linkAttachmentToCard(input) {
      const parsed = linkAttachmentPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para linkAttachmentToCard.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/attachment/card", {
        body: {
          attachment_id: parsed.data.attachmentId,
          card_id: parsed.data.cardId,
          flow_id: parsed.data.flowId
        }
      });
      return { raw };
    }
  };
}
