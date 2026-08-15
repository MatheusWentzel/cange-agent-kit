import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface RegisterGetOptions {
  idRegister?: string;
  registerId?: string;
  hash?: string;
}

export function registerRegisterGetCommand(registerCommand: Command): void {
  registerCommand
    .command("get")
    .description("Busca um register por id ou hash")
    .option("--register-id <id>", "ID do register")
    // Alias legado: o resto do CLI usa --register-id; mantido por compatibilidade.
    .option("--id-register <id>", "ID do register (alias legado de --register-id)")
    .option("--hash <hash>", "Hash do register")
    .action(
      createCommandAction(async ({ kit }, options: RegisterGetOptions) => {
        const idRegister = options.registerId ?? options.idRegister;
        if (!idRegister && !options.hash) {
          throw new CangeCliUsageError("Informe --register-id (ou --id-register) ou --hash.");
        }
        return kit.contracts.getRegister({
          idRegister,
          hash: options.hash
        });
      })
    );
}
