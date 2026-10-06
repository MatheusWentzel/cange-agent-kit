import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import type { RegisterEntry } from "../../contracts/types.js";
import { dropEmpty, htmlToMarkdown, looksLikeHtml } from "../../utils/lean.js";
import { listOutput } from "../../utils/toon.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { addSearchSynonyms } from "../helpers.js";

interface RegisterEntriesOptions {
  idRegister?: string;
  register?: string;
  registerId?: string;
  search?: string;
  pageSize?: string;
  cursor?: string;
}

/**
 * C4 (card #1367459): página padrão do enxuto. Ler cadastro custava ~9 mil tokens por
 * vez em produção (o `raw` inteiro ia junto das entradas, e todas as entradas de uma vez).
 */
export const REGISTER_ENTRIES_DEFAULT_PAGE = 20;
/** Teto do valor de um campo de entrada no enxuto (rich text, observações). */
const ENTRY_VALUE_CAP = 600;

function cutEntryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cutEntryValue);
  if (typeof value !== "string") return value;
  const text = looksLikeHtml(value) ? htmlToMarkdown(value) : value;
  if (text.length <= ENTRY_VALUE_CAP) return text;
  return `${text.slice(0, ENTRY_VALUE_CAP)}…(cortado: a entrada inteira em cange register-form-answer get --form-answer-id <id>)`;
}

function leanEntry(entry: RegisterEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [label, value] of Object.entries(entry.fields ?? {})) {
    fields[label] = cutEntryValue(value);
  }
  return { id: entry.id, title: entry.title, fields };
}

export function registerRegisterEntriesCommand(registerCommand: Command): void {
  const command = registerCommand
    .command("entries")
    .description("Lê as entradas de um cadastro (detecta a engine v1/v2 e roteia automaticamente)")
    .option("--register-id <id>", "ID do cadastro (register); aceita também o link do Cange ou o hash")
    .option("--register <id>", "Alias de --register-id")
    // Alias legado: o resto do CLI usa --register-id; mantido por compatibilidade.
    .option("--id-register <id>", "ID do cadastro (alias legado de --register-id)")
    .option("--search <text>", "Filtra as entradas por texto (--q é sinônimo)")
    .option(
      "--page-size <n>",
      `Entradas por página (enxuto: padrão ${REGISTER_ENTRIES_DEFAULT_PAGE}; engine v2 tem teto 200)`
    )
    .option("--cursor <cursor>", "Página seguinte: o `--cursor` que veio em `next` na chamada anterior")
    .action(
      createCommandAction(async ({ kit, profile }, options: RegisterEntriesOptions) => {
        options.idRegister = options.registerId ?? options.register ?? options.idRegister;
        if (!options.idRegister) {
          throw new CangeCliUsageError("Informe --register-id <id> (o id aparece em cange my-registers; o link do Cange também serve).");
        }
        const explicitPageSize = options.pageSize !== undefined ? Number(options.pageSize) : undefined;
        if (explicitPageSize !== undefined && (!Number.isInteger(explicitPageSize) || explicitPageSize <= 0)) {
          throw new CangeCliUsageError("--page-size deve ser um inteiro positivo.");
        }
        if (profile === "full") {
          return kit.contracts.getRegisterEntries({
            registerId: options.idRegister,
            search: options.search,
            pageSize: explicitPageSize,
            cursor: options.cursor
          });
        }

        // Enxuto: sem `raw`, página de 20, valor longo cortado e o comando da página seguinte.
        const pageSize = explicitPageSize ?? REGISTER_ENTRIES_DEFAULT_PAGE;
        const isOffset = options.cursor === undefined || /^\d+$/.test(options.cursor);
        const result = await kit.contracts.getRegisterEntries({
          registerId: options.idRegister,
          search: options.search,
          pageSize,
          // Cursor numérico é o deslocamento da v1 (lista inteira); o resto é cursor da v2.
          cursor: isOffset ? undefined : options.cursor
        });

        let entries = result.entries;
        let total: number | undefined;
        let nextCursor: string | undefined;
        if (result.engine === "v1") {
          const offset = options.cursor !== undefined && isOffset ? Number(options.cursor) : 0;
          total = entries.length;
          entries = entries.slice(offset, offset + pageSize);
          if (offset + pageSize < total) nextCursor = String(offset + pageSize);
        } else {
          total = result.executionStats?.totalCount;
          nextCursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor : undefined;
        }

        const next = nextCursor
          ? [
              "cange register entries",
              `--register-id ${options.idRegister}`,
              ...(options.search ? [`--search ${JSON.stringify(options.search)}`] : []),
              ...(explicitPageSize !== undefined ? [`--page-size ${explicitPageSize}`] : []),
              `--cursor ${nextCursor}`
            ].join(" ")
          : undefined;

        return listOutput(
          dropEmpty({
            registerId: Number(options.idRegister),
            engine: result.engine,
            total,
            count: entries.length,
            next,
            entries: entries.map(leanEntry)
          }),
          "entries"
        );
      })
    );
  addSearchSynonyms(command, "search");

  annotateCommand(command, {
    envelope:
      `Enxuto (padrão): { registerId, engine, total?, count, next? (comando pronto da página seguinte), entries[{id, title, fields: {<título do campo>: valor}}] } com ${REGISTER_ENTRIES_DEFAULT_PAGE} por página e valor acima de ${ENTRY_VALUE_CAP} caracteres cortado. ` +
      "Com --full: { raw, engine, entries, pageInfo, executionStats? } (formato de antes)",
    fieldsLocation: "o id de cada item em `entries` é o id da entrada (form answer)",
    example: 'register entries --register-id 175 --search "ACME"'
  });
}
