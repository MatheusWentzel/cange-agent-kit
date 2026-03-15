import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface AttachmentUploadOptions {
  file: string;
}

export function registerAttachmentUploadCommand(attachmentCommand: Command): void {
  attachmentCommand
    .command("upload")
    .description("MUTAÇÃO: envia arquivo para /attachment")
    .requiredOption("--file <path>", "Caminho do arquivo")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentUploadOptions) => {
        return kit.contracts.uploadAttachment({
          filePath: options.file
        });
      })
    );
}
