import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { collectCardAttachments } from "../card-attachments.js";
import { askWhichFile, cardFileRefs, matchCardFiles } from "../card-file-match.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "../resource-ref.js";

interface AttachmentListOptions {
  cardId?: string;
  flowId?: string;
  name?: string;
}

/**
 * C2 (onda 1): `cange attachment list --card-id <id>`, LEITURA. Os arquivos do cartão nos
 * campos de anexo (com os tipos que cada campo aceita) e nos comentários, cada um com o
 * `attachmentId` que o `attachment download --attachment-id` baixa e que o
 * `comment create --attachment-id` e o `attachment link-field` usam.
 *
 * Onda 1b (item 6): `files` junta tudo numa lista só, cada arquivo com a origem (`source`:
 * campo, colaboração ou aba Anexos) e o `where` em português; `--name` acha o arquivo que
 * a pessoa citou nos dois lugares. Quando não dá para saber qual é (mais de um candidato,
 * ou nenhum com o nome dito), `ask` traz a pergunta pronta para a pessoa.
 *
 * Onda 1i (revisão do Alex): `ask` só com `--name`. Sem nome é listagem: automação e
 * rotina leem os anexos sem ter a quem perguntar, e um cartão com 2 arquivos não pode
 * travar o trabalho delas.
 */
export function registerAttachmentListCommand(attachmentCommand: Command): void {
  const command = attachmentCommand
    .command("list")
    .description(
      "LEITURA: lista os arquivos do cartão nos campos de anexo, nos comentários e na aba Anexos, com o attachmentId de cada um"
    )
    .option("--card-id <id>", "Cartão (número ou link; padrão: o cartão do run)")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link, do número do cartão ou do run)")
    .option(
      "--name <trecho>",
      "O arquivo que a pessoa citou (ex.: \"contrato\", \"nota fiscal da colaboração\"): procura no nome e em onde está"
    )
    .action(
      createCommandAction(async ({ kit }, options: AttachmentListOptions) => {
        const cardId = options.cardId ?? envCardId();
        if (!cardId) {
          throw new CangeCliUsageError("Informe o cartão: `cange attachment list --card-id <id>`.");
        }
        const flowId = options.flowId ?? envFlowId();
        if (!flowId) throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);

        const found = await collectCardAttachments(kit, { flowId: Number(flowId), cardId: Number(cardId) });
        const total =
          found.fields.reduce((sum, field) => sum + field.files.length, 0) +
          found.comments.reduce((sum, comment) => sum + comment.files.length, 0) +
          found.cardTab.length;
        const refs = cardFileRefs(found);
        const name = typeof options.name === "string" && options.name.trim() !== "" ? options.name : undefined;
        const match = matchCardFiles(refs, name);
        const ask = askWhichFile(match, name);
        // Um arquivo certo (o único, ou o único que bate com o nome): o `next` já baixa ele.
        const only = !ask && match.candidates.length === 1 ? match.candidates[0] : undefined;
        return {
          cardId: found.cardId,
          flowId: found.flowId,
          total,
          files: match.candidates,
          ...(name !== undefined ? { match: { name: name.trim(), found: match.found, exact: match.exact } } : {}),
          ...(ask ? { ask } : {}),
          ...(total === 0
            ? { hint: "O cartão não tem arquivo nos campos de anexo nem na colaboração (comentários)." }
            : {}),
          fields: found.fields,
          comments: found.comments,
          ...(found.cardTab.length > 0 ? { cardTab: found.cardTab } : {}),
          next: only
            ? `cange attachment download --card-id ${found.cardId} --attachment-id ${only.attachmentId} --out <pasta>`
            : total > 0
              ? `cange attachment download --card-id ${found.cardId} --attachment-id <id> --out <pasta>`
              : undefined
        };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ cardId, flowId, total, files[{attachmentId, fileName, source: campo|colaboracao|aba_anexos, where, field?, author?, " +
      "createdAt?}], match?{name, found, exact}, ask?, hint?, fields[{fieldId, title, allowedTypes?, files[{attachmentId, " +
      "fileName, mimeType, sizeKb}]}], comments[{commentId, author, createdAt, files[...]}], cardTab?[...] (aba Anexos), next? }",
    fieldsLocation:
      "`files` = todos os arquivos do cartão (com --name, só os que batem; nenhum bateu = todos). `ask` só vem com --name, " +
      "quando não dá para saber qual é: mais de um candidato ou nenhum com o nome dito; pergunte à pessoa antes de usar. " +
      "Sem --name é só a lista (nunca `ask`). " +
      "Campo de anexo sem arquivo também aparece em `fields` (o título e os tipos aceitos servem para o `attachment " +
      "link-field`). Comentário só aparece quando tem arquivo.",
    example: 'attachment list --card-id 1234 --name "contrato"'
  });
}
