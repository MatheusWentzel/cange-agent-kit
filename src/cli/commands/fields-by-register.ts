import type { Command } from "commander";

import { createCommandAction } from "../context.js";
import { parseOptionalBoolean } from "../helpers.js";

interface FieldsByRegisterOptions {
  registerId: string;
  typeFilter?: string;
  withChildren?: string;
}

export function registerFieldsByRegisterCommand(fieldsCommand: Command): void {
  fieldsCommand
    .command("by-register")
    .description("Lista fields de um register")
    .requiredOption("--register-id <id>", "ID do register")
    .option("--type-filter <value>", "Filtro de tipo")
    .option("--with-children <value>", "Incluir children (true|false)")
    .action(
      createCommandAction(async ({ kit }, options: FieldsByRegisterOptions) => {
        return kit.contracts.getFieldsByRegister({
          registerId: options.registerId,
          typeFilter: options.typeFilter,
          withChildren: parseOptionalBoolean(options.withChildren)
        });
      })
    );
}
