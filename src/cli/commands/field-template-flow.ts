import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface TemplateFlowCreateOptions {
  flowId: string;
}

export function registerTemplateFlowCreateCommand(templateCommand: Command): void {
  templateCommand
    .command("flow-create")
    .description("Gera template de payload para criação de card por flow")
    .requiredOption("--flow-id <id>", "ID do flow")
    .action(
      createCommandAction(async ({ kit }, options: TemplateFlowCreateOptions) => {
        return kit.contracts.buildCardCreationTemplate({
          flowId: options.flowId
        });
      })
    );
}
