import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
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

export function registerFlowBuildFieldCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("field")
    .description("Operações de criação/atualização de campos (build)");

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
}
