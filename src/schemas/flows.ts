import { z } from "zod";

export const getFlowParamsSchema = z
  .object({
    idFlow: z.string().regex(/^\d+$/).optional(),
    hash: z.string().trim().min(1).optional()
  })
  .refine((value) => value.idFlow !== undefined || value.hash !== undefined, {
    message: "Informe idFlow ou hash para obter flow."
  });
