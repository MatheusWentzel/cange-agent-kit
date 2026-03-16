import type { Command } from "commander";

import { filterFieldsByForm } from "../../contracts/fields.js";
import { summarizeFields } from "../../contracts/raw-adapters.js";
import { createCommandAction } from "../context.js";
import { parseOptionalBoolean } from "../helpers.js";

interface FieldsByRegisterOptions {
  registerId: string;
  typeFilter?: string;
  withChildren?: string;
  formId?: string;
}

export function registerFieldsByRegisterCommand(fieldsCommand: Command): void {
  fieldsCommand
    .command("by-register")
    .description("Lista fields de um register")
    .requiredOption("--register-id <id>", "ID do register")
    .option("--type-filter <value>", "Filtro de tipo")
    .option("--with-children <value>", "Incluir children (true|false)")
    .option("--form-id <id>", "Filtra fields por form_id")
    .action(
      createCommandAction(async ({ kit }, options: FieldsByRegisterOptions) => {
        const result = await kit.contracts.getFieldsByRegister({
          registerId: options.registerId,
          typeFilter: options.typeFilter,
          withChildren: parseOptionalBoolean(options.withChildren)
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
