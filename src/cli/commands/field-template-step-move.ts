import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface TemplateStepMoveOptions {
  flowId: string;
  fromStepId: string;
  toStepId: string;
}

export function registerTemplateStepMoveCommand(templateCommand: Command): void {
  templateCommand
    .command("step-move")
    .description("Gera template de payload para movimentação de etapa de card")
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--from-step-id <id>", "ID da etapa de origem")
    .requiredOption("--to-step-id <id>", "ID da etapa de destino")
    .action(
      createCommandAction(async ({ kit }, options: TemplateStepMoveOptions) => {
        return kit.contracts.buildCardStepMoveTemplate({
          flowId: options.flowId,
          fromStepId: options.fromStepId,
          toStepId: options.toStepId
        });
      })
    );
}
