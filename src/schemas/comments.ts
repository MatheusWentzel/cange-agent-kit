import { z } from "zod";

import { idLikeSchema } from "./common.js";

export const createCardCommentPayloadSchema = z.object({
  cardId: z.number().int().positive(),
  // flowId é OPCIONAL: quando ausente, o contrato resolve de CANGE_CARD_FLOW_ID (o runner
  // injeta o flow do card). O back exige que o flow_id bata com o fluxo do card, então o
  // agente não precisa saber/adivinhar o fluxo — evita o 404 por flow_id errado.
  flowId: z.number().int().positive().optional(),
  description: z.string().trim().min(1),
  mentions: z.array(z.number().int().positive()).default([])
});

export const listCommentsByCardParamsSchema = z.object({
  flowId: idLikeSchema.optional(),
  cardId: idLikeSchema
});
