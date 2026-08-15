import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface RegisterEntriesOptions {
  idRegister?: string;
  registerId?: string;
  search?: string;
  pageSize?: string;
  cursor?: string;
}

export function registerRegisterEntriesCommand(registerCommand: Command): void {
  registerCommand
    .command("entries")
    .description("Lê as entradas de um cadastro (detecta a engine v1/v2 e roteia automaticamente)")
    .option("--register-id <id>", "ID do cadastro (register)")
    // Alias legado: o resto do CLI usa --register-id; mantido por compatibilidade.
    .option("--id-register <id>", "ID do cadastro (alias legado de --register-id)")
    .option("--search <text>", "Filtra as entradas por texto")
    .option("--page-size <n>", "Tamanho da página (só afeta a engine v2; teto 200)")
    .option("--cursor <cursor>", "Cursor da próxima página (só engine v2)")
    .action(
      createCommandAction(async ({ kit }, options: RegisterEntriesOptions) => {
        options.idRegister = options.registerId ?? options.idRegister;
        if (!options.idRegister) {
          throw new CangeCliUsageError("Informe --register-id (ou --id-register).");
        }
        const pageSize = options.pageSize !== undefined ? Number(options.pageSize) : undefined;
        if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
          throw new CangeCliUsageError("--page-size deve ser um inteiro positivo.");
        }
        return kit.contracts.getRegisterEntries({
          registerId: options.idRegister,
          search: options.search,
          pageSize,
          cursor: options.cursor
        });
      })
    );
}
