import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface RegisterFormAnswerGetOptions {
  formAnswerId: string;
}

export function registerRegisterFormAnswerGetCommand(registerFormAnswerCommand: Command): void {
  registerFormAnswerCommand
    .command("get")
    .description("Busca um form answer de register")
    .requiredOption("--form-answer-id <id>", "ID do form answer")
    .action(
      createCommandAction(async ({ kit }, options: RegisterFormAnswerGetOptions) => {
        return kit.contracts.getRegisterFormAnswer({
          formAnswerId: options.formAnswerId
        });
      })
    );
}
