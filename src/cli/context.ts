import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { authenticateKit, createCangeAgentKit, type CangeAgentKit } from "../index.js";
import { loadEnv } from "../utils/env.js";
import { resolveOutputProfile, type OutputProfile } from "../utils/lean.js";
import { createCliPrinter, type CliPrinter, type OutputMode } from "../utils/output.js";

import { EXIT_CODES, exitCodeForError, type ExitCode } from "./exit-codes.js";
import { resolveOutputMode } from "./output-mode.js";

export interface CliCommandContext {
  kit: CangeAgentKit;
  printer: CliPrinter;
  outputMode: OutputMode;
  /**
   * Rodada 5: `lean` (padrão) = saída enxuta; `full` = formato de antes
   * (`--full` ou CANGE_OUTPUT_PROFILE=full).
   */
  profile: OutputProfile;
  ensureAuth: () => Promise<{ token: string; source: "access-token-env" | "session-login"; raw?: unknown }>;
}

type CommandHandler<TArgs extends unknown[]> = (ctx: CliCommandContext, ...args: TArgs) => Promise<unknown>;

/**
 * Saída de comando que precisa TERMINAR COM EXIT CODE ≠ 0 sem ser um erro:
 * o lote parcial (parte dos itens processada, parte não). O dado vai para
 * stdout como sempre; o exit code é o que impede o chamador de tratar o
 * resultado incompleto como sucesso (achado A4).
 */
export class CliOutcome {
  public constructor(
    public readonly value: unknown,
    public readonly exitCode: ExitCode
  ) {}
}

export function withExitCode(value: unknown, exitCode: ExitCode): CliOutcome {
  return new CliOutcome(value, exitCode);
}

export function createCommandAction<TArgs extends unknown[]>(
  handler: CommandHandler<TArgs>,
  options: { requiresAuth?: boolean } = {}
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    const command = getCommandFromArgs(args);
    propagateGlobalFull(command, args);
    const ctx = await createContext(command);

    try {
      const requiresAuth = (options.requiresAuth ?? true) && !isDryRunInvocation(args);
      if (requiresAuth) {
        await ctx.ensureAuth();
      }

      const output = await handler(ctx, ...args);
      if (output instanceof CliOutcome) {
        if (output.value !== undefined) {
          ctx.printer.print(output.value);
        }
        if (output.exitCode !== EXIT_CODES.SUCCESS) {
          process.exitCode = output.exitCode;
        }
        return;
      }
      if (output !== undefined) {
        ctx.printer.print(output);
      }
    } catch (error) {
      ctx.printer.printError(error);
      process.exitCode = exitCodeForError(error);
    }
  };
}

/**
 * Rodada 5: `--full` virou opção GLOBAL (formato completo de antes). O commander
 * entrega a opção global ao programa mesmo quando ela vem depois do subcomando,
 * então quem já tinha um `--full` próprio (`card create`, `comment list`,
 * `artifact publish`) deixaria de vê-lo. Aqui ele volta para as opções do
 * subcomando: `comment list --full` continua com o texto completo.
 */
function propagateGlobalFull(command: Command, args: unknown[]): void {
  const globals = command.optsWithGlobals<{ full?: boolean }>();
  if (globals.full !== true) return;
  if (!command.options.some((option) => option.long === "--full")) return;
  const options = args.at(-2);
  if (options && typeof options === "object") {
    (options as { full?: boolean }).full = true;
  }
}

async function createContext(command: Command): Promise<CliCommandContext> {
  // R5-KR-01: o `.env` do diretório tem de estar carregado ANTES de resolver
  // CANGE_OUTPUT e CANGE_OUTPUT_PROFILE (é por ele que os agentes locais
  // configuram o kit). O createCangeAgentKit carregava tarde demais. O loadEnv
  // carrega uma vez por processo e não sobrescreve o ambiente de quem chamou.
  loadEnv();
  const globalOptions = command.optsWithGlobals<{ output?: string; full?: boolean }>();
  // TTY-aware: sem --output/CANGE_OUTPUT, json em pipe e pretty em terminal.
  const outputMode = resolveOutputMode(globalOptions.output);
  const profile = resolveOutputProfile(globalOptions.full);

  const kit = createCangeAgentKit({
    configOverrides: {
      output: outputMode
    }
  });

  const printer = createCliPrinter(outputMode, profile);

  return {
    kit,
    printer,
    outputMode,
    profile,
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
