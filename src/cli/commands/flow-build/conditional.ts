import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import {
  conditionInputSchema,
  conditionalPayloadSchema,
  type ConditionInput,
  type ConditionalPayload,
  type ConditionalTargetInput
} from "../../../schemas/conditionals.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { annotateCommand } from "../../command-metadata.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface TargetOptions {
  idField?: string;
  idStep?: string;
  idStepFrom?: string;
}

interface RuleOptions {
  action?: string;
  when?: string[];
  payload?: string;
  dryRun?: boolean;
}

type ListOptions = { idFlow: string } & TargetOptions;
type CreateOptions = { idFlow: string } & TargetOptions & RuleOptions;
type UpdateOptions = { idFlow: string; idConditional: string; rehydrate?: boolean } & RuleOptions;

const WHEN_HELP =
  'Condição em JSON (repetível; todas precisam valer): \'{"field":"Tipo","comparator":"É uma das","values":["A","B"]}\'. ' +
  "field = id, hash ou título (-1 vencimento, -2 criação, -3 responsável, -4 etapa); valor por rótulo ou código";

const WHEN_EXAMPLE = `--when '{"field":"Tipo","comparator":"Igual a","value":"Externo"}'`;

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parseTargetOptions(options: TargetOptions): ConditionalTargetInput | undefined {
  const hasStep = options.idStep !== undefined || options.idStepFrom !== undefined;
  if (options.idField !== undefined && hasStep) {
    throw new CangeCliUsageError("Use --id-field (condicional de campo) OU --id-step com --id-step-from (de etapa).");
  }
  if (options.idField !== undefined) return { type: "field", idField: options.idField };
  if (!hasStep) return undefined;
  if (options.idStep === undefined || options.idStepFrom === undefined) {
    throw new CangeCliUsageError("Condicional de etapa pede --id-step (destino) e --id-step-from (origem).");
  }
  return { type: "step", idStep: options.idStep, idStepFrom: options.idStepFrom };
}

function parseWhen(raw: string, position: number): ConditionInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CangeCliUsageError(`--when ${position + 1} precisa ser um objeto JSON. Exemplo: ${WHEN_EXAMPLE}`);
  }
  const result = conditionInputSchema.safeParse(parsed);
  if (!result.success) {
    throw new CangeValidationError(`--when ${position + 1} inválido. Exemplo: ${WHEN_EXAMPLE}`, {
      details: result.error.format()
    });
  }
  return result.data;
}

async function readRule(options: RuleOptions): Promise<ConditionalPayload> {
  let payload: ConditionalPayload = {};
  if (options.payload !== undefined) {
    const parsed = conditionalPayloadSchema.safeParse(await readPayloadFile<unknown>(options.payload));
    if (!parsed.success) {
      throw new CangeValidationError(
        "Payload inválido para flow-build conditional: aceita só { action, conditions[] } (o kit monta o resto).",
        { details: parsed.error.format() }
      );
    }
    payload = parsed.data;
  }
  if (options.when && payload.conditions) {
    throw new CangeCliUsageError("Informe as condições por --when OU no --payload, não nos dois.");
  }
  const action = options.action ?? payload.action;
  const conditions = options.when?.map(parseWhen) ?? payload.conditions;
  return { ...(action !== undefined ? { action } : {}), ...(conditions ? { conditions } : {}) };
}

export function registerFlowBuildConditionalCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("conditional")
    .description("Condicionais de campo (exibir/esconder) e de etapa (permitir/bloquear mover), no formato da tela");

  const list = command
    .command("list")
    .description(
      "Lista as condicionais do fluxo, de um campo ou de uma etapa, e diz se o editor da tela consegue abrir cada uma"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .option("--id-field <id>", "Só as do campo alvo (GET /conditional/by-field)")
    .option("--id-step <id>", "Só as da etapa de destino (com --id-step-from; GET /conditional/by-step)")
    .option("--id-step-from <id>", "Etapa de origem do movimento")
    .action(
      createCommandAction(async ({ kit }, options: ListOptions) => {
        const target = parseTargetOptions(options);
        return kit.contracts.listFlowBuildConditionals({ idFlow: options.idFlow, ...(target ? { target } : {}) });
      })
    );
  annotateCommand(list, {
    envelope: "{ idFlow, conditionals[], total, notOpenable }",
    fieldsLocation:
      "conditionals[]: idConditional, type, target, action, actionLabel, opensInEditor, editorIssues[], conditions[]",
    example: "flow-build conditional list --id-flow 123 --id-field 456"
  });

  const create = command
    .command("create")
    .description(
      "MUTAÇÃO: cria condicional. O kit busca o campo de origem, valida e monta conditions_items (POST /conditional)"
    )
    .requiredOption("--id-flow <id>", "ID do flow")
    .option("--id-field <id>", "Campo alvo (o que aparece ou some)")
    .option("--id-step <id>", "Etapa de destino do movimento (com --id-step-from)")
    .option("--id-step-from <id>", "Etapa de origem do movimento")
    .option("--action <acao>", "Campo: exibir | esconder. Etapa: permitir | bloquear")
    .option("--when <json>", WHEN_HELP, collect)
    .option("--payload <path>", "JSON { action, conditions[] }, no lugar de --action e --when")
    .option("--dry-run", "Busca e valida tudo, mostra o que seria gravado e não grava")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CreateOptions) => {
        const target = parseTargetOptions(options);
        if (!target) {
          throw new CangeCliUsageError("Informe o alvo: --id-field, ou --id-step com --id-step-from.");
        }
        const { action, conditions } = await readRule(options);
        if (action === undefined) {
          throw new CangeCliUsageError("Informe --action (campo: exibir | esconder; etapa: permitir | bloquear).");
        }
        if (!conditions) {
          throw new CangeCliUsageError(`Informe ao menos uma condição: ${WHEN_EXAMPLE}`);
        }
        const input = { idFlow: options.idFlow, target, action, conditions };
        if (options.dryRun) {
          await ensureAuth();
          return createDryRunResult(await kit.contracts.prepareFlowBuildConditionalCreate(input));
        }
        return kit.contracts.createFlowBuildConditional(input);
      })
    );
  annotateCommand(create, {
    mutates: true,
    envelope: "{ idConditional, name, target, actionLabel, conditions[], verified }",
    fieldsLocation: "verified = relida depois de gravar; --dry-run devolve payload.body (o corpo exato do POST)",
    example: `flow-build conditional create --id-flow 123 --id-field 456 --action exibir ${WHEN_EXAMPLE}`
  });

  const update = command
    .command("update")
    .description("MUTAÇÃO: altera a condicional no lugar (mesmo id, mesmo alvo). O que não vier fica como está")
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--id-conditional <id>", "ID da condicional (ver flow-build conditional list)")
    .option("--action <acao>", "Campo: exibir | esconder. Etapa: permitir | bloquear")
    .option("--when <json>", `${WHEN_HELP}. Substitui TODAS as condições`, collect)
    .option("--payload <path>", "JSON { action?, conditions[]? }, no lugar de --action e --when")
    .option("--rehydrate", "Mantém ação e condições e regrava com o campo de origem inteiro (conserta regra que o editor não abre)")
    .option("--dry-run", "Busca e valida tudo, mostra o que seria gravado e não grava")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: UpdateOptions) => {
        const { action, conditions } = await readRule(options);
        if (action === undefined && conditions === undefined && !options.rehydrate) {
          throw new CangeCliUsageError("Nada para alterar: informe --action, --when, --payload ou --rehydrate.");
        }
        if (conditions !== undefined && options.rehydrate) {
          throw new CangeCliUsageError("--rehydrate mantém as condições atuais: não combine com condições novas.");
        }
        const input = {
          idFlow: options.idFlow,
          idConditional: options.idConditional,
          ...(action !== undefined ? { action } : {}),
          ...(conditions ? { conditions } : {})
        };
        if (options.dryRun) {
          await ensureAuth();
          return createDryRunResult(await kit.contracts.prepareFlowBuildConditionalUpdate(input));
        }
        return kit.contracts.updateFlowBuildConditional(input);
      })
    );
  annotateCommand(update, {
    mutates: true,
    envelope: "{ idConditional, name, target, actionLabel, conditions[], verified }",
    example: "flow-build conditional update --id-flow 123 --id-conditional 789 --rehydrate --dry-run"
  });
}
