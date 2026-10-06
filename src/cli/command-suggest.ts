import type { Command, Option } from "commander";

/**
 * P7 (05/10, card #1367450): comando ou subcomando que não existe responde com a
 * sugestão mais provável, em 1 a 2 linhas, em vez do erro seco do commander.
 * Em produção: `search` 4×, `register-entries`, `automation`.
 *
 * Ordem: (1) casos fixos; (2) hífen no lugar do espaço (`register-entries` →
 * `register entries`); (3) subcomando de um grupo só, chamado na raiz
 * (`entries` → `register entries`); (4) distância de edição entre os comandos do
 * nível, quando há um único mais próximo. Sem sugestão clara: rota de discovery.
 * O exit code continua o de erro de uso (2).
 */

export const DISCOVERY_HINT =
  "Descubra os comandos disponíveis: `cange manifest --output json` (fonte de verdade) " +
  "ou `cange <grupo> --help`.";

export const SEARCH_SUGGESTION =
  "Para buscar entradas de cadastro: cange register entries --register <id> --search <texto>. " +
  "Para achar fluxo ou cadastro pelo nome: cange catalog --q <texto>.";

/** Palavras que o agente usa para "buscar" e que não são comando. */
const SEARCH_WORDS = new Set(["search", "buscar", "busca", "find", "procurar", "pesquisar"]);

const MAX_ARGS_ECHO = 200;

function subcommands(command: Command): Command[] {
  return command.commands.filter((child) => child.name() !== "help");
}

function findSubcommand(command: Command, word: string): Command | undefined {
  return subcommands(command).find((child) => child.name() === word || child.aliases().includes(word));
}

function findOption(command: Command, token: string): Option | undefined {
  return command.options.find((option) => option.long === token || option.short === token);
}

/** Levenshtein (inserção, remoção, troca), suficiente para nomes curtos de comando. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** O único nome mais próximo, se estiver perto o bastante. Empate = sem sugestão. */
function closestName(word: string, names: string[]): string | undefined {
  const limit = Math.max(1, Math.floor(word.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const name of names) {
    const distance = editDistance(word, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return best !== undefined && !tie && bestDistance <= limit ? best : undefined;
}

/** O que trocar no lugar da palavra desconhecida (1 ou 2 palavras), ou nada. */
function replacementFor(program: Command, current: Command, word: string): string | undefined {
  // `register-entries` → `register entries` (e `flow-views-list` → `flow views list`).
  const parts = word.split("-");
  for (let cut = 1; cut < parts.length; cut += 1) {
    const group = findSubcommand(current, parts.slice(0, cut).join("-"));
    if (!group) continue;
    const rest = parts.slice(cut).join("-");
    const child = findSubcommand(group, rest);
    if (child) return `${group.name()} ${child.name()}`;
    const deeper = replacementFor(program, group, rest);
    if (deeper) return `${group.name()} ${deeper}`;
  }

  // `cange entries` → `cange register entries` (só quando um grupo só tem esse subcomando).
  if (current === program) {
    const owners = subcommands(program).filter((group) => findSubcommand(group, word));
    if (owners.length === 1) return `${owners[0]!.name()} ${word}`;
  }

  return closestName(word, subcommands(current).map((child) => child.name()));
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./<>-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Sugestão (1 a 2 linhas) para o comando desconhecido em `argv` (o `process.argv`
 * inteiro). `undefined` quando o argv não tem comando desconhecido.
 */
export function suggestForUnknownCommand(program: Command, argv: readonly string[]): string | undefined {
  const tokens = argv.slice(2);
  let current = program;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") return undefined;
    if (token.startsWith("-")) {
      if (!token.includes("=")) {
        const option = findOption(current, token) ?? findOption(program, token);
        if (option && (option.required || option.optional)) index += 1;
      }
      continue;
    }
    if (subcommands(current).length === 0) return undefined;
    const next = findSubcommand(current, token);
    if (next) {
      current = next;
      continue;
    }

    const where = current === program ? "" : ` em cange ${commandPath(current)}`;
    const first = `Comando "${token}" não existe${where}.`;
    if (SEARCH_WORDS.has(token.toLowerCase())) {
      return `${first}\n${SEARCH_SUGGESTION}`;
    }
    const replacement = replacementFor(program, current, token.toLowerCase());
    if (!replacement) return `${first}\n${DISCOVERY_HINT}`;
    const before = tokens.slice(0, index);
    const after = tokens.slice(index + 1);
    const echo = [...before, replacement, ...after].map((arg, position) =>
      position === before.length ? arg : quoteArg(arg)
    );
    const full = `cange ${echo.join(" ")}`;
    const suggestion =
      full.length <= MAX_ARGS_ECHO ? full : `cange ${[...before.map(quoteArg), replacement].join(" ")} ...`;
    return `${first}\nVocê quis dizer: ${suggestion}`;
  }
  return undefined;
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
