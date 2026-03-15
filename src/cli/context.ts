import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { authenticateKit, createCangeAgentKit, type CangeAgentKit } from "../index.js";
import { createCliPrinter, type CliPrinter, type OutputMode } from "../utils/output.js";

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
      if (options.requiresAuth ?? true) {
        await ctx.ensureAuth();
      }

      const output = await handler(ctx, ...args);
      if (output !== undefined) {
        ctx.printer.print(output);
      }
    } catch (error) {
      ctx.printer.printError(error);
      process.exitCode = 1;
    }
  };
}

async function createContext(command: Command): Promise<CliCommandContext> {
  const globalOptions = command.optsWithGlobals<{ output?: OutputMode }>();
  const outputModeFromFlag = globalOptions.output;
  if (outputModeFromFlag && outputModeFromFlag !== "json" && outputModeFromFlag !== "pretty") {
    throw new CangeCliUsageError("Valor inválido para --output. Use json ou pretty.");
  }

  const kit = createCangeAgentKit({
    configOverrides: {
      output: outputModeFromFlag
    }
  });

  const outputMode = outputModeFromFlag ?? kit.config.output;
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
