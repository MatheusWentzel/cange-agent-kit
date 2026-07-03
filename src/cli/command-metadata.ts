import type { Command, Option } from "commander";

/**
 * Convenção de envelope de saída dos comandos de LEITURA do kit.
 * Documentada aqui (fonte única) e exposta no manifesto (item 7).
 */
export const ENVELOPE_CONVENTION =
  "Comandos de leitura retornam um objeto JSON. O dado enriquecido/normalizado " +
  "para consumo vive na coleção primária do comando (ex.: `summaries`, `views`, " +
  "`fields`, `summary`); `raw` (quando presente) é a resposta crua da API; `total` " +
  "é a contagem. Campos legíveis (ex.: stepName, fieldValues) vivem na coleção " +
  "enriquecida, NUNCA em `raw`. Comandos de query V2 adicionam `engine`, `totalCount`, " +
  "`truncated` e `executionStats`.";

export interface CommandMeta {
  /** Descrição textual do envelope de saída (o shape que o comando retorna). */
  envelope?: string;
  /** Onde vivem os campos-chave (ex.: "stepName/fieldValues em summaries[]"). */
  fieldsLocation?: string;
  /** 1 exemplo real de invocação. */
  example?: string;
  /** 1 exemplo enxuto de saída (shape, não dump). */
  outputExample?: unknown;
  /** Marca comando de mutação. */
  mutates?: boolean;
  /** Se deprecado, o caminho canônico a usar. */
  deprecatedInFavorOf?: string;
}

const META = new WeakMap<Command, CommandMeta>();

/**
 * Anexa metadados a um comando. Fonte ÚNICA que alimenta tanto o `--help`
 * auto-descritivo (item 5) quanto o `manifest` (item 4) — evita drift.
 */
export function annotateCommand(cmd: Command, meta: CommandMeta): Command {
  META.set(cmd, { ...(META.get(cmd) ?? {}), ...meta });

  const lines: string[] = [];
  if (meta.mutates) {
    lines.push("⚠️  MUTAÇÃO: altera dados no Cange.");
  }
  if (meta.deprecatedInFavorOf) {
    lines.push(`⚠️  DEPRECATED — use \`${meta.deprecatedInFavorOf}\`.`);
  }
  if (meta.envelope) {
    lines.push(`Envelope de saída: ${meta.envelope}`);
  }
  if (meta.fieldsLocation) {
    lines.push(`Campos-chave: ${meta.fieldsLocation}`);
  }
  if (meta.outputExample !== undefined) {
    lines.push(`Exemplo de saída: ${JSON.stringify(meta.outputExample)}`);
  }
  if (meta.example) {
    lines.push(`Exemplo: ${meta.example}`);
  }
  if (lines.length > 0) {
    cmd.addHelpText("after", `\n${lines.join("\n")}\n`);
  }
  return cmd;
}

export function getCommandMeta(cmd: Command): CommandMeta | undefined {
  return META.get(cmd);
}

export interface ManifestOption {
  flags: string;
  description?: string;
  /** A flag em si é obrigatória (requiredOption). */
  mandatory: boolean;
  /** A flag recebe valor (`<x>`). */
  takesValue: boolean;
  defaultValue?: unknown;
}

export interface ManifestCommand {
  path: string;
  name: string;
  description?: string;
  mutates?: boolean;
  deprecatedInFavorOf?: string;
  options: ManifestOption[];
  envelope?: string;
  fieldsLocation?: string;
  example?: string;
  outputExample?: unknown;
  subcommands: ManifestCommand[];
}

export interface Manifest {
  cli: string;
  version: string;
  envelopeConvention: string;
  globalOptions: ManifestOption[];
  discovery: string;
  commands: ManifestCommand[];
}

function describeOption(option: Option): ManifestOption {
  const out: ManifestOption = {
    flags: option.flags,
    mandatory: option.mandatory === true,
    takesValue: option.required === true || option.optional === true
  };
  if (option.description) {
    out.description = option.description;
  }
  if (option.defaultValue !== undefined) {
    out.defaultValue = option.defaultValue;
  }
  return out;
}

function walkCommand(cmd: Command, parentPath: string): ManifestCommand {
  const name = cmd.name();
  const path = parentPath ? `${parentPath} ${name}` : name;
  const meta = getCommandMeta(cmd) ?? {};

  const node: ManifestCommand = {
    path,
    name,
    options: cmd.options.map(describeOption),
    subcommands: cmd.commands.map((child) => walkCommand(child, path))
  };
  const description = cmd.description();
  if (description) {
    node.description = description;
  }
  if (meta.mutates !== undefined) node.mutates = meta.mutates;
  if (meta.deprecatedInFavorOf !== undefined) node.deprecatedInFavorOf = meta.deprecatedInFavorOf;
  if (meta.envelope !== undefined) node.envelope = meta.envelope;
  if (meta.fieldsLocation !== undefined) node.fieldsLocation = meta.fieldsLocation;
  if (meta.example !== undefined) node.example = meta.example;
  if (meta.outputExample !== undefined) node.outputExample = meta.outputExample;
  return node;
}

/**
 * Gera o manifesto percorrendo a árvore viva do commander — 100% dos comandos,
 * sem lista mantida à mão (item 4). O caminho de cada comando já vem pronto
 * para invocação (`cange <path> [flags]`).
 */
export function buildManifest(program: Command): Manifest {
  return {
    cli: program.name(),
    version: program.version() ?? "0.0.0",
    envelopeConvention: ENVELOPE_CONVENTION,
    discovery:
      "Use `cange manifest --output json` (esta saída) como fonte de verdade. " +
      "Para detalhe/ajuda de um comando: `cange <path> --help`.",
    globalOptions: program.options.map(describeOption),
    commands: program.commands
      .map((child) => walkCommand(child, ""))
      .filter((child) => child.name !== "help")
  };
}
