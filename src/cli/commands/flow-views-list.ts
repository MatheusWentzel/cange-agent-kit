import type { Command } from "commander";

import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface FlowViewsListOptions {
  flowId: string;
  includeSchema?: boolean;
}

export function registerFlowViewsListCommand(viewsCommand: Command): void {
  const command = viewsCommand
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

  annotateCommand(command, {
    envelope: "{ raw, total, views[] }",
    fieldsLocation:
      "cada view em `views[]` traz id, name, icon, isPublic, isFavorited e `filter` (columnsCount/filtersCount/sort). Use o id em `flow query --view-id`. `raw` é pesado (schemas crus)",
    example: "flow views list --flow-id 192"
  });
}
