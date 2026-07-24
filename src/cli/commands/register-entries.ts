import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface RegisterEntriesOptions {
  idRegister?: string;
  search?: string;
  pageSize?: string;
  cursor?: string;
}

export function registerRegisterEntriesCommand(registerCommand: Command): void {
  registerCommand
    .command("entries")
    .description("Lê as entradas de um cadastro (detecta a engine v1/v2 e roteia automaticamente)")
    .option("--id-register <id>", "ID do cadastro (register)")
    .option("--search <text>", "Filtra as entradas por texto")
    .option("--page-size <n>", "Tamanho da página (só afeta a engine v2; teto 200)")
    .option("--cursor <cursor>", "Cursor da próxima página (só engine v2)")
    .action(
      createCommandAction(async ({ kit }, options: RegisterEntriesOptions) => {
        if (!options.idRegister) {
          throw new CangeCliUsageError("Informe --id-register.");
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
