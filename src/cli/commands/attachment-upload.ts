import type { Command } from "commander";

import { mimeTypeOf } from "../../utils/attachFieldTypes.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { ATTACHMENT_UPLOAD_MAX_BYTES, resolveRunFile } from "../../utils/runFile.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface AttachmentUploadOptions {
  file: string;
  dryRun?: boolean;
}

/**
 * `cange attachment upload --file <arquivo>`: sobe o arquivo para o Cange e devolve o
 * `attachmentId`. O arquivo ainda NÃO aparece para ninguém: ele entra no cartão no passo
 * seguinte, num comentário (`comment create --attachment-id`) ou num campo de anexo
 * (`attachment link-field`). É nesse passo que a permissão "Anexos" e a aprovação valem.
 *
 * C2 (onda 1): o arquivo vem só da pasta desta execução (`resolveRunFile`: sem `..`, sem
 * link para fora, até 25 MB), vai com o tipo pela extensão (a tela mostra a prévia de PDF
 * e imagem pelo tipo) e `--dry-run` confere tudo sem subir.
 */
export function registerAttachmentUploadCommand(attachmentCommand: Command): void {
  const command = attachmentCommand
    .command("upload")
    .description(
      "MUTAÇÃO: sobe um arquivo da pasta desta execução e devolve o attachmentId (o arquivo só aparece no cartão depois de " +
        "`comment create --attachment-id` ou `attachment link-field`)"
    )
    .requiredOption("--file <path>", "Caminho completo do arquivo, na pasta desta execução")
    .option("--dry-run", "Confere o arquivo (pasta, tamanho, tipo) sem subir")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentUploadOptions) => {
        const file = await resolveRunFile(options.file);
        const mimeType = mimeTypeOf(file.fileName);
        const described = {
          fileName: file.fileName,
          bytes: file.bytes,
          mimeType
        };
        if (options.dryRun) {
          return createDryRunResult(described);
        }

        const { raw } = await kit.contracts.uploadAttachment({
          filePath: file.realPath,
          fileName: file.fileName,
          mimeType
        });
        const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const attachmentId = record.id_attachment;
        return {
          ok: true,
          attachmentId,
          ...described,
          note: "O arquivo ainda não aparece para ninguém: ponha num comentário ou num campo de anexo do cartão.",
          next: [
            `cange comment create --card-id <id> --text "<texto>" --attachment-id ${String(attachmentId)}`,
            `cange attachment link-field --card-id <id> --field "<campo de anexo>" --attachment-id ${String(attachmentId)}`
          ]
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ ok, attachmentId, fileName, bytes, mimeType, note, next[] }. --dry-run: { dryRun, executed:false, payload }",
    fieldsLocation:
      `Arquivo só da pasta desta execução (TMPDIR do run), sem "..", sem link para fora, até ${ATTACHMENT_UPLOAD_MAX_BYTES / (1024 * 1024)} MB. ` +
      "Depois: `comment create --attachment-id` (comentário com o arquivo) ou `attachment link-field` (campo de anexo).",
    example: "attachment upload --file /tmp/run-1/tmp/proposta.pdf"
  });
}
