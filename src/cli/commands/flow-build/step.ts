import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import {
  createStepPayloadSchema,
  reorderStepPayloadSchema,
  updateStepPayloadSchema
} from "../../../schemas/flowV2Build.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface StepCreateOptions {
  idFlow?: string;
  payload: string;
  dryRun?: boolean;
}

interface StepUpdateOptions {
  idFlow?: string;
  idStep?: string;
  payload: string;
  dryRun?: boolean;
}

interface StepReorderOptions {
  idFlow?: string;
  payload: string;
  dryRun?: boolean;
}

export function registerFlowBuildStepCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("step")
    .description("Operações de criação/atualização/reordenação de etapa (build)");

  command
    .command("create")
    .description("MUTAÇÃO: cria etapa do fluxo (POST /flows/:id_flow/steps)")
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: StepCreateOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createStepPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build step create.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({ idFlow: options.idFlow, payload: parsed.data });
        }
        return kit.contracts.createFlowBuildStep({
          idFlow: options.idFlow,
          payload: parsed.data
        });
      })
    );

  command
    .command("update")
    .description("MUTAÇÃO: atualiza etapa (PATCH /flows/:id_flow/steps/:id_step)")
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--id-step <id>", "ID da etapa")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: StepUpdateOptions) => {
        if (!options.idFlow || !options.idStep) {
          throw new CangeCliUsageError("Informe --id-flow e --id-step.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateStepPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build step update.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({
            idFlow: options.idFlow,
            idStep: options.idStep,
            payload: parsed.data
          });
        }
        return kit.contracts.updateFlowBuildStep({
          idFlow: options.idFlow,
          idStep: options.idStep,
          payload: parsed.data
        });
      })
    );

  command
    .command("reorder")
    .description(
      "MUTAÇÃO: sobe ou desce uma etapa (POST /flows/:id_flow/steps/reorder). Body: { id_step, upDown: 'up' | 'down' }"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: StepReorderOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = reorderStepPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build step reorder.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({ idFlow: options.idFlow, payload: parsed.data });
        }
        return kit.contracts.reorderFlowBuildStep({
          idFlow: options.idFlow,
          payload: parsed.data
        });
      })
    );
}
