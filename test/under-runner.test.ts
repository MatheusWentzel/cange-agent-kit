import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUNNER_CONTEXT_ENV_KEYS, runFolder, underRunner } from "../src/utils/runFile.js";

/**
 * Onda 3 (A2): o kit só se considera numa execução do runner com uma variável que o
 * runner do Cange põe no ambiente do agente. As `RUNNER_*` do GitHub Actions (e de
 * qualquer outra ferramenta) não contam: antes, `RUNNER_OS` sozinho fazia o upload
 * exigir a pasta do run e falhar num workflow.
 */

/** O que o GitHub Actions define em todo job (nomes públicos da documentação). */
const GITHUB_ACTIONS_ENV: NodeJS.ProcessEnv = {
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "X64",
  RUNNER_NAME: "GitHub Actions 2",
  RUNNER_TEMP: "/home/runner/work/_temp",
  RUNNER_TOOL_CACHE: "/opt/hostedtoolcache",
  RUNNER_WORKSPACE: "/home/runner/work/repo",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_DEBUG: "1",
  RUNNER_TRACKING_ID: "github_abc"
};

describe("underRunner: só as variáveis do runner do Cange", () => {
  it("RUNNER_OS sozinho: fora do runner", () => {
    expect(underRunner({ RUNNER_OS: "Linux" })).toBe(false);
  });

  it("RUNNER_TEMP sozinho: fora do runner", () => {
    expect(underRunner({ RUNNER_TEMP: "/home/runner/work/_temp" })).toBe(false);
  });

  it("ambiente completo do GitHub Actions: fora do runner", () => {
    expect(underRunner(GITHUB_ACTIONS_ENV)).toBe(false);
  });

  it("variável de configuração do processo do runner (não é contexto de run): fora", () => {
    expect(underRunner({ RUNNER_EFFORT: "high", RUNNER_PROMPT_CACHE_TTL: "1h" })).toBe(false);
  });

  it.each(RUNNER_CONTEXT_ENV_KEYS.map((key) => [key]))("%s preenchida: dentro do runner", (key) => {
    expect(underRunner({ [key]: "55" })).toBe(true);
    expect(underRunner({ ...GITHUB_ACTIONS_ENV, [key]: "55" })).toBe(true);
  });

  it("a lista cobre o que o runner injeta em cada tipo de run", () => {
    // run de cartão (runOnce/resume) e conversa/rotina (runChatOnce) no cange-agent-runner
    expect(RUNNER_CONTEXT_ENV_KEYS).toEqual(
      expect.arrayContaining(["RUNNER_CARD_ID", "RUNNER_FLOW_ID", "RUNNER_STEP_ID", "RUNNER_CHAT_SESSION_ID"])
    );
  });

  it("variável do runner vazia ou só com espaço: fora do runner", () => {
    expect(underRunner({ RUNNER_CARD_ID: "", RUNNER_CHAT_SESSION_ID: "   " })).toBe(false);
  });
});

describe("runFolder: no GitHub Actions usa o tmp normal, sob o runner exige a pasta do run", () => {
  it("GitHub Actions sem TMPDIR: tmp do sistema, sem erro", () => {
    expect(runFolder({ ...GITHUB_ACTIONS_ENV })).toBe(resolve(tmpdir()));
  });

  it("GitHub Actions com TMPDIR = /tmp: aceita (não é execução do runner)", () => {
    expect(runFolder({ ...GITHUB_ACTIONS_ENV, TMPDIR: "/tmp" })).toBe("/tmp");
  });

  it("runner sem TMPDIR: falha fechado (exit 2)", () => {
    expect(() => runFolder({ RUNNER_CHAT_SESSION_ID: "321" })).toThrow(/TMPDIR/);
  });

  it("runner com TMPDIR = /tmp do sistema: falha fechado", () => {
    expect(() => runFolder({ RUNNER_CARD_ID: "55", TMPDIR: "/tmp" })).toThrow(/TMPDIR/);
  });

  it("runner com a pasta do run: usa ela", () => {
    expect(runFolder({ RUNNER_CARD_ID: "55", TMPDIR: "/srv/run-1/tmp" })).toBe("/srv/run-1/tmp");
  });
});

describe("underRunner: variável do runner vinda do .env do diretório não conta", () => {
  let dir = "";

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.RUNNER_CARD_ID;
    dir = await mkdtemp(join(tmpdir(), "kit-under-runner-"));
  });

  afterEach(async () => {
    delete process.env.RUNNER_CARD_ID;
    await rm(dir, { recursive: true, force: true });
  });

  it("RUNNER_CARD_ID só no .env: fora do runner", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "RUNNER_CARD_ID=999\n", "utf8");
    const env = await import("../src/utils/env.js");
    const runFile = await import("../src/utils/runFile.js");
    env.loadEnv(envPath);
    expect(process.env.RUNNER_CARD_ID).toBe("999");
    expect(runFile.underRunner(process.env)).toBe(false);
  });
});
