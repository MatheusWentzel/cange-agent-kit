import { z } from "zod";

export const getNotificationsByUserParamsSchema = z.object({
  isArchived: z.enum(["S", "N"]).default("N")
});
