import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";

interface FlowGetOptions {
  idFlow?: string;
  flowId?: string;
  hash?: string;
  raw?: boolean;
}

export function registerFlowGetCommand(flowCommand: Command): void {
  flowCommand
    .command("get")
    .description("Busca um flow por id ou hash (digest por padrão; --raw p/ config completa)")
    .option("--flow-id <id>", "ID do flow")
    // Alias legado: todo o resto do CLI usa --flow-id; mantido por compatibilidade.
    .option("--id-flow <id>", "ID do flow (alias legado de --flow-id)")
    .option("--hash <hash>", "Hash do flow")
    .option("--raw", "Inclui a config completa do flow (flow_steps/form_init/schema_view — 74KB; p/ etapas use `cange map`)")
    .action(
      createCommandAction(async ({ kit }, options: FlowGetOptions) => {
        const idFlow = options.flowId ?? options.idFlow;
        if (!idFlow && !options.hash) {
          throw new CangeCliUsageError("Informe --flow-id (ou --id-flow) ou --hash.");
        }
        const result = await kit.contracts.getFlow({
          idFlow,
          hash: options.hash
        });

        // Digest (default): sem o raw — a config completa (flow_steps + form_init
        // + schema_view) é UI-config de ~74KB, inútil pro agente; `cange map`
        // entrega etapas/estrutura em 7KB. --raw devolve o formato antigo.
        if (!options.raw && result && typeof result === "object" && "raw" in (result as Record<string, unknown>)) {
          const { raw: _raw, ...rest } = result as Record<string, unknown>;
          return rest;
        }
        return result;
      })
    );
}
