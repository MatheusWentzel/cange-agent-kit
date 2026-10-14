/**
 * TOON EXPERIMENTAL (card #1367459, C4): lista homogênea em tabela de texto, com o
 * cabeçalho UMA vez e uma linha por item. O JSON repete o nome de cada chave em
 * cada item; numa lista de 20 cartões isso é a maior parte do texto relido pelo
 * agente a cada turno.
 *
 * Formato:
 *   total: 42
 *   summaries[2]{cardId,title,stepName}:
 *     1001,Pedido ACME,Priorizados
 *     1002,"Pedido, com vírgula",Em execução
 *
 * Regras: escalares do envelope em `chave: valor` antes da tabela; colunas = união
 * das chaves dos itens, na ordem em que aparecem; valor ausente = vazio; valor
 * com vírgula, aspas, quebra de linha ou espaço nas pontas vai entre aspas (aspas
 * e quebra escapadas como em JSON); objeto ou lista dentro do item vira JSON.
 *
 * Desligado por padrão: `--format toon` ou `CANGE_OUTPUT_FORMAT=toon`. Só vale nos
 * comandos de LISTA que o declaram (os outros seguem em JSON).
 */

import { CangeCliUsageError } from "../client/errors.js";

export type OutputFormat = "json" | "toon";

/** `--format` vence; senão `CANGE_OUTPUT_FORMAT`; o padrão é JSON. */
export function resolveOutputFormat(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env
): OutputFormat {
  if (flag !== undefined) {
    const value = flag.trim().toLowerCase();
    if (value !== "json" && value !== "toon") {
      throw new CangeCliUsageError(`--format inválido: "${flag}". Use json ou toon.`);
    }
    return value;
  }
  return env.CANGE_OUTPUT_FORMAT?.trim().toLowerCase() === "toon" ? "toon" : "json";
}

/** Saída de lista que pode virar TOON: o envelope JSON e a chave da lista dentro dele. */
export class ListOutput {
  public constructor(
    public readonly envelope: Record<string, unknown>,
    public readonly listKey: string
  ) {}
}

export function listOutput(envelope: Record<string, unknown>, listKey: string): ListOutput {
  return new ListOutput(envelope, listKey);
}

function needsQuotes(text: string): boolean {
  return text === "" || /[,"\n\r]/.test(text) || text !== text.trim();
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return needsQuotes(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return needsQuotes(json) ? JSON.stringify(json) : json;
}

function scalarLine(key: string, value: unknown): string {
  return `${key}: ${cell(value)}`;
}

export function encodeToon(output: ListOutput): string {
  const { envelope, listKey } = output;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(envelope)) {
    if (key === listKey || value === undefined) continue;
    lines.push(scalarLine(key, value));
  }

  const rawList = envelope[listKey];
  const items = Array.isArray(rawList) ? rawList : [];
  const columns: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    for (const key of Object.keys(item)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  lines.push(`${listKey}[${items.length}]{${columns.join(",")}}:`);
  for (const item of items) {
    const record = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    lines.push(`  ${columns.map((column) => cell(record[column])).join(",")}`);
  }
  return lines.join("\n");
}
