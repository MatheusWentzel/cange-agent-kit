import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getCommandMeta } from "../src/cli/command-metadata.js";
import { PROPOSE_UNSUPPORTED_MESSAGE, toolProposalSentence } from "../src/cli/commands/tool-propose.js";
import { createProgram } from "../src/cli/index.js";
import { buildApiToolProposalBody } from "../src/contracts/apiToolProposal.js";

// Onda 3 (bloco D): o agente PROPÕE uma ferramenta de API (POST /agent-api-tool-proposal).
// Só cria o pedido; a ferramenta nasce quando quem administra o agente revisa, digita
// a credencial e aprova. A credencial NUNCA vem do agente.

const envBackup = { ...process.env };

function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

const TOKEN = runToken({ id_user: 9995, company_id: 3955, agent_id: 206, run_id: 500, token_type: "agent_run" });

const CEP = {
  name: "Consulta de CEP",
  description: "Busca o endereço de um CEP brasileiro.",
  method: "get",
  url: "https://viacep.com.br/ws/{cep}/json",
  params: [{ name: "cep", description: "só números", required: true }]
};

const APOLLO = {
  name: "Buscar pessoas no Apollo",
  description: "Busca pessoas por cargo.",
  method: "POST",
  url: "https://api.apollo.io/api/v1/mixed_people/search",
  headers: [{ key: "Content-Type", value: "application/json" }],
  body: { type: "json", content: "{\"person_titles\":[\"{cargo}\"]}" },
  params: [{ name: "cargo", type: "string", required: true }],
  secret_headers: [{ key: "X-Api-Key", hint: "chave da conta Apollo" }]
};

describe("buildApiToolProposalBody (especificação → corpo da rota)", () => {
  it("normaliza o método e mantém só o que a rota aceita", () => {
    expect(buildApiToolProposalBody(CEP)).toEqual({
      name: "Consulta de CEP",
      description: "Busca o endereço de um CEP brasileiro.",
      method: "GET",
      url: "https://viacep.com.br/ws/{cep}/json",
      params: [{ name: "cep", description: "só números", type: "string", required: true }]
    });
    expect(buildApiToolProposalBody(APOLLO).secret_headers).toEqual([{ key: "X-Api-Key", hint: "chave da conta Apollo" }]);
  });

  it("recusa valor de credencial vindo do agente, em qualquer lugar", () => {
    const secret = /Valor de credencial na proposta/;
    expect(() => buildApiToolProposalBody({ ...APOLLO, secret_headers: [{ key: "X-Api-Key", value: "abc" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...APOLLO, secret_headers: [{ key: "X-Api-Key", valueEnc: "enc:v1:x" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, token: "abc" })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, headers: [{ key: "Authorization", value: "Bearer abc" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, query: [{ key: "api_key", value: "abc" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, params: [...CEP.params, { name: "token" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, url: "https://u:s@viacep.com.br/ws/{cep}/json" })).toThrow(secret);
  });

  it("segredo no caminho (tipo Z-API): só o nome em {{secret:nome}}; fora do caminho ou valor depois de /token/ recusa", () => {
    const zapi = {
      name: "Z-API",
      description: "Envia texto pelo WhatsApp.",
      method: "POST",
      url: "https://api.z-api.io/instances/{{secret:instancia}}/token/{{secret:token}}/send-text",
      body: { type: "json", content: "{\"phone\":\"{telefone}\"}" },
      params: [{ name: "telefone", required: true }],
      secret_headers: [{ key: "Client-Token" }],
      secret_path_params: [{ name: "instancia", hint: "ID da instância" }]
    };
    expect(buildApiToolProposalBody(zapi).secret_path_params).toEqual([{ name: "instancia", hint: "ID da instância" }]);
    expect(() => buildApiToolProposalBody({ ...zapi, secret_path_params: [{ name: "token", value: "abc" }] })).toThrow(/Valor de credencial/);
    expect(() => buildApiToolProposalBody({ ...zapi, secret_path_params: [{ name: "outro" }] })).toThrow(/não usa/);
    expect(() => buildApiToolProposalBody({ ...zapi, url: "https://api.z-api.io/instances/{{secret:instancia}}/token/A1B2C3/send-text", secret_path_params: [] })).toThrow(/Valor de credencial/);
    expect(() => buildApiToolProposalBody({ ...zapi, url: `${zapi.url}?x={{secret:instancia}}` })).toThrow(/só pode ficar no caminho/);
    expect(() => buildApiToolProposalBody({ ...zapi, headers: [{ key: "X-I", value: "{{secret:instancia}}" }] })).toThrow(/só pode ficar no caminho/);
    expect(() => buildApiToolProposalBody({ ...zapi, url: "https://{{secret:h}}.z-api.io/x", secret_path_params: [] })).toThrow(/host/);
  });

  it("texto com cara de chave em qualquer campo recusa antes do --dry-run imprimir", () => {
    const secret = /Valor de credencial na proposta/;
    expect(() => buildApiToolProposalBody({ ...CEP, description: "use Bearer abcdefghijklmnopqrstuvwxyz" })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...CEP, reason: "a chave é sk-abcdefghijklmnopqrstuvwxyz123" })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...APOLLO, headers: [{ key: "X-Trace", value: "eyJhbGciOiJIUzI1Ni.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw" }] })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...APOLLO, body: { type: "json", content: "{\"k\":\"ghp_abcdefghijklmnopqrstuvwxyz12\"}" } })).toThrow(secret);
    expect(() => buildApiToolProposalBody({ ...APOLLO, secret_headers: [{ key: "X-Api-Key", hint: "AIzaSyA1234567890abcdefghijklmnopqrstuv" }] })).toThrow(secret);
  });

  it("recusa http, host com parâmetro, {param} sem declarar e campo desconhecido", () => {
    expect(() => buildApiToolProposalBody({ ...CEP, url: "http://viacep.com.br/ws/{cep}/json" })).toThrow(/https/);
    expect(() => buildApiToolProposalBody({ ...CEP, url: "https://{cep}.x.com/a" })).toThrow(/host/);
    expect(() => buildApiToolProposalBody({ ...CEP, url: "https://viacep.com.br/ws/{codigo}/json" })).toThrow(/\{codigo\}/);
    expect(() => buildApiToolProposalBody({ ...CEP, rest_config: {} })).toThrow(/desconhecido/);
    expect(() => buildApiToolProposalBody({ ...CEP, method: "TRACE" })).toThrow(/method/);
  });

  it("frase da resposta diz que depende da aprovação, sem travessão", () => {
    const sentence = toolProposalSentence({ deduped: false }, "Consulta de CEP");
    expect(sentence).toMatch(/só passa a valer quando quem administra o agente revisar, digitar a credencial e aprovar/);
    expect(sentence).not.toMatch(/[—–]/);
    expect(PROPOSE_UNSUPPORTED_MESSAGE).not.toMatch(/[—–]/);
  });
});

describe("cange tool propose (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let dir = "";
  const file = (name: string) => join(dir, name);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cange-tool-propose-"));
    await writeFile(file("apollo.json"), JSON.stringify(APOLLO), "utf8");
    await writeFile(file("com-segredo.json"), JSON.stringify({ ...APOLLO, secret_headers: [{ key: "X-Api-Key", value: "abc" }] }), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.CANGE_OUTPUT_PROFILE;
    process.env.CANGE_ACCESS_TOKEN = TOKEN;
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
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function mockFetch(body: unknown, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
  }

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  it("--dry-run confere e mostra o corpo sem chamar o Cange", async () => {
    const fetchMock = mockFetch({});
    await run(["tool", "propose", "--spec", file("apollo.json"), "--dry-run"]);
    expect(fetchMock).not.toHaveBeenCalled();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, executed: false, payload: { method: "POST", secret_headers: [{ key: "X-Api-Key" }] } });
  });

  it("envia para POST /agent-api-tool-proposal e devolve a frase pronta", async () => {
    const fetchMock = mockFetch({ approval_id: 901, deduped: false, status: "pending", summary: "Criar a ferramenta de API" }, 201);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-api-tool-proposal$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(buildApiToolProposalBody(APOLLO));
    const out = JSON.parse(stdout.join(""));
    expect(out.approvalId).toBe(901);
    expect(out.message).toMatch(/Propus a ferramenta de API "Buscar pessoas no Apollo"/);
    expect(out.note).toMatch(/não peça a credencial/);
  });

  it("valor de credencial no --spec: erro de uso, nada enviado", async () => {
    const fetchMock = mockFetch({});
    await run(["tool", "propose", "--spec", file("com-segredo.json")]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toMatch(/Valor de credencial na proposta/);
  });

  it("back antigo (403 sem código do gate): mensagem clara, sem repetir", async () => {
    mockFetch({ status: "error", message: "Ação não permitida para este agente." }, 403);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    expect(process.exitCode).not.toBe(0);
    expect(stderr.join("")).toContain("Este ambiente do Cange ainda não aceita proposta de ferramenta de API");
  });

  it("back antigo (404 da rota): a mesma mensagem", async () => {
    mockFetch({ status: "error", message: "Not Found" }, 404);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    expect(stderr.join("")).toContain("Este ambiente do Cange ainda não aceita proposta de ferramenta de API");
  });

  it("grant desligado e Planejar: o erro traz o próximo passo", async () => {
    mockFetch({ status: "error", message: "Propor ferramentas de API está desligado para este agente.", complement: { code: "API_TOOL_PROPOSE_DISABLED" } }, 403);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    expect(stderr.join("")).toMatch(/aba Ferramentas/);
    vi.restoreAllMocks();
    stderr.length = 0;
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockFetch({ status: "error", message: "Esta conversa está em \"Planejar\".", complement: { code: "PLAN_MODE_WRITE_BLOCKED" } }, 403);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    expect(stderr.join("")).toMatch(/descreva na resposta a ferramenta/);
  });

  it("--dry-run com chave na especificação: erro, nada impresso no stdout", async () => {
    await writeFile(file("com-chave.json"), JSON.stringify({ ...APOLLO, description: "Bearer abcdefghijklmnopqrstuvwxyz" }), "utf8");
    const fetchMock = mockFetch({});
    await run(["tool", "propose", "--spec", file("com-chave.json"), "--dry-run"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(stdout.join("")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(stderr.join("")).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("chave do ambiente desligada (403 tipado): a frase clara, sem repetir", async () => {
    mockFetch({ status: "error", message: "Propor ferramenta de API ainda não está disponível neste ambiente.", complement: { code: "API_TOOL_PROPOSE_UNAVAILABLE" } }, 403);
    await run(["tool", "propose", "--spec", file("apollo.json")]);
    expect(process.exitCode).not.toBe(0);
    expect(stderr.join("")).toMatch(/Não tente de novo; diga ao usuário que quem administra o agente pode cadastrar/);
  });

  it("anotado como mutação (o runner classifica pelo comando)", () => {
    const program = createProgram();
    const propose = program.commands.find((c) => c.name() === "tool")?.commands.find((c) => c.name() === "propose");
    expect(propose).toBeDefined();
    expect(getCommandMeta(propose!)?.mutates).toBe(true);
  });
});
