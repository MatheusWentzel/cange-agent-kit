import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { authenticateKit, createCangeAgentKit, type CangeAgentKit } from "../index.js";
import { createCliPrinter, type CliPrinter, type OutputMode } from "../utils/output.js";

import { exitCodeForError } from "./exit-codes.js";
import { resolveOutputMode } from "./output-mode.js";

export interface CliCommandContext {
  kit: CangeAgentKit;
  printer: CliPrinter;
  outputMode: OutputMode;
  ensureAuth: () => Promise<{ token: string; source: "access-token-env" | "session-login"; raw?: unknown }>;
}

type CommandHandler<TArgs extends unknown[]> = (ctx: CliCommandContext, ...args: TArgs) => Promise<unknown>;

export function createCommandAction<TArgs extends unknown[]>(
  handler: CommandHandler<TArgs>,
  options: { requiresAuth?: boolean } = {}
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    const command = getCommandFromArgs(args);
    const ctx = await createContext(command);

    try {
      const requiresAuth = (options.requiresAuth ?? true) && !isDryRunInvocation(args);
      if (requiresAuth) {
        await ctx.ensureAuth();
      }

      const output = await handler(ctx, ...args);
      if (output !== undefined) {
        ctx.printer.print(output);
      }
    } catch (error) {
      ctx.printer.printError(error);
      process.exitCode = exitCodeForError(error);
    }
  };
}

async function createContext(command: Command): Promise<CliCommandContext> {
  const globalOptions = command.optsWithGlobals<{ output?: string }>();
  // TTY-aware: sem --output/CANGE_OUTPUT, json em pipe e pretty em terminal.
  const outputMode = resolveOutputMode(globalOptions.output);

  const kit = createCangeAgentKit({
    configOverrides: {
      output: outputMode
    }
  });

  const printer = createCliPrinter(outputMode);

  return {
    kit,
    printer,
    outputMode,
    ensureAuth: () => authenticateKit(kit)
  };
}

function getCommandFromArgs(args: unknown[]): Command {
  const maybeCommand = args.at(-1);
  if (!maybeCommand || !(maybeCommand instanceof Command)) {
    throw new CangeCliUsageError("Falha interna ao resolver contexto do comando.");
  }
  return maybeCommand;
}

function isDryRunInvocation(args: unknown[]): boolean {
  const first = args[0];
  return (
    !!first &&
    typeof first === "object" &&
    "dryRun" in first &&
    (first as { dryRun?: unknown }).dryRun === true
  );
}
