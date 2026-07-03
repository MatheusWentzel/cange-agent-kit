import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface FlowViewsListOptions {
  flowId: string;
  includeSchema?: boolean;
}

export function registerFlowViewsListCommand(viewsCommand: Command): void {
  viewsCommand
    .command("list")
    .description("Lista as visualizações (views salvas) de um flow, com resumo de filtros/colunas/ordenação")
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--include-schema", "Inclui o schema JSON parseado de cada view")
    .action(
      createCommandAction(async ({ kit }, options: FlowViewsListOptions) => {
        return kit.contracts.listFlowViews({
          flowId: options.flowId,
          includeSchema: options.includeSchema === true
        });
      })
    );
}
