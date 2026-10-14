/**
 * Regressão do pin e074e84 no runner local: a troca de pin de uma dependência git
 * com o `node_modules/.bin/cange` já existente faz o npm pular o link E o chmod, e o
 * `dist/cli/index.js` que o `tsc` grava com 0644 vira "permission denied" (EACCES).
 * O gate do runner chama `cange` sem shell e cada conferência falhava em 2 ms, logada
 * como "o kit não respondeu no prazo". O build (e o `prepare` da instalação git)
 * agora marca o bin como executável; estes testes travam o script e a ligação dele.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "bin-executavel.mjs");
const CLI = join(ROOT, "dist", "cli", "index.js");

describe("bin executável depois do build (EACCES na troca de pin)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-bin-x-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("o script liga o bit de execução de cada bin do package.json (mapa e string)", () => {
    const pkg = join(dir, "mapa");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "x", bin: { a: "dist/cli/index.js", b: "dist/b.js" } }));
    writeFileSync(join(pkg, "dist", "cli", "index.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(pkg, "dist", "b.js"), "#!/usr/bin/env node\n");
    chmodSync(join(pkg, "dist", "cli", "index.js"), 0o644);
    chmodSync(join(pkg, "dist", "b.js"), 0o600);

    execFileSync(process.execPath, [SCRIPT, pkg]);

    expect(statSync(join(pkg, "dist", "cli", "index.js")).mode & 0o777).toBe(0o755);
    expect(statSync(join(pkg, "dist", "b.js")).mode & 0o777).toBe(0o711);

    const single = join(dir, "string");
    mkdirSync(single, { recursive: true });
    writeFileSync(join(single, "package.json"), JSON.stringify({ name: "y", bin: "cli.js" }));
    writeFileSync(join(single, "cli.js"), "#!/usr/bin/env node\n");
    chmodSync(join(single, "cli.js"), 0o644);
    execFileSync(process.execPath, [SCRIPT, single]);
    expect(statSync(join(single, "cli.js")).mode & 0o111).toBe(0o111);
  });

  it("bin ausente depois do build falha alto (não deixa passar um pacote sem o `cange`)", () => {
    const pkg = join(dir, "sem-bin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "z", bin: { cange: "dist/cli/index.js" } }));
    expect(() => execFileSync(process.execPath, [SCRIPT, pkg], { stdio: "pipe" })).toThrow();
  });

  it("o build e o prepare (instalação git) rodam o script depois do tsc", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const name of ["build", "prepare"]) {
      expect(scripts[name]).toMatch(/tsc -p tsconfig\.build\.json && node scripts\/bin-executavel\.mjs$/);
    }
  });

  // Integração: o dist buildado (o CI builda antes de testar). Sem chmod no teste, ao
  // contrário do teste do symlink: é exatamente o modo que o pacote leva ao runner.
  it.skipIf(!existsSync(CLI))("o dist/cli/index.js buildado sai executável", () => {
    expect(statSync(CLI).mode & 0o111).toBe(0o111);
  });
});
