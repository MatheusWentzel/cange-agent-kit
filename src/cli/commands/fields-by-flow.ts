import type { Command } from "commander";

import { filterFieldsByForm } from "../../contracts/fields.js";
import { summarizeFields } from "../../contracts/raw-adapters.js";
import { createCommandAction } from "../context.js";

interface FieldsByFlowOptions {
  flowId: string;
  formId?: string;
}

export function registerFieldsByFlowCommand(fieldsCommand: Command): void {
  fieldsCommand
    .command("by-flow")
    .description("Lista fields de um flow")
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--form-id <id>", "Filtra fields por form_id")
    .action(
      createCommandAction(async ({ kit }, options: FieldsByFlowOptions) => {
        const result = await kit.contracts.getFieldsByFlow({
          flowId: options.flowId
        });

        const filteredFields = filterFieldsByForm(result.fields, options.formId);
        const filteredSummary = summarizeFields(filteredFields);

        return {
          raw: result.raw,
          summaries: filteredSummary.items,
          total: filteredSummary.total,
          // Legacy keys kept for backward compatibility.
          fields: filteredFields,
          summary: filteredSummary
        };
      })
    );
}
