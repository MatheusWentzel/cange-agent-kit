import { z } from "zod";

export const createCardCommentPayloadSchema = z.object({
  cardId: z.number().int().positive(),
  flowId: z.number().int().positive(),
  description: z.string().trim().min(1),
  mentions: z.array(z.number().int().positive()).default([])
});
