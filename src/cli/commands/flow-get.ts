import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface FlowGetOptions {
  idFlow?: string;
  hash?: string;
}

export function registerFlowGetCommand(flowCommand: Command): void {
  flowCommand
    .command("get")
    .description("Busca um flow por id ou hash")
    .option("--id-flow <id>", "ID do flow")
    .option("--hash <hash>", "Hash do flow")
    .action(
      createCommandAction(async ({ kit }, options: FlowGetOptions) => {
        if (!options.idFlow && !options.hash) {
          throw new CangeCliUsageError("Informe --id-flow ou --hash.");
        }
        return kit.contracts.getFlow({
          idFlow: options.idFlow,
          hash: options.hash
        });
      })
    );
}
