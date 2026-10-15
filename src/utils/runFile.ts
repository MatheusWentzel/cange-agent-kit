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

/** Pasta de onde o agente pode subir arquivos. */
export function runFolder(env: NodeJS.ProcessEnv = process.env): string {
  const tmp = env.TMPDIR?.trim();
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
