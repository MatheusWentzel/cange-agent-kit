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

/** Mensagem de erro de uso e, quando há um só, o comando pronto (`suggestion` no JSON). */
export interface UsageExplanation {
  message: string;
  suggestion?: string;
}

/** Teto do comando pronto ecoado de volta (o argv inteiro pode trazer um texto longo). */
const MAX_SUGGESTION = 400;

/**
 * Sugestão (1 a 2 linhas) para o comando desconhecido em `argv` (o `process.argv`
 * inteiro). `undefined` quando o argv não tem comando desconhecido.
 */
export function suggestForUnknownCommand(program: Command, argv: readonly string[]): string | undefined {
  return explainUnknownCommand(program, argv)?.message;
}

/** {@link suggestForUnknownCommand} com o comando pronto separado em `suggestion`. */
export function explainUnknownCommand(program: Command, argv: readonly string[]): UsageExplanation | undefined {
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
      return { message: `${first}\n${SEARCH_SUGGESTION}` };
    }
    const replacement = replacementFor(program, current, token.toLowerCase()) ?? siblingByPrefix(current, token.toLowerCase());
    if (!replacement) return { message: `${first}\n${DISCOVERY_HINT}` };
    const before = tokens.slice(0, index);
    const after = tokens.slice(index + 1);
    const echo = [...before, replacement, ...after].map((arg, position) =>
      position === before.length ? arg : quoteArg(arg)
    );
    const full = `cange ${echo.join(" ")}`;
    if (full.length <= MAX_ARGS_ECHO) {
      return { message: `${first}\nVocê quis dizer: ${full}`, suggestion: full };
    }
    const short = `cange ${[...before.map(quoteArg), replacement].join(" ")} ...`;
    return { message: `${first}\nVocê quis dizer: ${short}` };
  }
  return undefined;
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

/** Mínimo de letras em comum no começo para sugerir o irmão (`entry` → `entries`). */
const MIN_COMMON_PREFIX = 4;

/** v9 (run 1131): o ÚNICO subcomando do nível que começa igual (4 letras ou mais). */
function siblingByPrefix(current: Command, word: string): string | undefined {
  const hits = subcommands(current).filter((child) =>
    [child.name(), ...child.aliases()].some((name) => commonPrefixLength(word, name.toLowerCase()) >= MIN_COMMON_PREFIX)
  );
  return hits.length === 1 ? hits[0]!.name() : undefined;
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

function cangePath(command: Command): string {
  const path = commandPath(command);
  return path ? `cange ${path}` : "cange";
}

// ---------------------------------------------------------------------------
// v9 (run 1131): valor solto e opção que o comando não tem ensinam o comando certo.
// Antes: "too many arguments for 'entries'" e "unknown option '--register-id'" com
// a rota genérica de discovery; o agente gastou 6 passos (manifest, jq) para achar
// `--register-id` e o `register entries` certo.
// ---------------------------------------------------------------------------

/** Opção conhecida no comando ou num ancestral (as globais, como --output, ficam no programa). */
function findOptionUp(command: Command, token: string): Option | undefined {
  let cursor: Command | null = command;
  while (cursor) {
    const option = findOption(cursor, token);
    if (option) return option;
    cursor = cursor.parent;
  }
  return undefined;
}

interface ArgvWalk {
  /** argv sem `node` e o script. */
  tokens: string[];
  /** O comando final que o argv chama. */
  command: Command;
  /** Como o comando final foi digitado (nome ou apelido). */
  typedName?: string;
  /** Valores sem opção, com a posição em `tokens`. */
  operands: Array<{ index: number; value: string }>;
}

/** Percorre o argv como o commander: desce nos subcomandos e separa valores de opções. */
function walkArgv(program: Command, argv: readonly string[]): ArgvWalk {
  const tokens = argv.slice(2);
  let current = program;
  let typedName: string | undefined;
  const operands: Array<{ index: number; value: string }> = [];
  let literal = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (literal) {
      operands.push({ index, value: token });
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token.length > 1 && token.startsWith("-")) {
      if (token.includes("=")) continue;
      const option = findOptionUp(current, token);
      if (!option) continue;
      if (option.variadic) {
        while (index + 1 < tokens.length && !tokens[index + 1]!.startsWith("-")) index += 1;
      } else if (option.required) {
        index += 1;
      } else if (option.optional && index + 1 < tokens.length && !tokens[index + 1]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (operands.length === 0 && subcommands(current).length > 0) {
      const next = findSubcommand(current, token);
      if (next) {
        current = next;
        typedName = token;
        continue;
      }
    }
    operands.push({ index, value: token });
  }
  return { tokens, command: current, typedName, operands };
}

function declaresLong(command: Command, long: string): boolean {
  return command.options.some((option) => option.long === long);
}

/** Até 12 opções do comando, para quando não há um comando pronto. */
const MAX_OPTIONS_LISTED = 12;

function optionsLine(command: Command): string {
  const longs = command.options.map((option) => option.long).filter((long): long is string => Boolean(long));
  if (longs.length === 0) return `${cangePath(command)} não tem opções.`;
  const shown = longs.slice(0, MAX_OPTIONS_LISTED).join(", ");
  return `Opções: ${shown}${longs.length > MAX_OPTIONS_LISTED ? ", ..." : ""}`;
}

/** O argv refeito como comando pronto; `undefined` quando fica longo demais para ecoar. */
function readyCommand(tokens: string[]): string | undefined {
  const full = `cange ${tokens.map(quoteArg).join(" ")}`;
  return full.length <= MAX_SUGGESTION ? full : undefined;
}

/** Ordem das opções de id que recebem um valor solto (`register entries 183`). */
export const ID_OPTION_ORDER: readonly string[] = [
  "--card-id",
  "--register-id",
  "--flow-id",
  "--entry-id",
  "--form-answer-id"
];

const POSITIVE_ID_RE = /^#?[1-9]\d*$/;

function looksLikeId(value: string): boolean {
  if (POSITIVE_ID_RE.test(value)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /(^|\.)cange\.me(\/|$)/i.test(value);
}

/**
 * A opção de id que recebe o valor solto: a 1a que o comando declara, na ordem
 * de {@link ID_OPTION_ORDER}. Chamado pelo apelido (`register entry 6507`), vale
 * primeiro a opção do apelido (`--entry-id`).
 */
function idOptionFor(walk: ArgvWalk): string | undefined {
  const { command, typedName } = walk;
  const order = [...ID_OPTION_ORDER];
  if (typedName && typedName !== command.name()) {
    const own = `--${typedName}-id`;
    if (declaresLong(command, own)) order.unshift(own);
  }
  return order.find((long) => declaresLong(command, long));
}

/** Valor solto (`commander.excessArguments`): o comando pronto com a opção de id, ou as opções. */
export function explainExcessArguments(program: Command, argv: readonly string[]): UsageExplanation | undefined {
  const walk = walkArgv(program, argv);
  const { command } = walk;
  const declared = command.registeredArguments;
  if (declared.some((argument) => argument.variadic)) return undefined;
  const stray = walk.operands.slice(declared.length);
  if (stray.length === 0) return undefined;

  const quoted = stray.map((item) => `"${item.value}"`).join(", ");
  const head = stray.length === 1 ? `Valor solto ${quoted}` : `Valores soltos ${quoted}`;
  const names = declared.map((argument) => `<${argument.name()}>`).join(" ");
  const rule =
    declared.length === 0
      ? "este comando não recebe valor sem opção."
      : `este comando recebe só ${declared.length === 1 ? "1 valor" : `${declared.length} valores`} sem opção (${names}).`;
  const first = `${head} em ${cangePath(command)}: ${rule}`;

  if (stray.length === 1 && looksLikeId(stray[0]!.value)) {
    const idOption = idOptionFor(walk);
    const alreadyGiven =
      idOption !== undefined && walk.tokens.some((token) => token === idOption || token.startsWith(`${idOption}=`));
    if (idOption && !alreadyGiven) {
      const value = stray[0]!.value.replace(/^#(?=\d)/, "");
      const tokens = [...walk.tokens];
      tokens.splice(stray[0]!.index, 1, idOption, value);
      const suggestion = readyCommand(tokens);
      if (suggestion) return { message: `${first}\nVocê quis dizer: ${suggestion}`, suggestion };
      return { message: `${first}\nUse ${idOption} ${quoteArg(value)} no lugar do valor solto.` };
    }
  }
  return { message: `${first}\n${optionsLine(command)}` };
}

/** Sinônimos de opção (os dois sentidos): o que o agente digita × o que o comando tem. */
const OPTION_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  "--register": ["--register-id"],
  "--register-id": ["--register"],
  "--card": ["--card-id"],
  "--card-id": ["--card"],
  "--flow": ["--flow-id"],
  "--flow-id": ["--flow"],
  "--entry": ["--entry-id"],
  "--entry-id": ["--entry"],
  "--q": ["--search"],
  "--query": ["--search", "--q"],
  "--search": ["--q"]
};

/** A opção certa: sinônimo que o comando declara, senão a única perto o bastante (edição). */
function optionReplacement(command: Command, flag: string): string | undefined {
  for (const synonym of OPTION_SYNONYMS[flag] ?? []) {
    if (declaresLong(command, synonym)) return synonym;
  }
  if (!flag.startsWith("--")) return undefined;
  const word = flag.slice(2);
  const limit = Math.max(1, Math.floor(word.length / 4));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const option of command.options) {
    if (!option.long) continue;
    const distance = editDistance(word, option.long.slice(2));
    if (distance < bestDistance) {
      best = option.long;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return best !== undefined && !tie && bestDistance <= limit ? best : undefined;
}

/** Comandos da árvore que declaram a opção (para "Quem aceita"). */
function commandsDeclaring(program: Command, flag: string): Command[] {
  const out: Command[] = [];
  const visit = (command: Command): void => {
    for (const child of subcommands(command)) {
      if (declaresLong(child, flag) && !out.includes(child)) out.push(child);
      visit(child);
    }
  };
  visit(program);
  return out;
}

/** Até 4 comandos em "Quem aceita --x". */
const MAX_OWNERS_LISTED = 4;

/** Opção que o comando não tem (`commander.unknownOption`). */
export function explainUnknownOption(program: Command, argv: readonly string[], flag: string): UsageExplanation {
  const walk = walkArgv(program, argv);
  const { command } = walk;
  const first = `${cangePath(command)} não tem a opção ${flag}.`;

  const replacement = optionReplacement(command, flag);
  const index = walk.tokens.findIndex((token) => token === flag || token.startsWith(`${flag}=`));
  if (replacement && index >= 0) {
    const tokens = [...walk.tokens];
    tokens[index] = `${replacement}${tokens[index]!.slice(flag.length)}`;
    const suggestion = readyCommand(tokens);
    if (suggestion) return { message: `${first}\nVocê quis dizer: ${suggestion}`, suggestion };
    return { message: `${first}\nUse ${replacement} no lugar de ${flag}.` };
  }

  const lines = [first, optionsLine(command)];
  const owners = commandsDeclaring(program, flag)
    .filter((owner) => owner !== command)
    .slice(0, MAX_OWNERS_LISTED);
  if (owners.length > 0) lines.push(`Quem aceita ${flag}: ${owners.map(cangePath).join(", ")}`);
  return { message: lines.join("\n") };
}

/**
 * O commander cobra a opção obrigatória ANTES de olhar as desconhecidas: com
 * `fields by-register --register 183` ele diz só "required option '--register-id'".
 * Se o argv tem uma opção desconhecida que é sinônimo ou quase a opção certa, a
 * explicação é a da opção desconhecida (com o comando pronto).
 */
export function explainMissingMandatory(program: Command, argv: readonly string[]): UsageExplanation | undefined {
  const walk = walkArgv(program, argv);
  for (const token of walk.tokens) {
    if (!token.startsWith("--") || token === "--") continue;
    const flag = token.split("=")[0]!;
    if (findOptionUp(walk.command, flag)) continue;
    if (optionReplacement(walk.command, flag)) return explainUnknownOption(program, argv, flag);
  }
  return undefined;
}

/** A opção do texto do commander: "error: unknown option '--x'". */
export function unknownOptionFlag(message: string): string | undefined {
  // `--entry=6507` chega inteiro no texto do commander: a opção é o que vem antes do "=".
  return /unknown option '([^']+)'/.exec(message)?.[1]?.split("=")[0];
}
