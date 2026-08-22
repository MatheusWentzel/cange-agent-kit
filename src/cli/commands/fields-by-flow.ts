import type { Command } from "commander";

import { filterFieldsByForm } from "../../contracts/fields.js";
import { summarizeFields } from "../../contracts/raw-adapters.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface FieldsByFlowOptions {
  flowId: string;
  formId?: string;
  raw?: boolean;
}

export function registerFieldsByFlowCommand(fieldsCommand: Command): void {
  const command = fieldsCommand
    .command("by-flow")
    .description("Lista fields de um flow (digest por padrão; --raw p/ resposta completa)")
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--form-id <id>", "Filtra fields por form_id")
    .option("--raw", "Inclui raw + fields completos (pesado — o envelope antigo emitia o mesmo dado 4×)")
    .action(
      createCommandAction(async ({ kit }, options: FieldsByFlowOptions) => {
        const result = await kit.contracts.getFieldsByFlow({
          flowId: options.flowId
        });

        const filteredFields = filterFieldsByForm(result.fields, options.formId);
        const filteredSummary = summarizeFields(filteredFields);

        // Digest (default): só summaries — 4,9KB vs 105KB do envelope antigo
        // (que emitia raw + fields + summaries + summary, o MESMO dado 4×;
        // medição de 21/08 no flow 21157). --raw devolve o formato antigo.
        if (!options.raw) {
          return {
            summaries: filteredSummary.items,
            total: filteredSummary.total
          };
        }

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

  annotateCommand(command, {
    envelope: "{ summaries[], total } (digest) — com --raw: { raw, summaries[], total, fields[], summary }",
    fieldsLocation:
      "cada field em `summaries[]` traz name, title, type, expectedFormat, required, formId — use `name` como chave em payloads de `values`",
    example: "fields by-flow --flow-id 192 --form-id 657"
  });
}
