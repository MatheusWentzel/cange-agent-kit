import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createTimeTrackingPayloadSchema } from "../../schemas/timeTracking.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface TimeTrackingCreateOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerTimeTrackingCreateCommand(timeTrackingCommand: Command): void {
  timeTrackingCommand
    .command("create")
    .description("MUTAÇÃO: cria registro de time tracking (necessário em etapas com isRequiredTrack)")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: TimeTrackingCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createTimeTrackingPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para time-tracking create.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.createTimeTracking(parsed.data);
      })
    );
}
