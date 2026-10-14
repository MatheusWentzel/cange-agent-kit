import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCatalogQuery } from "../src/cli/catalog-by-id.js";
import { accessRequestSentence } from "../src/cli/commands/access.js";
import { getCommandMeta } from "../src/cli/command-metadata.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { normalizeAccessRequest, normalizeCatalog } from "../src/contracts/resourceAccess.js";

// Rodada 6 (02/10, decisão 9): o agente acha fluxos e cadastros pelo NOME
// (GET /agent-run/catalog) e PEDE acesso (POST /agent-run/access-request). O
// pedido não pausa o run; quem pode convidar para o recurso decide no Cange.

const envBackup = { ...process.env };

function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

const TOKEN = runToken({ id_user: 9995, company_id: 3955, agent_id: 206, run_id: 500, token_type: "agent_run" });

const CATALOG = {
  anchor: { kind: "conversation", name: "Matheus" },
  scope: "anchor_and_agent",
  items: [
    { id: 11781, name: "Projetos Capex", type: "flow", has_access: true, role: "M", requestable: false },
    { id: 12064, name: "Compras", type: "flow", has_access: false, role: null, requestable: true },
    { id: 6446, name: "Fornecedores", type: "register", has_access: true, role: null, requestable: true },
    { id: 7001, name: "Clientes", type: "register", has_access: false, role: "V", requestable: true }
  ],
  total: 4,
  truncated: false
};

const REQUEST_CREATED = {
  approval_id: 88,
  deduped: false,
  status: "pending",
  resource_type: "flow",
  resource_id: 12064,
  resource_name: "Compras",
  role: "M",
  who_can_approve: ["Ana", "Bruno"],
  routed_to_user_id: 5747,
  message: "Pedi acesso ao fluxo Compras. Quem pode liberar: Ana, Bruno."
};

describe("contratos do acesso (normalização)", () => {
  it("catálogo: camelCase, tipo e acesso; item torto fica de fora", () => {
    const catalog = normalizeCatalog({
      ...CATALOG,
      items: [...CATALOG.items, { id: "x", name: "ruim", type: "flow" }, { id: 5, name: "outro", type: "pasta" }]
    });
    expect(catalog.anchor).toEqual({ kind: "conversation", name: "Matheus" });
    expect(catalog.scope).toBe("anchor_and_agent");
    expect(catalog.items).toHaveLength(4);
    expect(catalog.items[1]).toEqual({ id: 12064, name: "Compras", type: "flow", hasAccess: false, role: null, requestable: true });
    expect(catalog.total).toBe(4);
  });

  it("catálogo sem âncora (automação sem conversa)", () => {
    const catalog = normalizeCatalog({ anchor: null, scope: "agent_only", items: [], total: 0, truncated: false });
    expect(catalog.anchor).toBeNull();
    expect(catalog.scope).toBe("agent_only");
  });

  it("pedido: ids, recurso, quem pode liberar (até 5) e a frase", () => {
    const result = normalizeAccessRequest({ ...REQUEST_CREATED, who_can_approve: ["A", "B", "C", "D", "E", "F", 7] });
    expect(result).toMatchObject({
      approvalId: 88,
      deduped: false,
      resourceType: "flow",
      resourceId: 12064,
      resourceName: "Compras",
      whoCanApprove: ["A", "B", "C", "D", "E"],
      routedToUserId: 5747
    });
  });

  it("frase de reserva quando o servidor não manda `message` (sem travessão)", () => {
    const sentence = accessRequestSentence(normalizeAccessRequest({ ...REQUEST_CREATED, message: null, resource_type: "register", resource_name: "Clientes" }));
    expect(sentence).toBe("Pedi acesso ao cadastro Clientes. Quem pode liberar: Ana, Bruno.");
    expect(accessRequestSentence(normalizeAccessRequest({ resource_type: "flow", who_can_approve: [] }))).toBe("Pedi acesso ao fluxo.");
  });
});

describe("cange catalog / cange access request (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

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

  it("catalog: enxuto com access sim/não, papel e o caminho para pedir", async () => {
    const fetchMock = mockFetch(CATALOG);
    await run(["catalog"]);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-run\/catalog\?type=all$/);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([
      { id: 11781, name: "Projetos Capex", type: "flow", access: "sim", role: "M" },
      { id: 12064, name: "Compras", type: "flow", access: "não" },
      { id: 6446, name: "Fornecedores", type: "register", access: "sim" },
      { id: 7001, name: "Clientes", type: "register", access: "não", role: "V" }
    ]);
    expect(out.total).toBe(4);
    expect(out).not.toHaveProperty("truncated");
    expect(out).not.toHaveProperty("raw");
    expect(out.anchor).toBe("Matheus");
    expect(out.note).toContain("cange access request --flow <id>");
    expect(out.note).toContain("Não grave nomes do catálogo");
    expect(out.note).not.toContain("—");
  });

  it("catalog --type flow --q --limit vão na query; filtro vazio não diz que não existe", async () => {
    const fetchMock = mockFetch({ anchor: null, scope: "agent_only", items: [], total: 0, truncated: false });
    await run(["catalog", "--type", "flow", "--q", "compras", "--limit", "50"]);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-run\/catalog\?type=flow&q=compras&limit=50$/);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([]);
    expect(out.note).toContain("só o que você já vê");
    expect(out.note).toContain("Não diga que não existe");
  });

  it("catalog sem --type: teto TOTAL (padrão 200) dividido entre fluxos e cadastros, mesmo com o back limitando por tipo", async () => {
    // O back aplica o limit a cada tipo: 200 fluxos + 164 cadastros = 364 (empresa 215 do cange_local).
    const flows = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `F${i}`, type: "flow", has_access: true, role: "M", requestable: false }));
    const registers = Array.from({ length: 164 }, (_, i) => ({ id: 1000 + i, name: `C${i}`, type: "register", has_access: false, role: null, requestable: true }));
    mockFetch({ anchor: null, scope: "anchor_and_agent", items: [...flows, ...registers], total: 402, truncated: true });
    await run(["catalog"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toHaveLength(200);
    expect(out.items.filter((i: { type: string }) => i.type === "flow")).toHaveLength(100);
    expect(out.items.filter((i: { type: string }) => i.type === "register")).toHaveLength(100);
    expect(out.total).toBe(402);
    expect(out.truncated).toBe(true);
    expect(out.note).toContain("refine com --q");
  });

  it("catalog --limit é total: sobra de um tipo vai para o outro; corte marca truncated mesmo sem o back marcar", async () => {
    const flows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `F${i}`, type: "flow", has_access: true, role: "M", requestable: false }));
    const registers = [{ id: 900, name: "C0", type: "register", has_access: true, role: "M", requestable: false }];
    mockFetch({ anchor: null, scope: "agent_only", items: [...flows, ...registers], total: 6, truncated: false });
    await run(["catalog", "--limit", "4"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([1, 2, 3, 900]);
    expect(out.truncated).toBe(true);
  });

  it("catalog cortado avisa para refinar", async () => {
    mockFetch({ ...CATALOG, truncated: true, total: 900 });
    await run(["catalog"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.truncated).toBe(true);
    expect(out.note).toContain("refine com --q");
  });

  it("catalog --raw devolve a resposta crua; --full traz raw e itens normalizados", async () => {
    mockFetch(CATALOG);
    await run(["catalog", "--raw"]);
    expect(JSON.parse(stdout.join(""))).toEqual(CATALOG);

    stdout.length = 0;
    await run(["catalog", "--full"]);
    const full = JSON.parse(stdout.join(""));
    expect(full.raw).toEqual(CATALOG);
    expect(full.items[1]).toMatchObject({ id: 12064, hasAccess: false, requestable: true });
    expect(full.anchor).toEqual({ kind: "conversation", name: "Matheus" });
  });

  it("catalog com --type ou --limit inválidos: exit 2, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["catalog", "--type", "pasta"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    process.exitCode = undefined;
    await run(["catalog", "--limit", "0"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    process.exitCode = undefined;
    await run(["catalog", "--limit", "501"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("access request --flow: corpo enxuto (agente sai do token), papel M por padrão e frase pronta", async () => {
    const fetchMock = mockFetch(REQUEST_CREATED, 201);
    await run(["access", "request", "--flow", "12064", "--reason", "  Ler os pedidos   em aberto  "]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-run\/access-request$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ type: "flow", resource_id: 12064, role: "M", reason: "Ler os pedidos em aberto" });
    expect(body).not.toHaveProperty("agent_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({
      approvalId: 88,
      status: "pending",
      deduped: false,
      resource: { type: "flow", id: 12064, name: "Compras" },
      role: "Membro",
      whoCanApprove: ["Ana", "Bruno"],
      message: "Pedi acesso ao fluxo Compras. Quem pode liberar: Ana, Bruno."
    });
    expect(out.note).toContain("Não espere a decisão nem repita");
    expect(out.note).toContain("Pedi acesso ao fluxo Compras");
    expect(out.note).not.toContain("—");
    expect(process.exitCode).toBeUndefined();
  });

  it("access request --register --role m (minúsculo) vira M; pedido repetido avisa que já aguardava", async () => {
    const fetchMock = mockFetch(
      { ...REQUEST_CREATED, deduped: true, resource_type: "register", resource_id: 7001, resource_name: "Clientes", role: "M", message: null },
      200
    );
    await run(["access", "request", "--register", "7001", "--role", "m", "--reason", "Atualizar clientes"]);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({ type: "register", resource_id: 7001, role: "M", reason: "Atualizar clientes" });
    const out = JSON.parse(stdout.join(""));
    expect(out.deduped).toBe(true);
    expect(out.role).toBe("Membro");
    expect(out.message).toBe("Pedi acesso ao cadastro Clientes. Quem pode liberar: Ana, Bruno.");
    expect(out.note).toContain("já estava aguardando decisão");
  });

  it("access request --role A (decisão 11): exit 2 explicando que Administrador só pelo bloco Ferramentas > Cange", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const role of ["A", "a"]) {
      process.exitCode = undefined;
      stderr.length = 0;
      await run(["access", "request", "--flow", "12064", "--role", role, "--reason", "Organizar o fluxo"]);
      expect(process.exitCode).toBe(EXIT_CODES.USAGE);
      const err = stderr.join("");
      expect(err).toContain("concede sempre Membro");
      expect(err).toContain("Ferramentas > Cange");
      expect(err).not.toContain("—");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("help do access request não oferece Administrador", () => {
    type Cmd = { name(): string; commands: readonly Cmd[]; options: readonly { long?: string; description: string }[] };
    const program = createProgram() as unknown as Cmd;
    const request = program.commands.find((c) => c.name() === "access")!.commands[0]!;
    const role = request.options.find((o) => o.long === "--role")!;
    expect(role.description).not.toMatch(/ou A\b|\(administrador\)/i);
    expect(role.description).toContain("Ferramentas > Cange");
  });

  it("access request sem alvo, com dois alvos, id ruim, papel ruim ou motivo vazio: exit 2, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases: string[][] = [
      ["access", "request", "--reason", "x"],
      ["access", "request", "--flow", "1", "--register", "2", "--reason", "x"],
      ["access", "request", "--flow", "abc", "--reason", "x"],
      ["access", "request", "--flow", "1", "--role", "V", "--reason", "x"],
      ["access", "request", "--flow", "1", "--reason", "   "]
    ];
    for (const args of cases) {
      process.exitCode = undefined;
      await run(args);
      expect(process.exitCode, args.join(" ")).toBe(EXIT_CODES.USAGE);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "ACCESS_REQUEST_DISABLED", "Não peça de novo"],
    [404, "ACCESS_TARGET_NOT_FOUND", "nunca invente id"],
    [409, "ALREADY_HAS_ACCESS", "Você já tem esse acesso"],
    [422, "NO_ELIGIBLE_APPROVER", "administrador do ambiente"],
    [429, "ACCESS_REQUEST_COOLDOWN", "foi recusado"],
    [429, "ACCESS_REQUEST_LIMIT", "aguardam alguém liberar"]
  ])("erro %i %s: exit 4 com o próximo passo", async (status, code, hint) => {
    const fetchMock = mockFetch({ status: "error", message: "Recusado pelo Cange.", complement: { code } }, status);
    await run(["access", "request", "--flow", "12064", "--reason", "ler"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // sem retry (429 inclusive)
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const err = JSON.parse(stderr.join(""));
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toContain(hint);
    expect(err.message).not.toContain("—");
  });

  // ---- rodada 8 (D5): --then (tarefa seguinte depois da liberação) ----

  const ECHO_OK = { stored: true, has_goal: true, this_conversation: true, window_min: 120 };

  it("access request --then numa conversa: manda `then` (uma linha) e a saída mostra a continuação combinada", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetch({ ...REQUEST_CREATED, continuation: ECHO_OK }, 201);
    await run([
      "access", "request", "--register", "7946", "--reason", "Ler o saldo dos projetos",
      "--then", "  listar os projetos\n com   saldo positivo "
    ]);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({
      type: "register",
      resource_id: 7946,
      role: "M",
      reason: "Ler o saldo dos projetos",
      then: "listar os projetos com saldo positivo"
    });
    expect(body).not.toHaveProperty("next_task");
    expect(body).not.toHaveProperty("session_id");
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("combinada");
    expect(out.then).toBe("listar os projetos com saldo positivo");
    expect(out.note).toContain(
      "Continuação combinada: se liberarem o acesso em até 2 h e o usuário não escrever nada antes, o Cange retoma esta conversa sozinho"
    );
    expect(out.note).toContain("não peça ao usuário para avisar");
    expect(out.note).toContain("Pedi acesso ao fluxo Compras");
    expect(out.note).not.toContain("—");
    expect(process.exitCode).toBeUndefined();
  });

  it("kit-2: 201 sem o eco do back (back sem a rodada 8), com --then e conversa: NÃO diz combinada nem promete seguir", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    for (const body of [REQUEST_CREATED, { ...REQUEST_CREATED, continuation: { ...ECHO_OK, stored: false, has_goal: false } }]) {
      stdout.length = 0;
      mockFetch(body, 201);
      await run(["access", "request", "--flow", "12064", "--reason", "Ler", "--then", "listar os pedidos"]);
      const out = JSON.parse(stdout.join(""));
      expect(out.continuation).toBe("não confirmada");
      expect(out).not.toHaveProperty("then");
      expect(out.note).not.toContain("Continuação combinada");
      expect(out.note).not.toContain("não peça ao usuário para avisar");
      expect(out.note).toContain("Não prometa ao usuário que vai seguir sozinho");
    }
  });

  it("kit-4: sem --then numa conversa, com o back confirmando, diz que o Cange retoma com o pedido original", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    mockFetch({ ...REQUEST_CREATED, continuation: { ...ECHO_OK, has_goal: false } }, 201);
    await run(["access", "request", "--register", "7946", "--reason", "ler saldo"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("combinada");
    expect(out).not.toHaveProperty("then");
    expect(out.note).toContain("o Cange retoma esta conversa sozinho");
    expect(out.note).toContain("com o pedido original do usuário");
    expect(out.note).toContain("não peça ao usuário para avisar");
    expect(out.note).toContain("passe --then");
  });

  it("access request sem --then: corpo e saída como antes (sem then nem continuation)", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetch(REQUEST_CREATED, 201);
    await run(["access", "request", "--flow", "12064", "--reason", "Ler os pedidos"]);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).not.toHaveProperty("then");
    const out = JSON.parse(stdout.join(""));
    expect(out).not.toHaveProperty("continuation");
    expect(out).not.toHaveProperty("then");
    expect(out.note).not.toContain("Continuação");
  });

  it("access request --then em pedido que já aguardava (200 deduped): avisa que o --then novo não vale", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetch({ ...REQUEST_CREATED, deduped: true }, 200);
    await run(["access", "request", "--flow", "12064", "--reason", "Ler", "--then", "listar os pedidos"]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).then).toBe("listar os pedidos");
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("pedido anterior");
    expect(out).not.toHaveProperty("then");
    expect(out.note).toContain("já estava aguardando decisão");
    expect(out.note).toContain("NÃO foi guardado");
    expect(out.note).not.toContain("Continuação combinada");
  });

  it("kit-7: dedupe de pedido aberto em OUTRA conversa não diz que vale o combinado", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "230";
    mockFetch({ ...REQUEST_CREATED, deduped: true, continuation: { ...ECHO_OK, this_conversation: false } }, 200);
    await run(["access", "request", "--register", "7946", "--reason", "Ler", "--then", "somar o saldo"]);
    let out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("pedido anterior");
    expect(out.note).toContain("talvez em outra conversa");
    expect(out.note).toContain("esta conversa pode não seguir sozinha");
    expect(out.note).not.toContain("vale o que ficou combinado");
    // Mesmo pendente desta conversa: vale a tarefa guardada nele.
    stdout.length = 0;
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    mockFetch({ ...REQUEST_CREATED, deduped: true, continuation: ECHO_OK }, 200);
    await run(["access", "request", "--register", "7946", "--reason", "Ler", "--then", "somar o saldo"]);
    out = JSON.parse(stdout.join(""));
    expect(out.note).toContain("já estava aberto nesta conversa");
    expect(out.note).toContain("vale a tarefa combinada nele");
  });

  it("access request --then fora de conversa (sem RUNNER_CHAT_SESSION_ID): manda, mas não promete seguir sozinho", async () => {
    delete process.env.RUNNER_CHAT_SESSION_ID;
    const fetchMock = mockFetch(REQUEST_CREATED, 201);
    await run(["access", "request", "--flow", "12064", "--reason", "Ler", "--then", "listar os pedidos"]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).then).toBe("listar os pedidos");
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("sem conversa");
    expect(out).not.toHaveProperty("then");
    expect(out.note).toContain("não é de uma conversa");
    expect(out.note).not.toContain("Continuação combinada");
  });

  it("access request --then longo: o corpo leva a linha inteira (até 4.000) e a saída mostra o que o back guarda (1.000)", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetch({ ...REQUEST_CREATED, continuation: ECHO_OK }, 201);
    const long = "t".repeat(1500);
    await run(["access", "request", "--flow", "12064", "--reason", "Ler", "--then", long]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).then).toBe(long);
    const out = JSON.parse(stdout.join(""));
    expect(out.then).toHaveLength(1000);
    expect(out.then.endsWith("…")).toBe(true);
  });

  it("access request --then vazio ou acima de 4.000: exit 2, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const value of ["   ", "x".repeat(4001)]) {
      process.exitCode = undefined;
      stderr.length = 0;
      await run(["access", "request", "--flow", "12064", "--reason", "Ler", "--then", value]);
      expect(process.exitCode).toBe(EXIT_CODES.USAGE);
      expect(stderr.join("")).toContain("--then");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("help do access request documenta --then; nota do catálogo ensina a passar a tarefa seguinte", async () => {
    type Cmd = { name(): string; commands: readonly Cmd[]; options: readonly { long?: string; description: string; required?: boolean }[] };
    const program = createProgram() as unknown as Cmd;
    const request = program.commands.find((c) => c.name() === "access")!.commands[0]!;
    const then = request.options.find((o) => o.long === "--then")!;
    expect(then.required).toBe(true); // leva valor (o gate do runner precisa de "then" em VALUE_FLAGS)
    expect(then.description).toContain("o usuário não precisa avisar");
    mockFetch(CATALOG);
    await run(["catalog"]);
    expect(JSON.parse(stdout.join("")).note).toContain("--then");
  });

  it("árvore do CLI: catalog é leitura; access request é escrita", () => {
    type Cmd = { name(): string; commands: readonly Cmd[] };
    const program = createProgram() as unknown as Cmd;
    const catalog = program.commands.find((c) => c.name() === "catalog")!;
    const access = program.commands.find((c) => c.name() === "access")!;
    expect(catalog.commands).toHaveLength(0);
    expect(access.commands.map((c) => c.name())).toEqual(["request"]);
    expect(getCommandMeta(catalog as never)?.mutates).toBeUndefined();
    expect(getCommandMeta(access.commands[0] as never)?.mutates).toBe(true);
  });
});

// Bancada F2-F6 (t06, frio 5 min rep 3 e quente rep 1): depois do "sem acesso" no
// fluxo 316, o agente procurou `catalog --q 316`; o back busca só pelo nome, não
// achou e o agente perguntou ao usuário em vez de pedir acesso. Agora número, link
// ou hash procuram também pelo id, na MESMA lista do catálogo (sem revelar nada a mais).
describe("parseCatalogQuery (sem rede)", () => {
  const HASH = "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901";

  it("número (com ou sem #) procura pelo id e pelo nome", () => {
    expect(parseCatalogQuery("316", "all")).toEqual({ kind: "id", id: 316, q: "316" });
    expect(parseCatalogQuery(" #316 ", "flow")).toEqual({ kind: "id", id: 316, q: "316" });
  });

  it("texto, número com letra, zero à esquerda e vazio seguem pelo nome", () => {
    expect(parseCatalogQuery("compras", "all")).toEqual({ kind: "name", q: "compras" });
    expect(parseCatalogQuery("316a", "all")).toEqual({ kind: "name", q: "316a" });
    expect(parseCatalogQuery("0316", "all")).toEqual({ kind: "name", q: "0316" });
    expect(parseCatalogQuery("fluxo 316", "all")).toEqual({ kind: "name", q: "fluxo 316" });
    expect(parseCatalogQuery(undefined, "all")).toEqual({ kind: "name" });
    expect(parseCatalogQuery("99999999999999999999", "all")).toEqual({ kind: "name", q: "99999999999999999999" });
  });

  it("link do Cange dá o id ou o hash do fluxo/cadastro; link só de cartão não traz o fluxo", () => {
    expect(parseCatalogQuery("cange://card/9?flow=316", "register")).toEqual({
      kind: "ref",
      refs: [{ type: "flow", ref: { kind: "id", id: "316" } }],
      source: "link",
      cardOnly: false
    });
    expect(parseCatalogQuery(`https://app.cange.me/register/${HASH}`, "all")).toMatchObject({
      kind: "ref",
      refs: [{ type: "register", ref: { kind: "hash", hash: HASH } }]
    });
    expect(parseCatalogQuery("cange://card/9", "all")).toEqual({ kind: "ref", refs: [], source: "link", cardOnly: true });
  });

  it("hash solto (hex) vale para os tipos do --type; palavra comum não é hash", () => {
    expect(parseCatalogQuery(HASH, "all")).toEqual({
      kind: "ref",
      refs: [
        { type: "flow", ref: { kind: "hash", hash: HASH } },
        { type: "register", ref: { kind: "hash", hash: HASH } }
      ],
      source: "hash",
      cardOnly: false
    });
    expect(parseCatalogQuery(HASH, "register")).toMatchObject({ refs: [{ type: "register" }] });
    expect(parseCatalogQuery("fornecedoresativos", "all")).toEqual({ kind: "name", q: "fornecedoresativos" });
  });
});

describe("cange catalog pelo número, link ou hash (bancada t06)", () => {
  const HASH = "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901";
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  let handler: (method: string, path: string, query: URLSearchParams) => { status: number; body: unknown };

  const item = (id: number, name: string, type: "flow" | "register", hasAccess: boolean, role: string | null = null) => ({
    id,
    name,
    type,
    has_access: hasAccess,
    role,
    requestable: !hasAccess
  });
  const list = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    anchor: { kind: "conversation", name: "Matheus" },
    scope: "anchor_and_agent",
    items,
    total: items.length,
    truncated: false,
    ...extra
  });

  /** Catálogo por tipo (o que o back devolve sem `q`) e a busca pelo nome (com `q`). */
  function catalogHandler(byType: Record<string, unknown>, byName: unknown = list([])) {
    return (method: string, path: string, query: URLSearchParams) => {
      if (method === "GET" && path.endsWith("/agent-run/catalog")) {
        if (query.get("q") !== null) return { status: 200, body: byName };
        return { status: 200, body: byType[query.get("type") ?? ""] ?? list([]) };
      }
      return { status: 404, body: { message: "Não foi possivel encontrar o fluxo ou você não possuí acesso" } };
    };
  }

  beforeEach(() => {
    delete process.env.CANGE_OUTPUT_PROFILE;
    process.env.CANGE_ACCESS_TOKEN = TOKEN;
    stdout.length = 0;
    stderr.length = 0;
    requests.length = 0;
    handler = () => ({ status: 404, body: { message: "rota não mockada" } });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(/\/+$/, "");
      requests.push({ method, path, query: url.searchParams });
      const response = handler(method, path, url.searchParams);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    });
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  const catalogCalls = () =>
    requests.filter((r) => r.path.endsWith("/agent-run/catalog")).map((r) => r.query.toString());

  it("--q 316 (caso da bancada): acha o fluxo sem acesso pelo id, primeiro, com o pedido pronto, e ainda busca pelo nome", async () => {
    handler = catalogHandler(
      {
        flow: list([item(12, "Compras", "flow", true, "M"), item(316, "Projetos Capex", "flow", false), item(900, "Pedido 316", "flow", false)]),
        register: list([item(44, "Fornecedores", "register", true)])
      },
      list([item(900, "Pedido 316", "flow", false)])
    );
    await run(["catalog", "--q", "316"]);
    expect(process.exitCode).toBeUndefined();
    expect(catalogCalls()).toEqual(["type=all&q=316", "type=flow&limit=500", "type=register&limit=500"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([
      {
        id: 316,
        name: "Projetos Capex",
        type: "flow",
        access: "não",
        match: "id",
        request: 'cange access request --flow 316 --reason "<por que precisa>"'
      },
      { id: 900, name: "Pedido 316", type: "flow", access: "não" }
    ]);
    expect(out.total).toBe(2);
    expect(out.note).toContain("O fluxo 316 está no seu catálogo e você não tem acesso");
    expect(out.note).toContain("sem perguntar ao usuário se deve pedir");
    expect(out.note).toContain("--then");
    // O item 900 veio pelo nome: a nota geral de pedido continua.
    expect(out.note).toContain('Para um item com access "não"');
    expect(out.note).not.toContain("Nada encontrado");
    expect(out.note).not.toContain("—");
    // Nome do recurso é dado: não entra na nota.
    expect(out.note).not.toContain("Projetos Capex");
  });

  it("--search '#316' --type flow: só a lista de fluxos; achado pelo nome e pelo id sai uma vez só", async () => {
    handler = catalogHandler(
      { flow: list([item(316, "Obra 316", "flow", false)]) },
      list([item(316, "Obra 316", "flow", false)])
    );
    await run(["catalog", "--type", "flow", "--search", "#316"]);
    expect(catalogCalls()).toEqual(["type=flow&q=316", "type=flow&limit=500"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: 316, match: "id", access: "não" });
    expect(out.total).toBe(1);
    expect(out.note).not.toContain('Para um item com access "não"');
  });

  it("id fora do catálogo (lista completa): não pede, não diz que não existe, nada de `request`", async () => {
    handler = catalogHandler({ flow: list([item(12, "Compras", "flow", true, "M")]), register: list([]) });
    await run(["catalog", "--q", "316"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([]);
    expect(out.note).toContain("O id 316 não está entre os fluxos e cadastros do seu catálogo");
    expect(out.note).toContain("não peça acesso por ele");
    expect(out.note).toContain("não diga que não existe");
    expect(out.note).not.toContain("cange access request --flow 316");
    expect(out.note).not.toContain("Nada encontrado com esse filtro");
  });

  it("lista do tipo cortada no teto (500) e o id não veio: manda ao nome ou ao pedido direto (que não cria nada fora do catálogo)", async () => {
    const flows = Array.from({ length: 500 }, (_, i) => item(1000 + i, `F${i}`, "flow", true, "M"));
    handler = catalogHandler({ flow: list(flows, { total: 731, truncated: true }) });
    await run(["catalog", "--type", "flow", "--q", "316"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([]);
    expect(out.note).toContain("não apareceu nos 500 primeiros fluxos");
    expect(out.note).toContain('cange access request --flow 316 --reason "<por que precisa>"');
    expect(out.note).toContain("sem criar nada");
  });

  it("id no catálogo COM acesso: lê direto, sem pedir", async () => {
    handler = catalogHandler({ flow: list([item(316, "Projetos", "flow", true, "M")]), register: list([]) });
    await run(["catalog", "--q", "316"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([{ id: 316, name: "Projetos", type: "flow", access: "sim", role: "M", match: "id" }]);
    expect(out.note).toContain("você já tem acesso: leia direto");
  });

  it("mesmo número como fluxo e como cadastro: os dois aparecem, cada um com o seu pedido", async () => {
    handler = catalogHandler({
      flow: list([item(316, "Projetos", "flow", false)]),
      register: list([item(316, "Clientes", "register", false, "V")])
    });
    await run(["catalog", "--q", "316"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items.map((i: { type: string; request: string }) => [i.type, i.request])).toEqual([
      ["flow", 'cange access request --flow 316 --reason "<por que precisa>"'],
      ["register", 'cange access request --register 316 --reason "<por que precisa>"']
    ]);
  });

  it("--limit não corta o achado pelo id", async () => {
    handler = catalogHandler(
      { flow: list([item(316, "Projetos", "flow", false)]), register: list([]) },
      list([item(1, "A316", "flow", true, "M"), item(2, "B316", "flow", true, "M")], { total: 2 })
    );
    await run(["catalog", "--q", "316", "--limit", "1"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([316]);
    expect(out.truncated).toBe(true);
  });

  it("link com o id do fluxo (menção do chat): só a busca pelo id, sem busca pelo nome", async () => {
    handler = catalogHandler({ flow: list([item(316, "Projetos", "flow", false)]) });
    await run(["catalog", "--q", "cange://card/9?flow=316"]);
    expect(catalogCalls()).toEqual(["type=flow&limit=500"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items[0]).toMatchObject({ id: 316, match: "id", request: 'cange access request --flow 316 --reason "<por que precisa>"' });
  });

  it("link com hash que abre (agente acessa): troca pelo id e acha no catálogo", async () => {
    const base = catalogHandler({ register: list([item(7946, "Projetos", "register", true, "M")]) });
    handler = (method, path, query) => {
      if (path.endsWith("/register") && query.get("hash") === HASH) return { status: 200, body: { id_register: 7946, hash: HASH } };
      return base(method, path, query);
    };
    await run(["catalog", "--q", `https://app.cange.me/register/${HASH}`]);
    expect(catalogCalls()).toEqual(["type=register&limit=500"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items[0]).toMatchObject({ id: 7946, type: "register", access: "sim", match: "id" });
  });

  it("link ou hash SEM acesso (404 no GET por hash): não chama o catálogo e manda procurar pelo nome", async () => {
    handler = catalogHandler({});
    for (const q of [`https://app.cange.me/flow/${HASH}`, HASH]) {
      stdout.length = 0;
      requests.length = 0;
      await run(["catalog", "--q", q]);
      expect(process.exitCode, q).toBeUndefined();
      expect(catalogCalls()).toEqual([]);
      const out = JSON.parse(stdout.join(""));
      expect(out.items).toEqual([]);
      expect(out.note).toContain("sem acesso, então não sei o id");
      expect(out.note).toContain("cange catalog --q <nome>");
      expect(out.note).toContain("Não diga que não existe");
    }
    // Hash solto com --type all: tentou fluxo e cadastro.
    expect(requests.filter((r) => r.query.get("hash") === HASH).map((r) => r.path.split("/").pop())).toEqual(["flow", "register"]);
  });

  it("hash solto que abre como fluxo não tenta cadastro", async () => {
    const base = catalogHandler({ flow: list([item(316, "Projetos", "flow", true, "A")]) });
    handler = (method, path, query) => {
      if (path.endsWith("/flow") && query.get("hash") === HASH) return { status: 200, body: { id_flow: 316, hash: HASH } };
      return base(method, path, query);
    };
    await run(["catalog", "--q", HASH]);
    expect(requests.filter((r) => r.query.get("hash") === HASH)).toHaveLength(1);
    const out = JSON.parse(stdout.join(""));
    expect(out.items[0]).toMatchObject({ id: 316, match: "id" });
    expect(out.note).not.toContain("não sei o id");
  });

  it("link só de cartão: diz que o link não traz o fluxo", async () => {
    handler = catalogHandler({});
    await run(["catalog", "--q", "cange://card/9"]);
    expect(catalogCalls()).toEqual([]);
    expect(JSON.parse(stdout.join("")).note).toContain("link é de um cartão e não traz o fluxo");
  });

  it("--raw com número traz as duas respostas cruas; --full marca o achado e traz o pedido", async () => {
    const flows = list([item(316, "Projetos", "flow", false)]);
    handler = catalogHandler({ flow: flows }, list([]));
    await run(["catalog", "--type", "flow", "--q", "316", "--raw"]);
    expect(JSON.parse(stdout.join(""))).toEqual({ byName: list([]), byId: [flows] });

    stdout.length = 0;
    await run(["catalog", "--type", "flow", "--q", "316", "--full"]);
    const full = JSON.parse(stdout.join(""));
    expect(full.items[0]).toMatchObject({
      id: 316,
      hasAccess: false,
      matchedBy: "id",
      request: 'cange access request --flow 316 --reason "<por que precisa>"'
    });
  });

  it("texto continua uma busca só pelo nome (sem a lista inteira)", async () => {
    handler = catalogHandler({}, list([item(12064, "Compras", "flow", false)]));
    await run(["catalog", "--q", "compras"]);
    expect(catalogCalls()).toEqual(["type=all&q=compras"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.items).toEqual([{ id: 12064, name: "Compras", type: "flow", access: "não" }]);
  });

  it("falha do back na busca pelo id (5xx) sobe como erro de API", async () => {
    handler = (method, path, query) =>
      query.get("q") !== null
        ? { status: 200, body: list([]) }
        : { status: 500, body: { message: "Erro interno" } };
    await run(["catalog", "--type", "flow", "--q", "316"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
  });
});
