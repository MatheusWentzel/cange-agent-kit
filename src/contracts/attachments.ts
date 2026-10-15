import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { CangeApiError, CangeValidationError } from "../client/errors.js";
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

/** Um anexo como o back devolve em `POST /attachment/batch` (empresa do token). */
export interface AttachmentRecord {
  id_attachment: number;
  original_name?: string;
  mime_type?: string;
  /** Tamanho em KB (o back grava `blob_size` em KB). */
  blob_size?: number;
  user_id?: number;
}

export interface AttachmentsContracts {
  /**
   * Sobe o arquivo (`POST /attachment`, multipart). C2: `fileName` e `mimeType` opcionais
   * (o nome que aparece no Cange e o tipo que a tela usa na prévia).
   */
  uploadAttachment: (input: { filePath: string; fileName?: string; mimeType?: string }) => Promise<{ raw: unknown }>;
  /** C2: anexos por id, numa chamada (`POST /attachment/batch`, leitura; só os da empresa). */
  getAttachmentsByIds: (input: { ids: number[] }) => Promise<{ raw: unknown; attachments: AttachmentRecord[] }>;
  /**
   * C2: um anexo para baixar (`GET /attachment/url-download`): URL de leitura e, com
   * `withBase64`, os bytes. 404 = não existe na empresa.
   */
  getAttachmentDownload: (input: { attachmentId: number; withBase64?: boolean }) => Promise<CardAttachmentFile>;
  /**
   * M4 (onda 1): os arquivos da aba Anexos do cartão (`card_attachment`, o que o
   * `attachment link-card` põe), `GET /attachment/by-card`. 404 = rota ausente: lista vazia.
   */
  getCardTabAttachments: (input: { flowId: number | string; cardId: number | string }) => Promise<{ raw: unknown; attachments: AttachmentRecord[] }>;
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
  /**
   * POP-1 (revisão 4 do EXTRA-06): o anexo como o campo de anexo da tela o carrega
   * (`GET /attachment?id_attachment=`). 404 = não existe na empresa (a tela não mostra).
   */
  getAttachment: (input: { attachmentId: number | string }) => Promise<{ raw: unknown }>;
}

export function createAttachmentsContracts(client: CangeClient): AttachmentsContracts {
  return {
    async getAttachment(input) {
      const raw = await client.get<unknown>("/attachment", { query: { id_attachment: Number(input.attachmentId) } });
      return { raw };
    },

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

      const fileName = input.fileName?.trim() || basename(parsed.data.filePath);
      const file = new Blob([new Uint8Array(fileBuffer)], input.mimeType ? { type: input.mimeType } : undefined);
      const formData = new FormData();
      formData.append("file", file, fileName);

      const raw = await client.post<unknown>("/attachment", {
        body: formData,
        contentType: "multipart",
        retry: false
      });
      return { raw };
    },

    async getAttachmentsByIds(input) {
      const ids = Array.from(new Set(input.ids.filter((id) => Number.isInteger(id) && id > 0)));
      if (ids.length === 0) return { raw: [], attachments: [] };
      const raw = await client.post<unknown>("/attachment/batch", { body: { ids } });
      const attachments = (Array.isArray(raw) ? raw : []).filter(
        (item): item is AttachmentRecord =>
          !!item && typeof item === "object" && Number.isInteger((item as AttachmentRecord).id_attachment)
      );
      return { raw, attachments };
    },

    async getAttachmentDownload(input) {
      const raw = await client.get<unknown>("/attachment/url-download", {
        query: {
          id_attachment: Number(input.attachmentId),
          ...(input.withBase64 ? { withBase64: "true" } : {})
        }
      });
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        url: typeof record.url === "string" ? record.url : "",
        file_name: typeof record.file_name === "string" ? record.file_name : "",
        mime_type: typeof record.mime_type === "string" ? record.mime_type : "",
        ...(typeof record.base64 === "string" ? { base64: record.base64 } : {})
      };
    },

    async getCardTabAttachments(input) {
      const cardId = Number(String(input.cardId).trim());
      const flowId = Number(String(input.flowId).trim());
      if (!Number.isInteger(cardId) || cardId <= 0 || !Number.isInteger(flowId) || flowId <= 0) {
        throw new CangeValidationError("Parâmetros inválidos para getCardTabAttachments.", { details: input });
      }
      let raw: unknown;
      try {
        raw = await client.get<unknown>("/attachment/by-card", { query: { id_card: cardId, flow_id: flowId } });
      } catch (error) {
        if (error instanceof CangeApiError && error.status === 404) return { raw: [], attachments: [] };
        throw error;
      }
      const attachments = (Array.isArray(raw) ? raw : []).filter(
        (item): item is AttachmentRecord =>
          !!item && typeof item === "object" && Number.isInteger((item as AttachmentRecord).id_attachment)
      );
      return { raw, attachments };
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
