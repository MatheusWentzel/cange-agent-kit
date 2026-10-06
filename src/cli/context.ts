import { Command } from "commander";

import { CangeCliUsageError } from "../client/errors.js";
import { authenticateKit, createCangeAgentKit, type CangeAgentKit } from "../index.js";
import { createDryRunResult } from "../utils/dryRun.js";
import { loadEnv } from "../utils/env.js";
import { FORCED_WRITE_COMMANDS, isForceDryRun } from "../utils/forceDryRun.js";
import { resolveOutputProfile, type OutputProfile } from "../utils/lean.js";
import { createCliPrinter, type CliPrinter, type OutputMode } from "../utils/output.js";
import { encodeToon, ListOutput, listOutput, resolveOutputFormat, type OutputFormat } from "../utils/toon.js";

import { getCommandMeta } from "./command-metadata.js";
import { EXIT_CODES, exitCodeForError, type ExitCode } from "./exit-codes.js";
import { resolveOutputMode } from "./output-mode.js";
import { normalizeIdOptions, type CardLocator, type FlowResolution, type HashResolver } from "./resource-ref.js";

export interface CliCommandContext {
  kit: CangeAgentKit;
  printer: CliPrinter;
  outputMode: OutputMode;
  /**
   * Rodada 5: `lean` (padrão) = saída enxuta; `full` = formato de antes
   * (`--full` ou CANGE_OUTPUT_PROFILE=full).
   */
  profile: OutputProfile;
  /**
   * C4 (experimental): `toon` imprime as saídas de LISTA (as que o comando devolve
   * com `listOutput`) como tabela de texto. Padrão `json`; `--full` ignora o TOON.
   */
  format: OutputFormat;
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
      // CANGE_FORCE_DRY_RUN: toda escrita vira dry-run, seja qual for o argv.
      const forced = applyForcedDryRun(command, args);
      if (forced !== undefined) {
        printOutput(ctx, forced);
        return;
      }

      const requiresAuth = (options.requiresAuth ?? true) && !isDryRunInvocation(args);
      if (requiresAuth) {
        await ctx.ensureAuth();
      }

      // P7: ids de fluxo, cadastro e cartão aceitam número, link do Cange ou hash.
      // F6: cartão só pelo número, sem fluxo → o fluxo vem do GET /card/locate.
      const commandOptions = args.at(-2);
      let resolved: FlowResolution | undefined;
      if (commandOptions && typeof commandOptions === "object") {
        const authOnDemand = createAuthOnDemand(ctx, requiresAuth);
        ({ resolved } = await normalizeIdOptions(
          commandOptions as Record<string, unknown>,
          createHashResolver(ctx, authOnDemand),
          command,
          createCardLocator(ctx, authOnDemand)
        ));
      }

      const output = withResolution(await handler(ctx, ...args), resolved);
      if (output instanceof CliOutcome) {
        if (output.value !== undefined) {
          printOutput(ctx, output.value);
        }
        if (output.exitCode !== EXIT_CODES.SUCCESS) {
          process.exitCode = output.exitCode;
        }
        return;
      }
      if (output !== undefined) {
        printOutput(ctx, output);
      }
    } catch (error) {
      ctx.printer.printError(error);
      process.exitCode = exitCodeForError(error);
    }
  };
}

/**
 * Lista declarada (`listOutput`): TOON só com `--format toon` no perfil enxuto; no
 * resto, o envelope sai como JSON, igual a antes.
 */
function printOutput(ctx: CliCommandContext, value: unknown): void {
  if (value instanceof ListOutput) {
    if (ctx.format === "toon" && ctx.profile === "lean") {
      process.stdout.write(`${encodeToon(value)}\n`);
      return;
    }
    ctx.printer.print(value.envelope);
    return;
  }
  ctx.printer.print(value);
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
  const globalOptions = command.optsWithGlobals<{ output?: string; full?: boolean; format?: string }>();
  // TTY-aware: sem --output/CANGE_OUTPUT, json em pipe e pretty em terminal.
  const outputMode = resolveOutputMode(globalOptions.output);
  const profile = resolveOutputProfile(globalOptions.full);
  const format = resolveOutputFormat(globalOptions.format);

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
    format,
    ensureAuth: () => authenticateKit(kit)
  };
}

/**
 * Em dry-run a autenticação foi pulada: as leituras de resolução (hash, cartão)
 * autenticam aqui, uma vez, só quando precisam da rede.
 */
function createAuthOnDemand(ctx: CliCommandContext, alreadyAuthenticated: boolean): () => Promise<void> {
  let authenticated = alreadyAuthenticated;
  return async () => {
    if (authenticated) return;
    await ctx.ensureAuth();
    authenticated = true;
  };
}

/** Hash de fluxo/cadastro → id pelas rotas da tela (`GET /flow?hash=`, `GET /register?hash=`). */
function createHashResolver(ctx: CliCommandContext, ensureAuth: () => Promise<void>): HashResolver {
  return async (kind, hash) => {
    await ensureAuth();
    const result =
      kind === "flow" ? await ctx.kit.contracts.getFlow({ hash }) : await ctx.kit.contracts.getRegister({ hash });
    return result.summary.id;
  };
}

/**
 * Cartão → fluxo pelo `GET /card/locate` (F6). É leitura: vale também com
 * CANGE_FORCE_DRY_RUN (o cliente só recusa escrita).
 */
function createCardLocator(ctx: CliCommandContext, ensureAuth: () => Promise<void>): CardLocator {
  return async (cardId) => {
    await ensureAuth();
    return ctx.kit.contracts.locateCard({ cardId });
  };
}

/**
 * Fluxo descoberto pelo número do cartão: a saída diz de onde ele veio, em
 * `resolved`, para o agente (e quem audita o run) ver qual fluxo foi usado.
 */
function withResolution(output: unknown, resolved: FlowResolution | undefined): unknown {
  if (!resolved) return output;
  if (output instanceof CliOutcome) {
    return new CliOutcome(withResolution(output.value, resolved), output.exitCode);
  }
  if (output instanceof ListOutput) {
    return listOutput({ ...output.envelope, resolved }, output.listKey);
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), resolved };
  }
  return output;
}

function getCommandFromArgs(args: unknown[]): Command {
  const maybeCommand = args.at(-1);
  if (!maybeCommand || !(maybeCommand instanceof Command)) {
    throw new CangeCliUsageError("Falha interna ao resolver contexto do comando.");
  }
  return maybeCommand;
}

/**
 * Com `CANGE_FORCE_DRY_RUN` ligado: comando com `--dry-run` recebe `dryRun = true`
 * (o handler segue o próprio caminho de dry-run); escrita sem `--dry-run`
 * (FORCED_WRITE_COMMANDS ou `mutates` no metadado) devolve o dry-run genérico SEM
 * rodar o handler. Leitura segue normal. `undefined` = rodar o handler.
 */
function applyForcedDryRun(command: Command, args: unknown[]): unknown {
  if (!isForceDryRun()) return undefined;
  const options = args.at(-2);
  if (command.options.some((option) => option.long === "--dry-run")) {
    if (options && typeof options === "object") {
      (options as { dryRun?: boolean }).dryRun = true;
    }
    return undefined;
  }
  const path = commandPath(command);
  if (!FORCED_WRITE_COMMANDS.has(path) && getCommandMeta(command)?.mutates !== true) return undefined;
  const positional = args.slice(0, -2);
  return createDryRunResult({
    command: `cange ${path}`,
    ...(positional.length > 0 ? { args: positional } : {}),
    options: options && typeof options === "object" ? { ...(options as Record<string, unknown>) } : {}
  });
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let cursor: Command | null = command;
  while (cursor && cursor.parent) {
    names.unshift(cursor.name());
    cursor = cursor.parent;
  }
  return names.join(" ");
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
