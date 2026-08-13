import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  downloadAttachmentsByCardParamsSchema,
  linkAttachmentPayloadSchema,
  uploadAttachmentInputSchema
} from "../schemas/attachments.js";

/** Um anexo de card, como o back devolve em GET /attachment/url-download/by-card. */
export interface CardAttachmentFile {
  /** URL SAS de leitura (TTL curto) do blob no Azure. */
  url: string;
  file_name: string;
  mime_type: string;
  /** Bytes do arquivo em base64 (só quando withBase64=true). */
  base64?: string;
}

export interface AttachmentsContracts {
  uploadAttachment: (input: { filePath: string }) => Promise<{ raw: unknown }>;
  linkAttachmentToCard: (input: {
    attachmentId: number;
    flowId: number;
    cardId: number;
  }) => Promise<{ raw: unknown }>;
  getCardAttachmentDownloads: (input: {
    flowId: number | string;
    cardId: number | string;
    withBase64?: boolean;
  }) => Promise<{ raw: unknown; files: CardAttachmentFile[] }>;
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
      const file = new Blob([new Uint8Array(fileBuffer)]);
      const formData = new FormData();
      formData.append("file", file, fileName);

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
    },

    async getCardAttachmentDownloads(input) {
      const parsed = downloadAttachmentsByCardParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getCardAttachmentDownloads.", {
          details: parsed.error.format()
        });
      }

      // LEITURA (GET) — sempre permitida ao token de run. O back valida o acesso
      // ao fluxo (SelectFlowService) e devolve os anexos do card (form fields +
      // card_attachment), com URL SAS de leitura e, opcionalmente, o base64.
      const raw = await client.get<unknown>("/attachment/url-download/by-card", {
        query: {
          card_id: String(parsed.data.cardId),
          flow_id: String(parsed.data.flowId),
          // O back compara com a STRING 'true'; buildUrl serializa via String().
          ...(parsed.data.withBase64 ? { withBase64: "true" } : {})
        }
      });

      const files = Array.isArray(raw) ? (raw as CardAttachmentFile[]) : [];
      return { raw, files };
    }
  };
}
