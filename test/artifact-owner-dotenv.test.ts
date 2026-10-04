import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RK-2 (30/09): o CLI carrega o `.env` do diretório (dotenv, em
// createCangeAgentKit) ANTES de resolver o dono do `artifact publish`. No chat
// sem cartão o runner tira RUNNER_CARD_ID/CANGE_CARD_ID do ambiente; um `.env`
// gravado pelo agente no workspace recolocava o cartão e o kit publicava nele
// (o gate tinha aprovado "na conversa"). O dono só vale do ambiente do processo.
//
// `loadEnv` carrega uma vez por processo: cada teste reimporta os módulos
// (`vi.resetModules`) para começar com o carregamento zerado.

const KEYS = ["RUNNER_CARD_ID", "CANGE_CARD_ID", "RUNNER_CHAT_SESSION_ID", "RUNNER_FLOW_ID"] as const;
let dir = "";

function clearKeys(): void {
  for (const key of KEYS) delete process.env[key];
}

async function writeDotenv(content: string): Promise<string> {
  const file = join(dir, ".env");
  await writeFile(file, content, "utf8");
  return file;
}

async function load(envPath: string) {
  const env = await import("../src/utils/env.js");
  const defaults = await import("../src/cli/env-defaults.js");
  const publish = await import("../src/cli/commands/artifact-publish.js");
  env.loadEnv(envPath);
  return { env, defaults, publish };
}

beforeEach(async () => {
  vi.resetModules();
  clearKeys();
  dir = await mkdtemp(join(tmpdir(), "kit-dotenv-owner-"));
});

afterEach(async () => {
  clearKeys();
  await rm(dir, { recursive: true, force: true });
});

describe("artifact publish: o .env do diretório não define o dono", () => {
  it("chat sem cartão: RUNNER_CARD_ID/CANGE_CARD_ID do .env não tiram o artefato da conversa", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\nCANGE_CARD_ID=998\n");
    const { env, publish } = await load(envPath);

    // o .env foi mesmo carregado no ambiente (é o cenário do achado)
    expect(process.env.RUNNER_CARD_ID).toBe("999");
    expect(env.isFromDotenv("RUNNER_CARD_ID")).toBe(true);
    expect(env.isFromDotenv("RUNNER_CHAT_SESSION_ID")).toBe(false);

    expect(publish.resolveArtifactOwner({})).toEqual({ sessionId: 321 });
  });

  it("sem dono no ambiente do processo, o .env também não define a conversa (erro de uso)", async () => {
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\nRUNNER_CHAT_SESSION_ID=777\n");
    const { publish } = await load(envPath);

    expect(process.env.RUNNER_CHAT_SESSION_ID).toBe("777");
    expect(() => publish.resolveArtifactOwner({})).toThrow(/Informe o dono do artefato/);
  });

  it("cartão do ambiente do processo continua valendo (o dotenv não sobrescreve chave existente)", async () => {
    process.env.RUNNER_CARD_ID = "55";
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\n");
    const { env, publish } = await load(envPath);

    expect(env.isFromDotenv("RUNNER_CARD_ID")).toBe(false);
    expect(publish.resolveArtifactOwner({})).toEqual({ cardId: 55 });
  });

  it("flag explícita segue valendo com .env no diretório", async () => {
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\n");
    const { publish } = await load(envPath);

    expect(publish.resolveArtifactOwner({ sessionId: "321" })).toEqual({ sessionId: 321 });
  });

  it("valor do .env trocado depois pelo processo volta a contar como ambiente do processo", async () => {
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\n");
    const { env, publish } = await load(envPath);

    process.env.RUNNER_CARD_ID = "55";
    expect(env.isFromDotenv("RUNNER_CARD_ID")).toBe(false);
    expect(publish.resolveArtifactOwner({})).toEqual({ cardId: 55 });
  });

  it("leituras (card get/read) continuam aceitando o .env como padrão (escopo só do dono do artefato)", async () => {
    const envPath = await writeDotenv("RUNNER_CARD_ID=999\nRUNNER_FLOW_ID=192\n");
    const { defaults } = await load(envPath);

    expect(defaults.envCardId()).toBe("999");
    expect(defaults.envFlowId()).toBe("192");
    expect(defaults.envCardId({ processOnly: true })).toBeUndefined();
  });
});
