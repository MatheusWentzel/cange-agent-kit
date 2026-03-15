import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface RegisterGetOptions {
  idRegister?: string;
  hash?: string;
}

export function registerRegisterGetCommand(registerCommand: Command): void {
  registerCommand
    .command("get")
    .description("Busca um register por id ou hash")
    .option("--id-register <id>", "ID do register")
    .option("--hash <hash>", "Hash do register")
    .action(
      createCommandAction(async ({ kit }, options: RegisterGetOptions) => {
        if (!options.idRegister && !options.hash) {
          throw new CangeCliUsageError("Informe --id-register ou --hash.");
        }
        return kit.contracts.getRegister({
          idRegister: options.idRegister,
          hash: options.hash
        });
      })
    );
}
