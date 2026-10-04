import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CangeClient } from "../src/client/http.js";
import { ARTIFACT_HTML_RULES } from "../src/cli/commands/artifact-publish.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { getCommandMeta } from "../src/cli/command-metadata.js";
import { createArtifactsContracts } from "../src/contracts/artifacts.js";

// Rodada 3 (01/10): artefato com CSS. O kit ganha a conferência do publish
// (`--dry-run` → POST /artifact/validate), a leitura do HTML publicado
// (`artifact get` → GET /artifact/:id/source) e a lista por conversa
// (`artifact list --session-id` → GET /artifact/by-session). O help deixa de
// dizer "NÃO escreva CSS".

const OWNER_ENV = ["RUNNER_CARD_ID", "CANGE_CARD_ID", "RUNNER_CHAT_SESSION_ID"] as const;
const envBackup = { ...process.env };

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

const VALIDATE_OK = {
  ok: true,
  normalizations: ["1 bloco(s) <style> aproveitado(s)"],
  warnings: [],
  raw_bytes: 120,
  html_bytes: 80,
  css_bytes: 40,
  max_css_bytes: 65536
};

const SOURCE = {
  id_artifact: 12,
  type: "resumo-projetos",
  title: "Resumo dos projetos",
  card_id: null,
  flow_id: null,
  session_id: 113,
  current_version: 3,
  version: 3,
  theme_version: "v3",
  accent: "blue",
  density: null,
  variant: null,
  html: "<style data-artifact-css>\n.kpi {\n  border-radius: 16px;\n}\n</style>\n<h1>Resumo</h1><!-- /artifact -->",
  html_bytes: 90,
  css_bytes: 30
};

describe("contratos de artefato (rodada 3)", () => {
  it("validateArtifact manda SÓ o html para /artifact/validate, sem retry, e normaliza a resposta", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      ok: false,
      error: "CSS acima de 64 KB",
      warnings: ["CSS: url() externo removido"],
      normalizations: [],
      raw_bytes: 70000,
      html_bytes: null,
      css_bytes: null,
      max_css_bytes: 65536
    });

    const result = await createArtifactsContracts(client).validateArtifact({ html: "<h1>x</h1>" });

    expect(client.post).toHaveBeenCalledWith("/artifact/validate", { body: { html: "<h1>x</h1>" }, retry: false });
    expect(result).toMatchObject({
      ok: false,
      error: "CSS acima de 64 KB",
      warnings: ["CSS: url() externo removido"],
      normalizations: [],
      rawBytes: 70000,
      htmlBytes: null,
      cssBytes: null,
      maxCssBytes: 65536
    });
  });

  it("validateArtifact recusa html vazio antes de chamar a API", async () => {
    const client = createMockClient();
    await expect(createArtifactsContracts(client).validateArtifact({ html: "" })).rejects.toThrow(
      /Payload inválido para validateArtifact/
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("getArtifactSource lê /artifact/:id/source (com ?version) e devolve dono e accent/density/variant", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue(SOURCE);

    const source = await createArtifactsContracts(client).getArtifactSource({ artifactId: 12, version: 3 });

    expect(client.get).toHaveBeenCalledWith("/artifact/12/source", { query: { version: 3 } });
    expect(source).toMatchObject({
      artifactId: 12,
      type: "resumo-projetos",
      sessionId: 113,
      cardId: null,
      version: 3,
      themeVersion: "v3",
      accent: "blue",
      density: null,
      variant: null,
      html: SOURCE.html
    });
  });

  it("getArtifactSource sem versão não manda ?version (o back usa a vigente)", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue(SOURCE);
    await createArtifactsContracts(client).getArtifactSource({ artifactId: 12 });
    expect(client.get).toHaveBeenCalledWith("/artifact/12/source", { query: { version: undefined } });
  });

  it("getArtifactsBySession lê /artifact/by-session", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({
      session_id: 113,
      artifacts: [{ id_artifact: 12, slug: "s", type: "resumo", title: "R", visibility: "private", version: 3 }]
    });

    const result = await createArtifactsContracts(client).getArtifactsBySession({ sessionId: 113 });

    expect(client.get).toHaveBeenCalledWith("/artifact/by-session", { query: { session_id: 113 } });
    expect(result.total).toBe(1);
    expect(result.artifacts[0]).toMatchObject({ id: 12, type: "resumo", version: 3 });
  });
});

describe("artifact publish / get / list (CLI, rodada 3)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let dir: string;
  let htmlPath: string;

  beforeEach(async () => {
    for (const name of OWNER_ENV) delete process.env[name];
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
    dir = await mkdtemp(join(tmpdir(), "cange-artifact-css-"));
    htmlPath = join(dir, "artefato.html");
    await writeFile(htmlPath, "<style>.kpi{border-radius:16px}</style><h1>Oi</h1><!-- /artifact -->", "utf8");
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function mockFetch(body: unknown, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
  }

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  it("publish --dry-run chama /artifact/validate (não publica) e devolve o que seria removido", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "113";
    const fetchMock = mockFetch({ ...VALIDATE_OK, warnings: ["CSS: url() externo removido de .hero"] });

    await run(["artifact", "publish", "--type", "resumo", "--title", "Resumo", "--file", htmlPath, "--dry-run"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/artifact\/validate$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["html"]);

    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({
      dryRun: true,
      executed: false,
      ok: true,
      warnings: ["CSS: url() externo removido de .hero"],
      sessionId: 113,
      type: "resumo"
    });
    expect(out.note).toContain("Nada foi publicado");
    expect(process.exitCode).toBeUndefined();
  });

  it("publish --dry-run que não passaria sai com exit 2 e o motivo no stdout", async () => {
    process.env.RUNNER_CARD_ID = "77";
    mockFetch({ ok: false, error: "O CSS saneado passa de 64 KB.", warnings: [], normalizations: [] });

    await run(["artifact", "publish", "--type", "r", "--title", "R", "--file", htmlPath, "--dry-run"]);

    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, ok: false, error: "O CSS saneado passa de 64 KB.", cardId: 77 });
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("KR-02: publish --dry-run com --type de 41 caracteres sai com exit 2, sem chamar a API", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "113";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await run(["artifact", "publish", "--type", "x".repeat(41), "--title", "Resumo", "--file", htmlPath, "--dry-run"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, executed: false, ok: false, sessionId: 113 });
    expect(out.error).toContain("--type precisa ter de 1 a 40 caracteres");
    expect(out.note).toContain("NÃO passaria");
    expect(out.note).not.toContain("—");
  });

  it("KR-02: publish --dry-run com --title em branco e --accent longo cita as duas flags", async () => {
    process.env.RUNNER_CARD_ID = "77";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await run(["artifact", "publish", "--type", "r", "--title", "   ", "--accent", "a".repeat(25), "--file", htmlPath, "--dry-run"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const out = JSON.parse(stdout.join(""));
    expect(out.error).toContain("--title precisa ter de 1 a 255 caracteres");
    expect(out.error).toContain("--accent aceita no máximo 24 caracteres");
    expect(out.cardId).toBe(77);
  });

  it("publish --dry-run sem dono (nem flag nem env) é erro de uso, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["artifact", "publish", "--type", "r", "--title", "R", "--file", htmlPath, "--dry-run"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("get grava o HTML no --out, não o imprime, e devolve o comando do republish no mesmo dono", async () => {
    const fetchMock = mockFetch(SOURCE);
    const out = join(dir, "sub", "atual.html");

    await run(["artifact", "get", "--id", "12", "--out", out]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/artifact\/12\/source$/);
    expect(await readFile(out, "utf8")).toBe(SOURCE.html);

    const printed = stdout.join("");
    expect(printed).not.toContain("border-radius");
    const result = JSON.parse(printed);
    expect(result).toMatchObject({
      artifactId: 12,
      type: "resumo-projetos",
      title: "Resumo dos projetos",
      sessionId: 113,
      version: 3,
      themeVersion: "v3",
      accent: "blue",
      out
    });
    expect(result).not.toHaveProperty("cardId");
    expect(result.republish).toBe(
      `cange artifact publish --session-id 113 --type 'resumo-projetos' --title 'Resumo dos projetos' --file '${out}' --accent 'blue'`
    );
  });

  it("get de artefato de cartão sugere --card-id e repete --version", async () => {
    const fetchMock = mockFetch({ ...SOURCE, session_id: null, card_id: 1226170, flow_id: 316, version: 2, accent: null });
    const out = join(dir, "c.html");

    await run(["artifact", "get", "--artifact-id", "12", "--artifact-version", "2", "--out", out]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/artifact\/12\/source\?version=2$/);
    const result = JSON.parse(stdout.join(""));
    expect(result).toMatchObject({ cardId: 1226170, flowId: 316, version: 2 });
    expect(result.republish).toContain("--card-id 1226170");
    expect(result.republish).not.toContain("--accent");
  });

  it("KR-05: get com --out relativo grava no caminho absoluto e o `republish` sai com o caminho absoluto", async () => {
    mockFetch(SOURCE);
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    await run(["artifact", "get", "--id", "12", "--out", "artefato-rel.html"]);

    const abs = join(dir, "artefato-rel.html");
    expect(await readFile(abs, "utf8")).toBe(SOURCE.html);
    const result = JSON.parse(stdout.join(""));
    expect(result.out).toBe(abs);
    expect(result.republish).toContain(`--file '${abs}'`);
    expect(result.republish).not.toContain("--file 'artefato-rel.html'");
  });

  it("get sem --out é erro de uso (o HTML nunca vai para a saída)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["artifact", "get", "--id", "12"]).catch(() => undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get com id inválido é erro de validação, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["artifact", "get", "--id", "abc", "--out", join(dir, "x.html")]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("list --session-id lê os artefatos da conversa", async () => {
    const fetchMock = mockFetch({ session_id: 113, artifacts: [{ id_artifact: 12, type: "resumo", version: 3 }] });

    await run(["artifact", "list", "--session-id", "113"]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/artifact\/by-session\?session_id=113$/);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ sessionId: 113, total: 1 });
  });

  it("list sem flag usa a conversa do chat (RUNNER_CHAT_SESSION_ID) e --card-id segue lendo o cartão", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "113";
    const fetchMock = mockFetch({ artifacts: [] });

    await run(["artifact", "list"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/artifact\/by-session\?session_id=113$/);

    stdout.length = 0;
    await run(["artifact", "list", "--card-id", "55"]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/artifact\/by-card\?card_id=55$/);
  });

  it("list sem dono nenhum explica as duas flags", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["artifact", "list"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.join("")).message).toContain("--session-id <id>");
  });

  it("help do publish libera CSS (sem o antigo 'NÃO escreva CSS') e lista o proibido", () => {
    const program = createProgram();
    const artifact = program.commands.find((command) => command.name() === "artifact");
    const publish = artifact?.commands.find((command) => command.name() === "publish");
    const get = artifact?.commands.find((command) => command.name() === "get");
    expect(get).toBeDefined();
    const meta = publish ? getCommandMeta(publish) : undefined;
    expect(meta?.fieldsLocation).toContain("<style>");
    expect(meta?.fieldsLocation).not.toMatch(/NÃO escreva CSS/);
    expect(meta?.fieldsLocation).toContain("artifact get --id");
    expect(ARTIFACT_HTML_RULES).toContain("url() externo");
    expect(ARTIFACT_HTML_RULES).toContain("@import");
    expect(ARTIFACT_HTML_RULES).toContain("<!-- /artifact -->");
    expect(ARTIFACT_HTML_RULES).not.toContain("—");
    const longs = publish?.options.map((option) => option.long) ?? [];
    expect(longs).toContain("--dry-run");
  });
});
