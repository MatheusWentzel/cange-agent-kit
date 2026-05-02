import { z } from "zod";

import { idLikeSchema } from "./common.js";

export const createCardCommentPayloadSchema = z.object({
  cardId: z.number().int().positive(),
  flowId: z.number().int().positive(),
  description: z.string().trim().min(1),
  mentions: z.array(z.number().int().positive()).default([])
});

export const listCommentsByCardParamsSchema = z.object({
  flowId: idLikeSchema,
  cardId: idLikeSchema
});
