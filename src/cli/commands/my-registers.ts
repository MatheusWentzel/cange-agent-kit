import type { Command } from "commander";

import { createCommandAction } from "../context.js";

export function registerMyRegistersCommand(program: Command): void {
  program
    .command("my-registers")
    .description("Lista os registers disponíveis para o usuário autenticado")
    .action(
      createCommandAction(async ({ kit }) => {
        const result = await kit.contracts.getMyRegisters();
        return {
          raw: result.raw,
          summaries: result.summaries,
          total: result.summaries.length
        };
      })
    );
}
