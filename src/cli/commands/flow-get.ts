import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface FlowGetOptions {
  idFlow?: string;
  flowId?: string;
  hash?: string;
}

export function registerFlowGetCommand(flowCommand: Command): void {
  flowCommand
    .command("get")
    .description("Busca um flow por id ou hash")
    .option("--flow-id <id>", "ID do flow")
    // Alias legado: todo o resto do CLI usa --flow-id; mantido por compatibilidade.
    .option("--id-flow <id>", "ID do flow (alias legado de --flow-id)")
    .option("--hash <hash>", "Hash do flow")
    .action(
      createCommandAction(async ({ kit }, options: FlowGetOptions) => {
        const idFlow = options.flowId ?? options.idFlow;
        if (!idFlow && !options.hash) {
          throw new CangeCliUsageError("Informe --flow-id (ou --id-flow) ou --hash.");
        }
        return kit.contracts.getFlow({
          idFlow,
          hash: options.hash
        });
      })
    );
}
