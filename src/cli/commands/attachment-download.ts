import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import type { CangeAgentKit } from "../../index.js";
import { cardFilesIndex, collectCardAttachments, parseAttachmentIds, type CardFile } from "../card-attachments.js";
import { resolveRunOutDir } from "../../utils/runFile.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "../resource-ref.js";

interface AttachmentDownloadOptions {
  flowId?: string;
  cardId?: string;
  out?: string;
  attachmentId?: string[];
  from?: string;
}

function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** C2: origem dos arquivos no `--from` (sem acento também vale). */
const FROM_VALUES: Record<string, "campos" | "comentarios" | "todos"> = {
  campos: "campos",
  campo: "campos",
  comentarios: "comentarios",
  "comentários": "comentarios",
  comentario: "comentarios",
  "comentário": "comentarios",
  todos: "todos",
  tudo: "todos"
};

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
      "LEITURA: baixa os anexos de um card (PDF/imagem/etc) para um diretório local (--out) para leitura posterior; sem --out, só lista os anexos + URLs. " +
        "Sem filtro: campos de anexo e aba Anexos. Comentários: --from comentarios (ou todos), ou --attachment-id <id> (ids do `attachment list`)."
    )
    .option("--flow-id <id>", "Flow do card (default: RUNNER_FLOW_ID/CANGE_CARD_FLOW_ID do ambiente do runner)")
    .option("--card-id <id>", "Card cujos anexos serão baixados (default: RUNNER_CARD_ID do ambiente)")
    .option("--out <dir>", "Diretório onde gravar os arquivos. Se omitido, só lista (não baixa).")
    .option(
      "--attachment-id <id>",
      "Só estes anexos do cartão (repetível ou separado por vírgula; os ids saem do `attachment list`)",
      collectRepeatable
    )
    .option("--from <origem>", "campos | comentarios | todos: os arquivos dos campos de anexo, dos comentários ou dos dois")
    .action(
      createCommandAction(async ({ kit }, options: AttachmentDownloadOptions) => {
        // Defaults do ambiente do runner (flag explícita vence).
        options.flowId = options.flowId ?? envFlowId();
        options.cardId = options.cardId ?? envCardId();
        if (!options.cardId) {
          throw new CangeCliUsageError("--card-id é obrigatório (em automação, RUNNER_CARD_ID do ambiente é o default).");
        }
        if (!options.flowId) {
          throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);
        }
        const wantsFiles = typeof options.out === "string" && options.out.trim().length > 0;
        // M3: sob o runner, o --out só vale dentro da pasta do run (conferido antes de ler o cartão).
        const outDir = wantsFiles ? await resolveRunOutDir(options.out!) : undefined;

        // C2 (onda 1): escolha por id ou por origem (campos e comentários). Sem as duas
        // opções, o comportamento de antes (campos de anexo e aba Anexos, numa chamada).
        if ((options.attachmentId && options.attachmentId.length > 0) || options.from !== undefined) {
          return downloadSelected(kit, options, outDir);
        }

        const { files } = await kit.contracts.getCardAttachmentDownloads({
          flowId: options.flowId,
          cardId: options.cardId,
          withBase64: wantsFiles
        });

        // Sem --out: só metadados (nunca o base64).
        if (outDir === undefined) {
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

/** C2: arquivos escolhidos por id (`--attachment-id`) ou origem (`--from`), só os do cartão. */
async function downloadSelected(
  kit: CangeAgentKit,
  options: AttachmentDownloadOptions,
  outDir: string | undefined
): Promise<unknown> {
  let from: "campos" | "comentarios" | "todos" | undefined;
  if (options.from !== undefined) {
    from = FROM_VALUES[options.from.trim().toLowerCase()];
    if (!from) {
      throw new CangeCliUsageError(`--from aceita campos, comentarios ou todos (veio "${options.from}").`);
    }
  }
  const ids = parseAttachmentIds(options.attachmentId);
  if (!Array.isArray(ids)) {
    throw new CangeCliUsageError(`--attachment-id espera o número do anexo (veio "${ids.invalid}").`);
  }

  const cardId = Number(options.cardId);
  const found = await collectCardAttachments(kit, { flowId: Number(options.flowId), cardId });
  const index = cardFilesIndex(found);

  let selected: CardFile[];
  if (ids.length > 0) {
    const missing = ids.filter((id) => !index.has(id));
    if (missing.length > 0) {
      throw new CangeCliUsageError(
        `O anexo ${missing.join(", ")} não está num campo, num comentário nem na aba Anexos do cartão ${cardId}. ` +
          `Veja os ids com \`cange attachment list --card-id ${cardId}\`.`
      );
    }
    selected = ids.map((id) => index.get(id)!.file);
  } else {
    const fromFields = from === "campos" || from === "todos" ? found.fields.flatMap((field) => field.files) : [];
    const fromComments = from === "comentarios" || from === "todos" ? found.comments.flatMap((comment) => comment.files) : [];
    const fromTab = from === "todos" ? found.cardTab : [];
    const seen = new Set<number>();
    selected = [...fromFields, ...fromComments, ...fromTab].filter((file) => !seen.has(file.attachmentId) && seen.add(file.attachmentId));
  }

  if (outDir === undefined) {
    return { cardId, count: selected.length, files: selected };
  }

  await mkdir(outDir, { recursive: true });
  const written: Array<{ attachmentId: number; file_name: string; mime_type?: string; path: string; bytes: number }> = [];
  for (const file of selected) {
    const download = await kit.contracts.getAttachmentDownload({ attachmentId: file.attachmentId, withBase64: true });
    let buffer: Buffer | undefined;
    if (download.base64) {
      buffer = Buffer.from(download.base64, "base64");
    } else if (download.url) {
      const resp = await fetch(download.url);
      if (!resp.ok) {
        throw new CangeValidationError("Falha ao baixar o anexo.", {
          details: { attachmentId: file.attachmentId, status: resp.status }
        });
      }
      buffer = Buffer.from(await resp.arrayBuffer());
    }
    if (!buffer) {
      throw new CangeValidationError("O Cange não devolveu o conteúdo do anexo.", { details: { attachmentId: file.attachmentId } });
    }
    // O id na frente: dois anexos com o mesmo nome não se sobrescrevem.
    const fileName = `${file.attachmentId}-${safeFileName(file.fileName, written.length)}`;
    const path = join(outDir, fileName);
    await writeFile(path, buffer);
    written.push({ attachmentId: file.attachmentId, file_name: fileName, mime_type: file.mimeType, path, bytes: buffer.length });
  }
  return { cardId, outDir, count: written.length, files: written };
}
