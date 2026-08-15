import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface AttachmentDownloadOptions {
  flowId: string;
  cardId: string;
  out?: string;
}

/** Sanitiza o nome do arquivo para gravar em disco (sem path traversal). */
function safeFileName(name: string, index: number): string {
  const cleaned = basename(String(name || "")).replace(/[^\w.\- ]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned : `anexo-${index + 1}`;
}

/**
 * `cange attachment download` — baixa os anexos de UM card (PDF/imagem/qualquer)
 * para um diretório local, para o agente-LLM depois LER os arquivos (Read).
 *
 * Sem `--out`: devolve só os METADADOS (file_name, mime_type, url SAS) — não
 * baixa nada (útil para inspecionar antes). Com `--out`: grava cada arquivo em
 * `<out>/<file_name>` e devolve `{ file_name, mime_type, path, bytes }[]` — o
 * base64 NUNCA vai no output (inundaria o contexto do agente).
 *
 * Estratégia de bytes: pede `withBase64=true` (uma requisição autenticada ao
 * Cange resolve tudo, sem depender de rede direta ao Azure) e decodifica; se o
 * base64 vier ausente, cai para um GET na URL SAS.
 */
export function registerAttachmentDownloadCommand(attachmentCommand: Command): void {
  attachmentCommand
    .command("download")
    .description(
      "LEITURA: baixa os anexos de um card (PDF/imagem/etc) para um diretório local (--out) para leitura posterior; sem --out, só lista os anexos + URLs."
    )
    .requiredOption("--flow-id <id>", "Flow do card (o back valida o acesso ao fluxo)")
    .requiredOption("--card-id <id>", "Card cujos anexos serão baixados")
    .option("--out <dir>", "Diretório onde gravar os arquivos. Se omitido, só lista (não baixa).")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentDownloadOptions) => {
        const wantsFiles = typeof options.out === "string" && options.out.trim().length > 0;

        const { files } = await kit.contracts.getCardAttachmentDownloads({
          flowId: options.flowId,
          cardId: options.cardId,
          withBase64: wantsFiles
        });

        // Sem --out: só metadados (nunca o base64).
        if (!wantsFiles) {
          return {
            cardId: Number(options.cardId),
            count: files.length,
            files: files.map((f) => ({
              file_name: f.file_name,
              mime_type: f.mime_type,
              url: f.url
            }))
          };
        }

        const outDir = options.out!.trim();
        await mkdir(outDir, { recursive: true });

        const written = [];
        for (const [i, file] of files.entries()) {
          const fileName = safeFileName(file.file_name, i);
          const path = join(outDir, fileName);

          let buffer: Buffer | undefined;
          if (typeof file.base64 === "string" && file.base64.length > 0) {
            buffer = Buffer.from(file.base64, "base64");
          } else if (typeof file.url === "string" && file.url.length > 0) {
            // Fallback: base64 ausente → busca os bytes na URL SAS diretamente.
            const resp = await fetch(file.url);
            if (!resp.ok) {
              throw new CangeValidationError("Falha ao baixar anexo pela URL SAS.", {
                details: { file_name: file.file_name, status: resp.status }
              });
            }
            buffer = Buffer.from(await resp.arrayBuffer());
          }

          if (!buffer) {
            throw new CangeValidationError("Anexo sem base64 nem URL utilizável.", {
              details: { file_name: file.file_name }
            });
          }

          await writeFile(path, buffer);
          written.push({
            file_name: fileName,
            mime_type: file.mime_type,
            path,
            bytes: buffer.length
          });
        }

        return {
          cardId: Number(options.cardId),
          outDir,
          count: written.length,
          files: written
        };
      })
    );
}
