import type { Command } from "commander";

import { createCommandAction } from "../context.js";

export function registerMyFlowsCommand(program: Command): void {
  program
    .command("my-flows")
    .description("Lista os flows disponíveis para o usuário autenticado")
    .action(
      createCommandAction(async ({ kit }) => {
        const result = await kit.contracts.getMyFlows();
        return {
          raw: result.raw,
          summaries: result.summaries,
          total: result.summaries.length
        };
      })
    );
}
