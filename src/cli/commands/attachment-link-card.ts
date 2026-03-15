import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { linkAttachmentPayloadSchema } from "../../schemas/attachments.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface AttachmentLinkCardOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerAttachmentLinkCardCommand(attachmentCommand: Command): void {
  attachmentCommand
    .command("link-card")
    .description("MUTAÇÃO: vincula attachment em card")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentLinkCardOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = linkAttachmentPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para attachment link-card.", {
            details: parsed.error.format()
          });
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.linkAttachmentToCard(parsed.data);
      })
    );
}
