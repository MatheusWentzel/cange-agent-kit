import { z } from "zod";

export const uploadAttachmentInputSchema = z.object({
  filePath: z.string().trim().min(1)
});

export const linkAttachmentPayloadSchema = z.object({
  attachmentId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  flowId: z.number().int().positive()
});
