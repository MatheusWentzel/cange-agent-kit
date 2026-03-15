import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { readNotificationPayloadSchema } from "../../schemas/notifications.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface NotificationReadOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerNotificationReadCommand(notificationCommand: Command): void {
  notificationCommand
    .command("read")
    .description("MUTAÇÃO: marca notificação como lida/arquivada")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: NotificationReadOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = readNotificationPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para notification read.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.readNotification(parsed.data);
      })
    );
}
