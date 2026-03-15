import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { readNotificationPayloadSchema } from "../schemas/notifications.js";

import { summarizeNotification } from "./raw-adapters.js";
import type { NotificationSummary } from "./types.js";

export interface NotificationsContracts {
  readNotification: (input: {
    notificationId: number;
    archived?: "S" | "N";
  }) => Promise<{ raw: unknown; summary: NotificationSummary }>;
}

export function createNotificationsContracts(client: CangeClient): NotificationsContracts {
  return {
    async readNotification(input) {
      const parsed = readNotificationPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para readNotification.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/notification", {
        body: {
          id_notification: parsed.data.notificationId,
          archived: parsed.data.archived
        }
      });

      const summary = summarizeNotification(raw);

      return {
        raw,
        summary: {
          ...summary,
          id: summary.id ?? parsed.data.notificationId,
          archived: summary.archived ?? (parsed.data.archived === "S")
        }
      };
    }
  };
}
