import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface FieldsByFlowOptions {
  flowId: string;
}

export function registerFieldsByFlowCommand(fieldsCommand: Command): void {
  fieldsCommand
    .command("by-flow")
    .description("Lista fields de um flow")
    .requiredOption("--flow-id <id>", "ID do flow")
    .action(
      createCommandAction(async ({ kit }, options: FieldsByFlowOptions) => {
        return kit.contracts.getFieldsByFlow({
          flowId: options.flowId
        });
      })
    );
}
