import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import { filterFieldsByForm } from "../../../contracts/fields.js";
import { summarizeFields } from "../../../contracts/raw-adapters.js";
import {
  createFieldPayloadSchema,
  patchFieldPayloadSchema
} from "../../../schemas/flowV2Build.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface FieldCreateOptions {
  idFlow?: string;
  idStep?: string;
  formId?: string;
  payload: string;
  dryRun?: boolean;
}

interface FieldUpdateOptions {
  idFlow?: string;
  idStep?: string;
  formId?: string;
  idField?: string;
  payload: string;
  dryRun?: boolean;
}

interface FieldDeleteOptions {
  idFlow?: string;
  idStep?: string;
  idField?: string;
  dryRun?: boolean;
}

interface FieldListOptions {
  idFlow?: string;
  formId?: string;
}

export function registerFlowBuildFieldCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("field")
    .description("Operações de criação/atualização/remoção/listagem de campos (build)");

  command
    .command("create")
    .description(
      "MUTAÇÃO: cria campo. Use --id-step OU --form-id. POST /flows/:id_flow/(steps/:id_step|forms/:form_id)/fields"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .option("--id-step <id>", "ID da etapa (usa o form da etapa)")
    .option("--form-id <id>", "ID do form alvo (ex: flow.form_init_id)")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FieldCreateOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        if (!options.idStep && !options.formId) {
          throw new CangeCliUsageError("Informe --id-step ou --form-id.");
        }
        if (options.idStep && options.formId) {
          throw new CangeCliUsageError("Use apenas um entre --id-step e --form-id.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createFieldPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build field create.", {
            details: parsed.error.format()
          });
        }
        const target: { kind: "step" | "form"; id: string } = options.idStep
          ? { kind: "step", id: options.idStep }
          : { kind: "form", id: options.formId ?? "" };

        if (options.dryRun) {
          return createDryRunResult({
            idFlow: options.idFlow,
            route: target.kind === "step" ? "by-step" : "by-form",
            idStep: target.kind === "step" ? target.id : undefined,
            formId: target.kind === "form" ? target.id : undefined,
            payload: parsed.data
          });
        }
        if (target.kind === "step") {
          return kit.contracts.createFlowBuildFieldByStep({
            idFlow: options.idFlow,
            idStep: target.id,
            payload: parsed.data
          });
        }
        return kit.contracts.createFlowBuildFieldByForm({
          idFlow: options.idFlow,
          formId: target.id,
          payload: parsed.data
        });
      })
    );

  command
    .command("update")
    .description(
      "MUTAÇÃO: atualiza campo. Tipo não pode mudar. Use somente um entre --id-step/--form-id (ou nenhum, para PATCH /flows/:id_flow/fields/:id_field)."
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .option("--id-step <id>", "ID da etapa (escopo restrito ao form da etapa)")
    .option("--form-id <id>", "ID do form alvo (escopo restrito ao form)")
    .requiredOption("--id-field <id>", "ID do campo")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FieldUpdateOptions) => {
        if (!options.idFlow || !options.idField) {
          throw new CangeCliUsageError("Informe --id-flow e --id-field.");
        }
        if (options.idStep && options.formId) {
          throw new CangeCliUsageError("Use apenas um entre --id-step e --form-id.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = patchFieldPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build field update.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({
            idFlow: options.idFlow,
            idStep: options.idStep,
            formId: options.formId,
            idField: options.idField,
            payload: parsed.data
          });
        }
        if (options.idStep) {
          return kit.contracts.patchFlowBuildFieldByStep({
            idFlow: options.idFlow,
            idStep: options.idStep,
            idField: options.idField,
            payload: parsed.data
          });
        }
        if (options.formId) {
          return kit.contracts.patchFlowBuildFieldByForm({
            idFlow: options.idFlow,
            formId: options.formId,
            idField: options.idField,
            payload: parsed.data
          });
        }
        return kit.contracts.patchFlowBuildFieldByFlow({
          idFlow: options.idFlow,
          idField: options.idField,
          payload: parsed.data
        });
      })
    );

  command
    .command("delete")
    .description(
      "MUTAÇÃO: remove um campo do flow. Use --id-step para restringir o escopo à etapa. DELETE /flows/:id_flow/(steps/:id_step/)fields/:id_field"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--id-field <id>", "ID do campo a remover")
    .option("--id-step <id>", "ID da etapa (restringe a remoção ao form da etapa)")
    .option("--dry-run", "Valida parâmetros localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FieldDeleteOptions) => {
        if (!options.idFlow || !options.idField) {
          throw new CangeCliUsageError("Informe --id-flow e --id-field.");
        }
        if (options.dryRun) {
          return createDryRunResult({
            idFlow: options.idFlow,
            idStep: options.idStep,
            idField: options.idField,
            route: options.idStep ? "by-step" : "by-flow"
          });
        }
        if (options.idStep) {
          return kit.contracts.deleteFlowBuildFieldByStep({
            idFlow: options.idFlow,
            idStep: options.idStep,
            idField: options.idField
          });
        }
        return kit.contracts.deleteFlowBuildFieldByFlow({
          idFlow: options.idFlow,
          idField: options.idField
        });
      })
    );

  command
    .command("list")
    .description(
      "Lista os campos do flow (sumarizados por form) — útil para detectar duplicata/fantasma pós-lote. Reusa GET /field/by-flow."
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .option("--form-id <id>", "Filtra campos por form_id")
    .action(
      createCommandAction(async ({ kit }, options: FieldListOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const result = await kit.contracts.getFieldsByFlow({ flowId: options.idFlow });
        const filteredFields = filterFieldsByForm(result.fields, options.formId);
        const filteredSummary = summarizeFields(filteredFields);
        return {
          raw: result.raw,
          summaries: filteredSummary.items,
          total: filteredSummary.total,
          groupedByFormId: filteredSummary.groupedByFormId
        };
      })
    );
}
