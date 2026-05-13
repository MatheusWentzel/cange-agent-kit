import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import { stepRelationshipBodySchema } from "../../../schemas/flowV2Build.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface ListByFlowOptions {
  idFlow?: string;
}

interface ListFromStepOptions {
  idFlow?: string;
  idStep?: string;
}

interface SetRelationshipOptions {
  idFlow?: string;
  payload: string;
  dryRun?: boolean;
}

export function registerFlowBuildStepRelationshipCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("step-relationship")
    .description("Operações em arestas entre etapas (build step relationships)");

  command
    .command("list")
    .description(
      "Lista etapas com relationship_steps e conditionals (GET /flows/:id_flow/step-relationships/by-flow)"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .action(
      createCommandAction(async ({ kit }, options: ListByFlowOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        return kit.contracts.listFlowBuildStepRelationshipsByFlow({ idFlow: options.idFlow });
      })
    );

  command
    .command("from")
    .description(
      "Vista a partir da etapa pai (GET /flows/:id_flow/step-relationships?id_step=:parent)"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--id-step <id>", "ID da etapa pai (origem)")
    .action(
      createCommandAction(async ({ kit }, options: ListFromStepOptions) => {
        if (!options.idFlow || !options.idStep) {
          throw new CangeCliUsageError("Informe --id-flow e --id-step.");
        }
        return kit.contracts.listFlowBuildStepRelationshipsFromStep({
          idFlow: options.idFlow,
          idStep: options.idStep
        });
      })
    );

  command
    .command("set")
    .description(
      "MUTAÇÃO: cria/atualiza aresta (POST /flows/:id_flow/step-relationships). Body: { flow_step_id, step_available_id, isActive: '0' | '1' }"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: SetRelationshipOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = stepRelationshipBodySchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError(
            "Payload inválido para flow-build step-relationship set.",
            { details: parsed.error.format() }
          );
        }
        if (options.dryRun) {
          return createDryRunResult({ idFlow: options.idFlow, payload: parsed.data });
        }
        return kit.contracts.upsertFlowBuildStepRelationship({
          idFlow: options.idFlow,
          payload: parsed.data
        });
      })
    );
}
