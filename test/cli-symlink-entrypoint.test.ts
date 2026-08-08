/**
 * Regressão do commit 8c572af: a detecção de "invocado como main" foi simplificada
 * para `import.meta.url === `file://${process.argv[1]}``, que FALHA quando o CLI é
 * chamado pelo SYMLINK `node_modules/.bin/cange` (o bin do package.json, como o
 * runner/agente invoca). Resultado: `runCli()` não roda → TODOS os comandos saíam
 * VAZIOS (stdout/stderr vazios, exit 0). Este teste roda o CLI buildado tanto DIRETO
 * quanto via SYMLINK e exige saída não-vazia nos dois — trava a regressão.
 *
 * Depende do `dist` buildado (é integração do entrypoint real). Se `dist` não existir
 * (checkout sem build), o teste é pulado — o CI builda antes de testar.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli", "index.js");

describe("CLI entrypoint — robusto a symlink (regressão 8c572af)", () => {
  it.skipIf(!existsSync(CLI))(
    "`manifest` produz saída tanto DIRETO quanto via SYMLINK (.bin/cange)",
    () => {
      chmodSync(CLI, 0o755);

      // Invocação DIRETA: `node dist/cli/index.js manifest` (o `pnpm cli`).
      const direct = execFileSync(process.execPath, [CLI, "manifest"], { encoding: "utf8" });
      expect(direct).toContain('"cli"');

      // Invocação via SYMLINK: exatamente como o `node_modules/.bin/cange` do runner.
      const link = join(tmpdir(), `cange-cli-symlink-${process.pid}`);
      rmSync(link, { force: true });
      symlinkSync(CLI, link);
      try {
        const viaLink = execFileSync(link, ["manifest"], { encoding: "utf8" });
        // Se `runCli()` não rodar (a regressão), `viaLink` é VAZIO.
        expect(viaLink.trim().length).toBeGreaterThan(0);
        expect(viaLink).toContain('"cli"');
      } finally {
        rmSync(link, { force: true });
      }
    }
  );
});
