import type { Command } from "commander";

import { commandPath, walkArgv } from "./command-suggest.js";

/**
 * Onda 4 (B1, N6 da análise de produção de 06 a 28/10): opções com nome errado que os
 * agentes repetem e que têm UM equivalente certo no mesmo comando. O alias troca o nome
 * antes do commander ler o argv e o comando roda sem aviso (não gasta um turno com o
 * erro). Fica fora das opções declaradas: o `--help` e o `manifest` mostram só o nome
 * oficial. Sem equivalente inequívoco, vale a mensagem de "não tem a opção" de sempre.
 *
 * Erros que motivam (produção, 06 a 28/10): `register entries --limit` 2 vezes,
 * `comment create --mentions` 1, `card get --fields` 1 (5 no texto do erro) e
 * `recipe anexo --input`/`--pdf` (A202, depois de baixar o PDF).
 */
interface OptionAlias {
  /** A opção oficial do comando. */
  to: string;
  /** Só troca quando o valor serve na opção oficial (senão vale a mensagem de sempre). */
  accepts?: (value: string) => boolean;
}

/** Lista de ids numéricos separados por vírgula (`20,30`). */
function isIdList(value: string): boolean {
  return /^\s*\d+\s*(,\s*\d+\s*)*$/.test(value);
}

/** Comando (caminho sem `cange`) → opção errada → opção oficial. */
export const OPTION_ALIASES: Readonly<Record<string, Readonly<Record<string, OptionAlias>>>> = Object.freeze({
  "register entries": { "--limit": { to: "--page-size" } },
  "comment create": { "--mentions": { to: "--mention" } },
  // `card get --field-ids` filtra pelo id do campo. Título no `--fields` é o `card read --fields`:
  // não é o mesmo pedido, então só troca quando o valor é lista de ids.
  "card get": { "--fields": { to: "--field-ids", accepts: isIdList } },
  recipe: { "--input": { to: "--file" }, "--pdf": { to: "--file" } }
});

/**
 * O argv com as opções erradas trocadas pela oficial (`--x valor` e `--x=valor`). Nada
 * muda quando o comando não tem alias ou a opção já existe nele.
 */
export function applyOptionAliases(program: Command, argv: readonly string[]): string[] {
  const out = [...argv];
  let walk;
  try {
    walk = walkArgv(program, argv);
  } catch {
    return out;
  }
  const aliases = OPTION_ALIASES[commandPath(walk.command)];
  if (!aliases) return out;
  const offset = argv.length - walk.tokens.length;
  for (const index of walk.unknownFlags) {
    const token = walk.tokens[index]!;
    const eq = token.indexOf("=");
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const alias = aliases[flag];
    if (!alias) continue;
    const value = eq > 0 ? token.slice(eq + 1) : walk.tokens[index + 1];
    if (alias.accepts && (value === undefined || !alias.accepts(value))) continue;
    out[index + offset] = eq > 0 ? `${alias.to}${token.slice(eq)}` : alias.to;
  }
  return out;
}
