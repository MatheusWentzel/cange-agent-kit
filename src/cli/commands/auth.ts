import type { Command } from "commander";

import { createCommandAction } from "../context.js";

export function registerAuthCommand(program: Command): void {
  const authCommand = program.command("auth").description("Comandos de autenticação");

  authCommand
    .command("login")
    .description("Autentica usando CANGE_ACCESS_TOKEN ou CANGE_EMAIL + CANGE_APIKEY")
    .action(
      createCommandAction(
        async ({ kit }) => {
          const result = await kit.contracts.authenticate();
          return {
            authenticated: true,
            source: result.source
          };
        },
        { requiresAuth: false }
      )
    );
}
