import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import {
  createFlowPayloadSchema,
  updateFlowPayloadSchema
} from "../../../schemas/flowV2Build.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface FlowCreateOptions {
  payload: string;
  dryRun?: boolean;
}

interface FlowUpdateOptions {
  idFlow?: string;
  payload: string;
  dryRun?: boolean;
}

export function registerFlowBuildFlowCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("flow")
    .description("Operações de criação/atualização de fluxo (build)");

  command
    .command("create")
    .description("MUTAÇÃO: cria fluxo (POST /flow/v2/build/flows)")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FlowCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createFlowPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build flow create.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }
        return kit.contracts.createFlowBuildFlow(parsed.data);
      })
    );

  command
    .command("update")
    .description("MUTAÇÃO: atualiza metadados do fluxo (PATCH /flows/:id_flow)")
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FlowUpdateOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateFlowPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build flow update.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({ idFlow: options.idFlow, payload: parsed.data });
        }
        return kit.contracts.updateFlowBuildFlow({
          idFlow: options.idFlow,
          payload: parsed.data
        });
      })
    );
}
