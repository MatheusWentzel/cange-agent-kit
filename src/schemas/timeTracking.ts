import { z } from "zod";

export const createTimeTrackingPayloadSchema = z.object({
  flowId: z.number().int().positive().optional(),
  cardId: z.number().int().positive().optional(),
  flowStepId: z.number().int().positive().optional(),
  source: z.string().min(1),
  dtStart: z.string().min(1),
  dtEnd: z.string().min(1),
  duration: z.number().int().nonnegative(),
  billable: z.enum(["S", "N"]),
  title: z.string().optional(),
  description: z.string().optional()
});

export type CreateTimeTrackingPayload = z.infer<typeof createTimeTrackingPayloadSchema>;
