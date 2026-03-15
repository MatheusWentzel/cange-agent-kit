import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface TemplateRegisterCreateOptions {
  registerId: string;
}

export function registerTemplateRegisterCreateCommand(templateCommand: Command): void {
  templateCommand
    .command("register-create")
    .description("Gera template de payload para criação de registro por register")
    .requiredOption("--register-id <id>", "ID do register")
    .action(
      createCommandAction(async ({ kit }, options: TemplateRegisterCreateOptions) => {
        return kit.contracts.buildRegisterCreationTemplate({
          registerId: options.registerId
        });
      })
    );
}
