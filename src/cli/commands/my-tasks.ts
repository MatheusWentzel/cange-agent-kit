import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface MyTasksOptions {
  flowId?: string;
  stepId?: string;
}

export function registerMyTasksCommand(program: Command): void {
  program
    .command("my-tasks")
    .description("Lista os cards atribuídos ao usuário autenticado")
    .option("--flow-id <id>", "Filtra por flow")
    .option("--step-id <id>", "Filtra por etapa")
    .action(
      createCommandAction(async ({ kit }, options: MyTasksOptions) => {
        const result = await kit.contracts.getMyTasks({
          flowId: options.flowId,
          stepId: options.stepId
        });
        return {
          raw: result.raw,
          summaries: result.summaries,
          total: result.summaries.length
        };
      })
    );
}
