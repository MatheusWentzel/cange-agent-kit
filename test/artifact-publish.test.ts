import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeValidationError } from "../src/client/errors.js";
import type { CangeClient } from "../src/client/http.js";
import { resolveArtifactOwner } from "../src/cli/commands/artifact-publish.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { createArtifactsContracts, type PublishArtifactInput } from "../src/contracts/artifacts.js";
import { publishArtifactInputSchema } from "../src/schemas/artifacts.js";

// Artefato de CONVERSA (30/09): o dono do artefato passa a ser um cartão OU uma
// conversa do agente (agent_session), nunca os dois. Num chat sem cartão o
// runner injeta só RUNNER_CHAT_SESSION_ID, e o `artifact publish` sem flag cai
// para a conversa em vez de morrer pedindo o link do cartão.

const OWNER_ENV = ["RUNNER_CARD_ID", "CANGE_CARD_ID", "RUNNER_CHAT_SESSION_ID"] as const;
const envBackup = { ...process.env };

function clearOwnerEnv(): void {
  for (const name of OWNER_ENV) delete process.env[name];
}

function createMockClient(): CangeClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    getAccessToken: vi.fn()
  };
}

const BASE = { type: "one-pager", title: "Resumo da semana", html: "<h1>Oi</h1><!-- /artifact -->" };

describe("publishArtifact (contrato): dono cartão xor conversa", () => {
  it("com sessionId manda session_id no body e NUNCA card_id", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id_artifact: 9 });

    await createArtifactsContracts(client).publishArtifact({ ...BASE, sessionId: 321 });

    expect(client.post).toHaveBeenCalledWith("/artifact", {
      body: { session_id: 321, ...BASE },
      retry: false
    });
    expect(vi.mocked(client.post).mock.calls[0]?.[1]?.body).not.toHaveProperty("card_id");
  });

  it("com cardId manda card_id no body e NUNCA session_id (comportamento de antes)", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id_artifact: 9 });

    await createArtifactsContracts(client).publishArtifact({ ...BASE, cardId: 1226170, variant: "editorial" });

    expect(client.post).toHaveBeenCalledWith("/artifact", {
      body: { card_id: 1226170, ...BASE, variant: "editorial" },
      retry: false
    });
    expect(vi.mocked(client.post).mock.calls[0]?.[1]?.body).not.toHaveProperty("session_id");
  });

  it("recusa os dois donos juntos e nenhum dono, antes de chamar a API", async () => {
    const client = createMockClient();
    const contracts = createArtifactsContracts(client);

    await expect(
      contracts.publishArtifact({ ...BASE, cardId: 1, sessionId: 2 } as unknown as PublishArtifactInput)
    ).rejects.toThrow(/Payload inválido para publishArtifact/);
    await expect(contracts.publishArtifact({ ...BASE } as unknown as PublishArtifactInput)).rejects.toThrow(
      CangeValidationError
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("schema: sessionId precisa ser inteiro positivo", () => {
    expect(publishArtifactInputSchema.safeParse({ ...BASE, sessionId: 0 }).success).toBe(false);
    expect(publishArtifactInputSchema.safeParse({ ...BASE, sessionId: 1.5 }).success).toBe(false);
    expect(publishArtifactInputSchema.safeParse({ ...BASE, sessionId: 7 }).success).toBe(true);
    expect(publishArtifactInputSchema.safeParse({ ...BASE, cardId: 7 }).success).toBe(true);
  });
});

describe("resolveArtifactOwner: flag > env; cartão > conversa", () => {
  beforeEach(clearOwnerEnv);
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("flag de cartão (canônica e alias) vira cartão", () => {
    expect(resolveArtifactOwner({ cardId: "10" })).toEqual({ cardId: 10 });
    expect(resolveArtifactOwner({ card: "11" })).toEqual({ cardId: 11 });
  });

  it("--session-id vira conversa", () => {
    expect(resolveArtifactOwner({ sessionId: "321" })).toEqual({ sessionId: 321 });
  });

  it("--card-id junto com --session-id é erro de validação", () => {
    expect(() => resolveArtifactOwner({ cardId: "10", sessionId: "321" })).toThrow(/não os dois/);
    expect(() => resolveArtifactOwner({ card: "10", sessionId: "321" })).toThrow(CangeValidationError);
  });

  it("flag inválida é erro de validação (não cai para o env)", () => {
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    expect(() => resolveArtifactOwner({ sessionId: "abc" })).toThrow(/--session-id deve ser um inteiro positivo/);
    expect(() => resolveArtifactOwner({ cardId: "0" })).toThrow(/--card-id deve ser um inteiro positivo/);
  });

  it("sem flag: o cartão do env vence a conversa (chat com cartão em foco publica no cartão)", () => {
    process.env.RUNNER_CARD_ID = "55";
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    expect(resolveArtifactOwner({})).toEqual({ cardId: 55 });
  });

  it("sem flag e sem cartão no env: cai para RUNNER_CHAT_SESSION_ID", () => {
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    expect(resolveArtifactOwner({})).toEqual({ sessionId: 321 });
  });

  it("CANGE_CARD_ID também conta como cartão do env", () => {
    process.env.CANGE_CARD_ID = "77";
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    expect(resolveArtifactOwner({})).toEqual({ cardId: 77 });
  });

  it("flag explícita vence o env (--session-id com RUNNER_CARD_ID no ambiente)", () => {
    process.env.RUNNER_CARD_ID = "55";
    expect(resolveArtifactOwner({ sessionId: "321" })).toEqual({ sessionId: 321 });
  });

  it("RUNNER_CHAT_SESSION_ID inválido é ignorado; sem dono nenhum é erro claro", () => {
    process.env.RUNNER_CHAT_SESSION_ID = "abc";
    expect(() => resolveArtifactOwner({})).toThrow(/--card-id <id>.*--session-id <id>/);
  });
});

describe("artifact publish (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let htmlPath: string;

  beforeEach(async () => {
    clearOwnerEnv();
    process.env.CANGE_ACCESS_TOKEN = "token";
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    htmlPath = join(tmpdir(), `cange-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    await writeFile(htmlPath, BASE.html, "utf8");
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await unlink(htmlPath).catch(() => undefined);
  });

  function mockPublish(raw: Record<string, unknown>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(raw), { status: 201, headers: { "content-type": "application/json" } })
    );
  }

  function sentBody(fetchMock: ReturnType<typeof mockPublish>): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  async function runPublish(args: string[]): Promise<void> {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "cange",
      "--output",
      "json",
      "artifact",
      "publish",
      "--type",
      BASE.type,
      "--title",
      BASE.title,
      "--file",
      htmlPath,
      ...args
    ]);
  }

  it("chat sem cartão: sem flag, publica na conversa do RUNNER_CHAT_SESSION_ID", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    const fetchMock = mockPublish({
      id_artifact: 40,
      slug: "abc123",
      version: 1,
      visibility: "private",
      attachment_id: null
    });

    await runPublish([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/artifact$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ session_id: 321, type: BASE.type, title: BASE.title, html: BASE.html });
    expect(body).not.toHaveProperty("card_id");

    const out = JSON.parse(stdout.join(""));
    expect(out).toEqual({ artifactId: 40, slug: "abc123", version: 1, visibility: "private", sessionId: 321 });
    expect(out).not.toHaveProperty("attachmentId");
    expect(process.exitCode).toBeUndefined();
  });

  it("--session-id explícito publica na conversa informada", async () => {
    const fetchMock = mockPublish({ id_artifact: 41, slug: "s", version: 2, visibility: "private" });

    await runPublish(["--session-id", "654"]);

    expect(sentBody(fetchMock)).toMatchObject({ session_id: 654 });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ artifactId: 41, version: 2, sessionId: 654 });
  });

  it("chat com cartão em foco: RUNNER_CARD_ID vence e o artefato continua no cartão", async () => {
    process.env.RUNNER_CARD_ID = "1226170";
    process.env.RUNNER_CHAT_SESSION_ID = "321";
    const fetchMock = mockPublish({
      id_artifact: 42,
      slug: "c",
      version: 3,
      visibility: "private",
      attachment_id: 900
    });

    await runPublish([]);

    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ card_id: 1226170 });
    expect(body).not.toHaveProperty("session_id");
    const out = JSON.parse(stdout.join(""));
    expect(out).toEqual({
      artifactId: 42,
      slug: "c",
      version: 3,
      visibility: "private",
      cardId: 1226170,
      attachmentId: 900
    });
    expect(out).not.toHaveProperty("sessionId");
  });

  it("--card (alias) segue publicando no cartão", async () => {
    const fetchMock = mockPublish({ id_artifact: 43, slug: "d", version: 1, visibility: "private", attachment_id: 5 });

    await runPublish(["--card", "88"]);

    expect(sentBody(fetchMock)).toMatchObject({ card_id: 88 });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ cardId: 88, attachmentId: 5 });
  });

  it("--card-id com --session-id sai com erro de uso, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runPublish(["--card-id", "88", "--session-id", "321"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.join("")).message).toContain("não os dois");
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("sem cartão e sem conversa (nem flag, nem env) sai com erro de uso, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runPublish([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.join("")).message).toContain("--session-id <id>");
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("expõe --session-id no comando (o gate do runner e o manifesto leem a árvore real)", () => {
    const program = createProgram();
    const artifact = program.commands.find((command) => command.name() === "artifact");
    const publish = artifact?.commands.find((command) => command.name() === "publish");
    const longs = publish?.options.map((option) => option.long) ?? [];
    expect(longs).toEqual(expect.arrayContaining(["--card-id", "--card", "--session-id"]));
  });
});
