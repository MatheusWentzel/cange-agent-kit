import { z } from "zod";

import { idLikeSchema } from "./common.js";

export const publishArtifactInputSchema = z.object({
  cardId: z.number().int().positive(),
  type: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(255),
  html: z.string().min(1),
  accent: z.string().trim().max(24).optional(),
  density: z.string().trim().max(16).optional(),
  variant: z.string().trim().max(24).optional(),
  public: z.boolean().optional()
});

export const listArtifactsByCardParamsSchema = z.object({
  cardId: idLikeSchema
});
