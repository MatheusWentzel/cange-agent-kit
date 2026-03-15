import type { Command } from "commander";

import { createCommandAction } from "../context.js";

export function registerMyTasksCommand(program: Command): void {
  program
    .command("my-tasks")
    .description("Lista os cards atribuídos ao usuário autenticado")
    .action(
      createCommandAction(async ({ kit }) => {
        const result = await kit.contracts.getMyTasks();
        return {
          raw: result.raw,
          summaries: result.summaries,
          total: result.summaries.length
        };
      })
    );
}
