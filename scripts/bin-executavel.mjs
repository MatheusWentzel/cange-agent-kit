#!/usr/bin/env node
/**
 * Depois do `tsc`, marca como executável cada arquivo do `bin` do package.json.
 *
 * O `tsc` grava o `dist/cli/index.js` com 0644. Numa instalação NOVA o npm cria o
 * `node_modules/.bin/cange` e faz o chmod no alvo; numa TROCA de pin (dependência
 * git com o `.bin/cange` já apontando para o mesmo caminho) o npm pula o link e
 * também o chmod, e o `cange` vira "permission denied" (EACCES). Foi o que quebrou a
 * conferência automática do gate do runner local depois do pin em e074e84. Com o
 * bit gravado aqui, o pacote já sai do `prepare` executável e o npm preserva o modo.
 *
 * Uso: node scripts/bin-executavel.mjs [pasta-do-pacote]   (default: a pasta atual)
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Arquivos do `bin` (string ou mapa) do package.json da pasta. */
export function binFilesOf(packageDir) {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin ?? {};
  return Object.values(bin).map((file) => join(packageDir, file));
}

/** Liga o bit de execução (dono, grupo e outros) de cada bin; devolve os ajustados. */
export function markBinsExecutable(packageDir) {
  const fixed = [];
  for (const file of binFilesOf(packageDir)) {
    if (!existsSync(file)) throw new Error(`bin do package.json não existe depois do build: ${file}`);
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(file, mode | 0o111);
      fixed.push(file);
    }
  }
  return fixed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  markBinsExecutable(resolve(process.argv[2] ?? process.cwd()));
}
