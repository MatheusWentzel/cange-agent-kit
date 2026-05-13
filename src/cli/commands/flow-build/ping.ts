import type { Command } from "commander";

import { createCommandAction } from "../../context.js";

export function registerFlowBuildPingCommand(flowBuildCommand: Command): void {
  flowBuildCommand
    .command("ping")
    .description("Health check do router /flow/v2/build")
    .action(
      createCommandAction(async ({ kit }) => {
        return kit.contracts.flowBuildPing();
      })
    );
}
