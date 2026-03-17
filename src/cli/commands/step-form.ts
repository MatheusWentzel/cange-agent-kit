import type { Command } from "commander";

import { getExpectedFormatByFieldType } from "../../utils/fieldTypeGuards.js";
import { createCommandAction } from "../context.js";

interface StepFormOptions {
  flowId: string;
  stepId: string;
}

export function registerStepFormCommand(program: Command): void {
  program
    .command("step-form")
    .description("Descobre fields do formulário da etapa atual de um flow")
    .requiredOption("--flow-id <id>", "ID do flow")
    .requiredOption("--step-id <id>", "ID da etapa")
    .action(
      createCommandAction(async ({ kit }, options: StepFormOptions) => {
        const data = await kit.contracts.getFlowStepFormFields({
          flowId: options.flowId,
          stepId: options.stepId
        });

        const fields = data.fields.map((field) => ({
          id: field.id,
          name: field.name,
          title: field.title,
          description: field.description,
          type: field.type,
          expectedFormat: getExpectedFormatByFieldType(field.type),
          required: field.required,
          formId: field.formId,
          options: normalizeFieldOptions(field.options)
        }));

        return {
          raw: data.raw,
          context: {
            flowId: options.flowId,
            stepId: options.stepId,
            stepName: data.step?.name,
            formId: data.formId
          },
          requiredFields: fields.filter((field) => field.required),
          optionalFields: fields.filter((field) => !field.required),
          total: fields.length
        };
      })
    );
}

function normalizeFieldOptions(options: unknown): Array<string | number | Record<string, unknown>> | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }

  return options.map((option) => {
    if (typeof option === "string" || typeof option === "number") {
      return option;
    }
    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      return {
        raw: option
      };
    }
    const record = option as Record<string, unknown>;
    return {
      id: record.id ?? record.id_field_option ?? record.field_option_id ?? record.option_id,
      value: record.value,
      title: record.title ?? record.label ?? record.name,
      raw: record
    };
  });
}
