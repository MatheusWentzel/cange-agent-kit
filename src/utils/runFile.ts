import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CangeCliUsageError } from "../client/errors.js";

import { isFromDotenv } from "./env.js";

/**
 * C2 (onda 1, 14/10/2026): o arquivo que o agente sobe para o Cange vem SEMPRE da pasta
 * de rascunho da própria execução. O runner aponta o `TMPDIR` do agente para essa pasta
 * (`<workspace>/tmp`, apagada no fim do run); fora do runner vale o tmp do sistema.
 *
 * Regras (falham antes de qualquer chamada ao Cange, exit 2):
 *  - caminho com `..` é recusado, mesmo que caia dentro da pasta;
 *  - o caminho (absoluto, ou relativo à pasta de trabalho) tem de ficar dentro da pasta;
 *  - o arquivo real (link simbólico resolvido) também: link para fora não passa;
 *  - arquivo comum, não vazio, até `ATTACHMENT_UPLOAD_MAX_BYTES`.
 *
 * O `TMPDIR` só vale do ambiente do processo: um `.env` gravado pelo agente no
 * diretório não escolhe a pasta (mesma regra do dono do artefato).
 */

/** Teto do arquivo que o agente sobe (25 MB, o mesmo teto dos anexos do chat). */
export const ATTACHMENT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface RunFile {
  /** Caminho real do arquivo (links resolvidos). */
  realPath: string;
  /** Nome que o anexo recebe no Cange (o nome do caminho informado). */
  fileName: string;
  bytes: number;
  /** Pasta da execução que limitou o caminho. */
  root: string;
}

/**
 * M2 (review do Alex, onda 1): o kit está numa execução do runner? Alguma variável `RUNNER_*`
 * do ambiente do PROCESSO (o runner injeta `RUNNER_CARD_ID`, `RUNNER_AGENT_ID` etc.); um `.env`
 * no diretório não conta.
 */
export function underRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.entries(env).some(
    ([key, value]) => key.startsWith("RUNNER_") && typeof value === "string" && value.trim() !== "" && !isFromDotenv(key)
  );
}

/** Pastas temporárias do sistema: nunca são a pasta de uma execução. */
const SYSTEM_TMP_DIRS = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]);

/**
 * Pasta de onde o agente pode subir arquivos (e, sob o runner, para onde baixa).
 * M2: sob o runner, só o `TMPDIR` do processo vale, e ele tem de ser a pasta do run; sem
 * ele (ausente, relativo, vindo de `.env` ou o tmp do sistema) o comando falha fechado em
 * vez de cair no `/tmp` da máquina, que é dividido com outros runs.
 */
export function runFolder(env: NodeJS.ProcessEnv = process.env): string {
  const tmp = env.TMPDIR?.trim();
  const own = tmp && path.isAbsolute(tmp) && !isFromDotenv("TMPDIR") ? path.resolve(tmp) : undefined;
  if (underRunner(env)) {
    if (!own || SYSTEM_TMP_DIRS.has(own)) {
      throw new CangeCliUsageError(
        "Nada foi feito: nesta execução a pasta de arquivos (TMPDIR) não veio do runner, e o kit não usa o tmp do sistema. " +
          "Avise quem mantém o agente."
      );
    }
    return own;
  }
  if (tmp && path.isAbsolute(tmp)) return path.resolve(isFromDotenv("TMPDIR") ? "/tmp" : tmp);
  return path.resolve(os.tmpdir());
}

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

/** Confere e resolve o arquivo que o agente quer subir. Lança `CangeCliUsageError` (exit 2). */
export async function resolveRunFile(rawPath: string, options: { root?: string; maxBytes?: number } = {}): Promise<RunFile> {
  const given = String(rawPath ?? "").trim();
  if (given === "") {
    throw new CangeCliUsageError("Informe o arquivo em --file (caminho completo na pasta desta execução).");
  }
  const root = options.root ?? runFolder();
  const maxBytes = options.maxBytes ?? ATTACHMENT_UPLOAD_MAX_BYTES;

  if (given.split(/[\\/]+/).includes("..")) {
    throw new CangeCliUsageError(`Use o caminho completo do arquivo, sem "..": ${given}.`);
  }

  const lexical = path.resolve(given);
  const realRoot = await realpathOr(root);
  const insideLexical = isInside(lexical, root) || isInside(lexical, realRoot);
  if (!insideLexical) {
    throw new CangeCliUsageError(
      `O arquivo precisa estar na pasta desta execução (${root}). Grave o arquivo lá e passe o caminho completo em --file.`
    );
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(lexical);
  } catch {
    throw new CangeCliUsageError(`Arquivo não encontrado: ${given}. Grave o arquivo antes, em outro comando.`);
  }
  if (!isInside(realPath, realRoot)) {
    throw new CangeCliUsageError(
      `O arquivo ${given} aponta para fora da pasta desta execução (${root}): grave uma cópia do conteúdo dentro dela.`
    );
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new CangeCliUsageError(`${given} não é um arquivo comum.`);
  }
  if (stat.size === 0) {
    throw new CangeCliUsageError(`O arquivo ${given} está vazio.`);
  }
  if (stat.size > maxBytes) {
    throw new CangeCliUsageError(
      `O arquivo ${given} tem ${megabytes(stat.size)} MB e o limite para o agente é ${megabytes(maxBytes)} MB.`
    );
  }

  return { realPath, fileName: path.basename(lexical), bytes: stat.size, root };
}

/**
 * M3 (review do Alex, onda 1): pasta do `--out` de quem baixa arquivo. Sob o runner, só
 * dentro da pasta do run (`runFolder`): sem `..`, sem link para fora (a parte que já existe
 * do caminho é resolvida). Fora do runner, a pasta como veio. Lança `CangeCliUsageError`.
 */
export async function resolveRunOutDir(rawOut: string, options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const given = String(rawOut ?? "").trim();
  const env = options.env ?? process.env;
  if (options.root === undefined && !underRunner(env)) return given;
  const root = options.root ?? runFolder(env);
  if (given.split(/[\\/]+/).includes("..")) {
    throw new CangeCliUsageError(`Use o caminho completo da pasta, sem "..": ${given}.`);
  }
  const lexical = path.resolve(given);
  const realRoot = await realpathOr(root);
  const inside = (target: string, base: string): boolean => target === base || isInside(target, base);
  const outside = (): CangeCliUsageError =>
    new CangeCliUsageError(
      `A pasta do --out precisa estar na pasta desta execução (${root}): use, por exemplo, --out ${path.join(root, "anexos")}.`
    );
  if (!inside(lexical, root) && !inside(lexical, realRoot)) throw outside();
  // A parte do caminho que já existe não pode ser link para fora da pasta.
  let existing = lexical;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (!inside(real, realRoot)) throw outside();
      break;
    } catch (error) {
      if (error instanceof CangeCliUsageError) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return lexical;
}
