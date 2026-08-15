import { z } from "zod";

import { idLikeSchema } from "./common.js";

export const uploadAttachmentInputSchema = z.object({
  filePath: z.string().trim().min(1)
});

export const linkAttachmentPayloadSchema = z.object({
  attachmentId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  flowId: z.number().int().positive()
});

// Leitura dos anexos de um card (INPUT_ATTACH_FIELD + card_attachment). `flowId`
// é exigido pelo back para validar o acesso ao fluxo. `withBase64` traz os bytes
// do arquivo embutidos (o back baixa o blob e codifica) — usado quando se quer
// gravar o arquivo em disco sem uma 2ª requisição ao Azure.
export const downloadAttachmentsByCardParamsSchema = z.object({
  flowId: idLikeSchema,
  cardId: idLikeSchema,
  withBase64: z.boolean().optional()
});
