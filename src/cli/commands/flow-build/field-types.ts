import type { Command } from "commander";

import { CangeCliUsageError } from "../../../client/errors.js";
import { createCommandAction } from "../../context.js";

interface FieldTypeGetOptions {
  type?: string;
}

export function registerFlowBuildFieldTypesCommand(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("field-types")
    .description("Catálogo de tipos de campo aceitos pela API de build");

  command
    .command("list")
    .description("Lista tipos de campo disponíveis (GET /field-types)")
    .action(
      createCommandAction(async ({ kit }) => {
        return kit.contracts.listFlowBuildFieldTypes();
      })
    );

  command
    .command("get")
    .description("Descritor Zod de um tipo de campo (GET /field-types/:type)")
    .requiredOption("--type <type>", "Nome do tipo (ex: TEXT_SHORT_FIELD)")
    .action(
      createCommandAction(async ({ kit }, options: FieldTypeGetOptions) => {
        if (!options.type) {
          throw new CangeCliUsageError("Informe --type.");
        }
        return kit.contracts.getFlowBuildFieldTypeDescriptor({ type: options.type });
      })
    );
}
