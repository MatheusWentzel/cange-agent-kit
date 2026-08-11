#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { createCliPrinter } from "../utils/output.js";
import { exitCodeForError } from "./exit-codes.js";
import { resolveOutputMode } from "./output-mode.js";
import { registerAttachmentLinkCardCommand } from "./commands/attachment-link-card.js";
import { registerAttachmentUploadCommand } from "./commands/attachment-upload.js";
import { registerToolCallCommand } from "./commands/tool-call.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerCardAddChildCommand } from "./commands/card-add-child.js";
import { registerCardAddLabelCommand } from "./commands/card-add-label.js";
import { registerCardCommentCreateCommand } from "./commands/card-comment-create.js";
import { registerCardRelationshipCommand } from "./commands/card-relationship.js";
import { registerCardCommentListCommand } from "./commands/card-comment-list.js";
import { registerCardCreateCommand } from "./commands/card-create.js";
import { registerCardGetCommand } from "./commands/card-get.js";
import { registerCardMoveStepCommand } from "./commands/card-move-step.js";
import { registerCardMoveStepWithValuesCommand } from "./commands/card-move-step-with-values.js";
import { registerCardUpdateCommand } from "./commands/card-update.js";
import { registerCardUpdateValuesCommand } from "./commands/card-update-values.js";
import { registerCardsListCommand } from "./commands/cards-list.js";
import { registerFieldsByFlowCommand } from "./commands/fields-by-flow.js";
import { registerFieldsByRegisterCommand } from "./commands/fields-by-register.js";
import { registerTemplateFlowCreateCommand } from "./commands/field-template-flow.js";
import { registerTemplateRegisterCreateCommand } from "./commands/field-template-register.js";
import { registerTemplateStepMoveCommand } from "./commands/field-template-step-move.js";
import { registerFlowBuildFieldCommands } from "./commands/flow-build/field.js";
import { registerFlowBuildFieldTypesCommand } from "./commands/flow-build/field-types.js";
import { registerFlowBuildFlowCommands } from "./commands/flow-build/flow.js";
import { registerFlowBuildPingCommand } from "./commands/flow-build/ping.js";
import { registerFlowBuildStepCommands } from "./commands/flow-build/step.js";
import { registerFlowBuildStepRelationshipCommands } from "./commands/flow-build/step-relationship.js";
import { registerFlowGetCommand } from "./commands/flow-get.js";
import { registerFlowQueryCommand } from "./commands/flow-query.js";
import { registerFlowViewsListCommand } from "./commands/flow-views-list.js";
import { registerManifestCommand } from "./commands/manifest.js";
import { registerMyFlowsCommand } from "./commands/my-flows.js";
import { registerMyRegistersCommand } from "./commands/my-registers.js";
import { registerMyTasksCommand } from "./commands/my-tasks.js";
import { registerNotificationReadCommand } from "./commands/notification-read.js";
import { registerNotificationsCommand } from "./commands/notifications.js";
import { registerRegisterCreateCommand } from "./commands/register-create.js";
import { registerRegisterEntriesCommand } from "./commands/register-entries.js";
import { registerRegisterFormAnswerGetCommand } from "./commands/register-form-answer-get.js";
import { registerRegisterGetCommand } from "./commands/register-get.js";
import { registerRegisterUpdateCommand } from "./commands/register-update.js";
import { registerStepFormCommand } from "./commands/step-form.js";
import { registerTimeTrackingCreateCommand } from "./commands/time-tracking-create.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("cange")
    .description("CLI do cange-agent-kit para discovery e mutações seguras")
    .version("0.1.0")
    .option(
      "--output <mode>",
      "Formato de saída: json|pretty (default: json quando stdout é pipe, pretty em terminal)"
    );

  registerAuthCommand(program);
  registerMyFlowsCommand(program);
  registerMyRegistersCommand(program);
  registerMyTasksCommand(program);
  registerStepFormCommand(program);
  registerNotificationsCommand(program);

  const notificationCommand = program.command("notification").description("Operações de notificação");
  registerNotificationReadCommand(notificationCommand);

  const flowCommand = program.command("flow").description("Operações de flow");
  registerFlowGetCommand(flowCommand);
  registerFlowQueryCommand(flowCommand);

  const flowViewsCommand = flowCommand.command("views").description("Visualizações (views salvas) de um flow");
  registerFlowViewsListCommand(flowViewsCommand);

  const registerCommand = program.command("register").description("Operações de register");
  registerRegisterGetCommand(registerCommand);
  registerRegisterEntriesCommand(registerCommand);
  registerRegisterCreateCommand(registerCommand);
  registerRegisterUpdateCommand(registerCommand);

  const fieldsCommand = program.command("fields").description("Consulta de fields");
  registerFieldsByFlowCommand(fieldsCommand);
  registerFieldsByRegisterCommand(fieldsCommand);

  const templateCommand = program.command("template").description("Templates seguros de payload");
  registerTemplateFlowCreateCommand(templateCommand);
  registerTemplateRegisterCreateCommand(templateCommand);
  registerTemplateStepMoveCommand(templateCommand);

  const cardCommand = program.command("card").description("Operações de card");
  registerCardGetCommand(cardCommand);
  registerCardsListCommand(cardCommand);
  registerCardCreateCommand(cardCommand);
  registerCardUpdateCommand(cardCommand);
  registerCardUpdateValuesCommand(cardCommand);
  registerCardMoveStepCommand(cardCommand);
  registerCardMoveStepWithValuesCommand(cardCommand);
  registerCardAddLabelCommand(cardCommand);
  registerCardRelationshipCommand(cardCommand);
  registerCardAddChildCommand(cardCommand);

  const commentCommand = program.command("comment").description("Operações de comentário");
  registerCardCommentListCommand(commentCommand);
  registerCardCommentCreateCommand(commentCommand);

  const attachmentCommand = program.command("attachment").description("Operações de attachment");
  registerAttachmentUploadCommand(attachmentCommand);
  registerAttachmentLinkCardCommand(attachmentCommand);

  const toolCommand = program.command("tool").description("Ferramentas de API do agente (agent_tool type='api')");
  registerToolCallCommand(toolCommand);

  const registerFormAnswerCommand = program
    .command("register-form-answer")
    .description("Operações de resposta de formulário de register");
  registerRegisterFormAnswerGetCommand(registerFormAnswerCommand);

  const timeTrackingCommand = program
    .command("time-tracking")
    .description("Operações de time tracking");
  registerTimeTrackingCreateCommand(timeTrackingCommand);

  const flowBuildCommand = program
    .command("flow-build")
    .description(
      "Construção de fluxos via Flow V2 Build API (/flow/v2/build): fluxo, etapas, campos e relacionamentos"
    );
  registerFlowBuildPingCommand(flowBuildCommand);
  registerFlowBuildFieldTypesCommand(flowBuildCommand);
  registerFlowBuildFlowCommands(flowBuildCommand);
  registerFlowBuildStepCommands(flowBuildCommand);
  registerFlowBuildFieldCommands(flowBuildCommand);
  registerFlowBuildStepRelationshipCommands(flowBuildCommand);

  registerManifestCommand(program);

  return program;
}

const DISCOVERY_HINT =
  "Descubra os comandos disponíveis: `cange manifest --output json` (fonte de verdade) " +
  "ou `cange <grupo> --help`.";

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram();
  // Item 1: erros ensinam o próximo passo — aplicado a TODA a árvore (subcomandos
  // não herdam exitOverride/config; sem isso um comando desconhecido dentro de um
  // grupo sairia com exit 1 e mensagem crua, fora do nosso tratamento).
  applyCliErgonomics(program);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isCommanderHelp(error)) {
      return;
    }

    // Item 2/3: erro vai para stderr; stdout permanece limpo. Printer TTY-aware.
    const printer = createCliPrinter(resolveOutputMode(undefined));
    const normalized = normalizeCliError(error);
    printer.printError(normalized);
    process.exitCode = exitCodeForError(normalized);
  }
}

/**
 * Aplica recursivamente, a cada comando da árvore:
 * - exitOverride: parse-errors viram exceção tratada aqui (exit code correto).
 * - showSuggestionAfterError: "Did you mean X?" em typos.
 * - outputError no-op: o commander não escreve o erro direto; quem imprime é o
 *   runCli (uma vez só, com a rota de discovery anexada).
 */
function applyCliErgonomics(command: Command): void {
  command.exitOverride();
  command.showSuggestionAfterError(true);
  command.configureOutput({ outputError: () => {} });
  for (const child of command.commands) {
    applyCliErgonomics(child);
  }
}

function isCommanderHelp(error: unknown): boolean {
  // help e version escrevem a saída e "saem" com sucesso — não são erros.
  return (
    isCommanderError(error) &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  );
}

function isCommanderError(
  error: unknown
): error is { code: string; message: string } {
  return error !== null && typeof error === "object" && "code" in error && "message" in error;
}

/** Códigos do commander que indicam comando/opção desconhecidos ou uso inválido. */
const DISCOVERY_ERROR_CODES = new Set([
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.excessArguments",
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument"
]);

function normalizeCliError(error: unknown): Error {
  if (isCommanderError(error)) {
    // Item 1: anexa a rota de discovery à mensagem de comando/flag inválidos.
    const message = DISCOVERY_ERROR_CODES.has(error.code)
      ? `${error.message}\n${DISCOVERY_HINT}`
      : error.message;
    return new CangeCliUsageError(message, { code: error.code });
  }
  if (error instanceof Error) {
    return error;
  }
  return new CangeCliUsageError("Falha ao executar CLI.", {
    details: error
  });
}

/**
 * True quando este arquivo é o entrypoint invocado pelo Node — ROBUSTO A SYMLINK.
 *
 * O Node resolve symlinks em `import.meta.url` (realpath), mas `process.argv[1]`
 * preserva o caminho do SYMLINK (ex.: `node_modules/.bin/cange`, o bin que o `bin`
 * do package.json cria — como o runner/agente invoca). Sem resolver o realpath de
 * argv[1], a comparação falha na invocação por symlink → `runCli()` NUNCA roda e o
 * CLI sai silencioso, sem fazer nada (stdout/stderr vazios, exit 0). Resolver o
 * realpath + `pathToFileURL` faz a comparação bater tanto por symlink quanto por
 * invocação direta (`node dist/cli/index.js`, usado pelo `pnpm cli`).
 *
 * ⚠️ NÃO simplificar para `import.meta.url === `file://${process.argv[1]}``: isso
 * REINTRODUZ a regressão do commit 8c572af (todos os comandos de API voltavam
 * vazios quando o agente chamava `cange` via `.bin/cange`). Pego num run E2E real.
 */
function isInvokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isInvokedAsMain()) {
  await runCli();
}
