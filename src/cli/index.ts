#!/usr/bin/env node
import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { createCliPrinter } from "../utils/output.js";
import { registerAttachmentLinkCardCommand } from "./commands/attachment-link-card.js";
import { registerAttachmentUploadCommand } from "./commands/attachment-upload.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerCardCommentCreateCommand } from "./commands/card-comment-create.js";
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
import { registerFlowGetCommand } from "./commands/flow-get.js";
import { registerMyFlowsCommand } from "./commands/my-flows.js";
import { registerMyRegistersCommand } from "./commands/my-registers.js";
import { registerMyTasksCommand } from "./commands/my-tasks.js";
import { registerNotificationReadCommand } from "./commands/notification-read.js";
import { registerNotificationsCommand } from "./commands/notifications.js";
import { registerRegisterCreateCommand } from "./commands/register-create.js";
import { registerRegisterFormAnswerGetCommand } from "./commands/register-form-answer-get.js";
import { registerRegisterGetCommand } from "./commands/register-get.js";
import { registerRegisterUpdateCommand } from "./commands/register-update.js";
import { registerStepFormCommand } from "./commands/step-form.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("cange")
    .description("CLI do cange-agent-kit para discovery e mutações seguras")
    .version("0.1.0")
    .option("--output <mode>", "Formato de saída: json|pretty", process.env.CANGE_OUTPUT ?? "pretty");

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

  const registerCommand = program.command("register").description("Operações de register");
  registerRegisterGetCommand(registerCommand);
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

  const commentCommand = program.command("comment").description("Operações de comentário");
  registerCardCommentListCommand(commentCommand);
  registerCardCommentCreateCommand(commentCommand);

  const attachmentCommand = program.command("attachment").description("Operações de attachment");
  registerAttachmentUploadCommand(attachmentCommand);
  registerAttachmentLinkCardCommand(attachmentCommand);

  const registerFormAnswerCommand = program
    .command("register-form-answer")
    .description("Operações de resposta de formulário de register");
  registerRegisterFormAnswerGetCommand(registerFormAnswerCommand);

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram();
  program.showHelpAfterError();
  program.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isCommanderHelp(error)) {
      return;
    }

    const printer = createCliPrinter("pretty");
    printer.printError(normalizeCliError(error));
    process.exitCode = 1;
  }
}

function isCommanderHelp(error: unknown): boolean {
  return isCommanderError(error) && error.code === "commander.helpDisplayed";
}

function isCommanderError(
  error: unknown
): error is { code: string; message: string } {
  return error !== null && typeof error === "object" && "code" in error && "message" in error;
}

function normalizeCliError(error: unknown): Error {
  if (isCommanderError(error)) {
    return new CangeCliUsageError(error.message, { code: error.code });
  }
  if (error instanceof Error) {
    return error;
  }
  return new CangeCliUsageError("Falha ao executar CLI.", {
    details: error
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
