import { z } from "zod";

const notificationIdInputSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform((value) => (typeof value === "number" ? value : Number.parseInt(value, 10)));

const rawReadNotificationPayloadSchema = z
  .object({
    notificationId: notificationIdInputSchema.optional(),
    idNotification: notificationIdInputSchema.optional(),
    id_notification: notificationIdInputSchema.optional(),
    archived: z.enum(["S", "N"]).default("S")
  })
  .refine(
    (value) =>
      value.notificationId !== undefined ||
      value.idNotification !== undefined ||
      value.id_notification !== undefined,
    {
      message: "Informe notificationId (ou idNotification/id_notification)."
    }
  );

export const readNotificationPayloadSchema = rawReadNotificationPayloadSchema.transform((value) => ({
  notificationId: value.notificationId ?? value.idNotification ?? value.id_notification!,
  archived: value.archived
}));
