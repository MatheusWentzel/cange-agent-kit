import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface NotificationsOptions {
  isArchived?: string;
}

export function registerNotificationsCommand(program: Command): void {
  program
    .command("notifications")
    .description("Lista notificações do usuário autenticado")
    .option("--is-archived <S|N>", "Filtra notificações arquivadas (S) ou ativas (N)", "N")
    .action(
      createCommandAction(async ({ kit }, options: NotificationsOptions) => {
        const isArchived = normalizeArchivedParam(options.isArchived);
        const result = await kit.contracts.getNotificationsByUser({
          isArchived
        });
        return {
          raw: result.raw,
          summaries: result.summaries,
          total: result.summaries.length,
          isArchived
        };
      })
    );
}

function normalizeArchivedParam(value: string | undefined): "S" | "N" {
  const normalized = (value ?? "N").trim().toUpperCase();
  if (normalized === "S" || normalized === "N") {
    return normalized;
  }

  throw new CangeCliUsageError("Valor inválido para --is-archived. Use S ou N.");
}
