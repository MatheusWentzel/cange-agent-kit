import { z } from "zod";
import { idLikeSchema } from "./common.js";

export const getNotificationsByUserParamsSchema = z.object({
  isArchived: z.enum(["S", "N"]).default("N")
});

export const getMyTasksParamsSchema = z.object({
  flowId: idLikeSchema.optional(),
  stepId: idLikeSchema.optional()
});
