import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeApiError, CangeCliUsageError } from "../src/client/errors.js";
import { recipeNames, renderRecipe } from "../src/cli/commands/recipe.js";
import { SEARCH_SUGGESTION, editDistance, suggestForUnknownCommand } from "../src/cli/command-suggest.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram, runCli } from "../src/cli/index.js";
import {
  NO_ACCESS_LINK_HINT,
  normalizeIdOptions,
  parseCangeLink,
  parseResourceRef,
  resolveResourceId
} from "../src/cli/resource-ref.js";

// P7 (05/10, card #1367450): sinônimos de busca, ids por número/link/hash e
// sugestão do comando certo. Evidência: 91 turnos em 16 runs procurando como usar o kit.

const envBackup = { ...process.env };
const HASH = "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901";

describe("parseResourceRef / parseCangeLink (sem rede)", () => {
  it("número (com ou sem #) passa direto", () => {
    expect(parseResourceRef("7946", "register")).toEqual({ kind: "id", id: "7946" });
    expect(parseResourceRef(" #1121230 ", "card")).toEqual({ kind: "id", id: "1121230" });
  });

  it("link do cadastro e do fluxo dão o hash; link com id numérico dá o id", () => {
    expect(parseResourceRef(`https://app.cange.me/register/${HASH}`, "register")).toEqual({ kind: "hash", hash: HASH });
    expect(parseResourceRef(`https://app.cange.me/register/${HASH}/register/55`, "register")).toEqual({
      kind: "hash",
      hash: HASH
    });
    expect(parseResourceRef(`https://app.cange.me/flow/${HASH}`, "flow")).toEqual({ kind: "hash", hash: HASH });
    expect(parseResourceRef(`/flow/1/${HASH}/edit`, "flow")).toEqual({ kind: "hash", hash: HASH });
    expect(parseResourceRef("app.cange.me/flow/12064", "flow")).toEqual({ kind: "id", id: "12064" });
  });

  it("link do cartão dá o cartão e o fluxo; cange://card e query também", () => {
    const link = `https://app.cange.me/flow/${HASH}/card/1121230`;
    expect(parseResourceRef(link, "card")).toEqual({ kind: "id", id: "1121230" });
    expect(parseResourceRef(link, "flow")).toEqual({ kind: "hash", hash: HASH });
    expect(parseCangeLink("cange://card/1121230?flow=192")).toEqual({
      cardId: "1121230",
      flow: { kind: "id", id: "192" }
    });
    expect(parseCangeLink(`https://app.cange.me/flow/${HASH}?card_id=77`)?.cardId).toBe("77");
  });

  it("hash solto vale para fluxo e cadastro, não para cartão", () => {
    expect(parseResourceRef(HASH, "register")).toEqual({ kind: "hash", hash: HASH });
    expect(() => parseResourceRef(HASH, "card", "--card-id")).toThrow(CangeCliUsageError);
  });

  it("link sem o recurso pedido e valor inválido: erro de uso que diz onde achar o id", () => {
    expect(() => parseResourceRef(`https://app.cange.me/flow/${HASH}`, "card", "--card-id")).toThrow(
      /link não traz um cartão/
    );
    expect(() => parseResourceRef(`https://app.cange.me/flow/${HASH}`, "register")).toThrow(/cange my-registers/);
    expect(() => parseResourceRef("abc", "flow", "--flow")).toThrow(/--flow precisa do id numérico/);
    expect(() => parseResourceRef("0", "register")).toThrow(CangeCliUsageError);
    expect(() => parseCangeLink("7946")).not.toThrow();
    expect(parseCangeLink("7946")).toBeUndefined();
  });
});

describe("resolveResourceId (hash → id)", () => {
  it("resolve o hash pelo resolvedor", async () => {
    const resolver = vi.fn(async () => 7946);
    await expect(resolveResourceId(HASH, "register", resolver)).resolves.toBe("7946");
    expect(resolver).toHaveBeenCalledWith("register", HASH);
  });

  it("sem acesso (404) ou sem resolvedor: erro acionável de 1 linha, sem travessão", async () => {
    const notFound = vi.fn(async () => {
      throw new CangeApiError("não encontrado", { status: 404 });
    });
    const error = await resolveResourceId(HASH, "register", notFound).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CangeCliUsageError);
    const message = (error as Error).message;
    expect(message).toContain("Isso parece o hash do link");
    expect(message).toContain("use o id numérico");
    expect(message).toContain("cange my-registers / cange catalog");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("—");
    await expect(resolveResourceId(HASH, "flow", undefined)).rejects.toThrow(/cange my-flows \/ cange catalog/);
  });

  it("5xx não vira erro de uso (o agente não errou)", async () => {
    const down = vi.fn(async () => {
      throw new CangeApiError("fora do ar", { status: 503 });
    });
    await expect(resolveResourceId(HASH, "flow", down)).rejects.toBeInstanceOf(CangeApiError);
  });
});

describe("normalizeIdOptions (parser único dos comandos)", () => {
  function fakeCommand(): Command {
    return new Command("get").option("--flow-id <id>").option("--card-id <id>");
  }

  it("link do cartão preenche o --flow-id ausente; lista de cartões aceita links", async () => {
    const resolver = vi.fn(async () => 192);
    const options: Record<string, unknown> = { cardId: `https://app.cange.me/flow/${HASH}/card/555` };
    await normalizeIdOptions(options, resolver, fakeCommand());
    expect(options).toEqual({ cardId: "555", flowId: "192" });

    const many: Record<string, unknown> = { cardIds: "1, #2, cange://card/3" };
    await normalizeIdOptions(many, undefined, fakeCommand());
    expect(many.cardIds).toBe("1,2,3");
  });

  it("não chama a rede para número e não mexe em opção que não é id", async () => {
    const resolver = vi.fn();
    const options: Record<string, unknown> = { flowId: "192", registerId: "#7946", search: "acme", limit: "5" };
    await normalizeIdOptions(options, resolver, fakeCommand());
    expect(options).toEqual({ flowId: "192", registerId: "7946", search: "acme", limit: "5" });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("sugestão de comando (commander)", () => {
  it("casos fixos e hífen", () => {
    const program = createProgram();
    expect(suggestForUnknownCommand(program, ["node", "cange", "search", "acme"])).toBe(
      `Comando "search" não existe.\n${SEARCH_SUGGESTION}`
    );
    expect(
      suggestForUnknownCommand(program, ["node", "cange", "--output", "json", "register-entries", "--register-id", "7946"])
    ).toBe('Comando "register-entries" não existe.\nVocê quis dizer: cange --output json register entries --register-id 7946');
  });

  it("subcomando de um grupo só, distância de edição e caso sem sugestão clara", () => {
    const program = createProgram();
    expect(suggestForUnknownCommand(program, ["node", "cange", "entries", "--q", "x"])).toContain(
      "Você quis dizer: cange register entries --q x"
    );
    expect(suggestForUnknownCommand(program, ["node", "cange", "register", "entires"])).toBe(
      'Comando "entires" não existe em cange register.\nVocê quis dizer: cange register entries'
    );
    expect(suggestForUnknownCommand(program, ["node", "cange", "catalgo"])).toContain("cange catalog");
    const none = suggestForUnknownCommand(program, ["node", "cange", "automation"]);
    expect(none).toContain('Comando "automation" não existe.');
    expect(none).toContain("cange manifest --output json");
    expect(none?.split("\n")).toHaveLength(2);
    expect(suggestForUnknownCommand(program, ["node", "cange", "my-flows"])).toBeUndefined();
  });

  it("editDistance", () => {
    expect(editDistance("entires", "entries")).toBe(2);
    expect(editDistance("catalog", "catalog")).toBe(0);
  });
});

describe("CLI (fetch mockado)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown }> = [];
  let handler: (method: string, path: string, query: URLSearchParams) => { status: number; body: unknown };

  beforeEach(() => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    delete process.env.CANGE_OUTPUT_PROFILE;
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
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const path = url.pathname.replace(/\/+$/, "");
      requests.push({ method, path, query: url.searchParams, body });
      const response = handler(method, path, url.searchParams);
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" }
      });
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

  it("register entries: link do cadastro vira id e --q é sinônimo de --search", async () => {
    handler = (method, path, query) => {
      if (path.endsWith("/register/v2/query-engine-status")) return { status: 200, body: { use_query_v2: "N" } };
      if (path.endsWith("/register") && query.get("hash") === HASH) {
        return { status: 200, body: { id_register: 7946, hash: HASH, name: "Clientes" } };
      }
      if (path.endsWith("/register") && query.get("id_register") === "7946") {
        return { status: 200, body: { id_register: 7946, answers: [] } };
      }
      return { status: 404, body: { message: `${method} ${path}` } };
    };
    await run(["register", "entries", "--register-id", `https://app.cange.me/register/${HASH}`, "--q", "acme"]);
    expect(process.exitCode).toBeUndefined();
    const list = requests.find((r) => r.path.endsWith("/register") && r.query.get("id_register") === "7946");
    expect(list?.query.get("likeSearch")).toBe("acme");
    expect(requests.some((r) => r.query.get("hash") === HASH)).toBe(true);
  });

  it("register get --register <hash> sem acesso: exit 2 com a frase do hash", async () => {
    handler = () => ({ status: 404, body: { message: "Não foi possivel encontrar o cadastro" } });
    await run(["register", "get", "--register", HASH]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("Isso parece o hash do link");
  });

  it("access request --register com link: resolve o hash e pede pelo id", async () => {
    handler = (_method, path, query) => {
      if (path.endsWith("/register") && query.get("hash") === HASH) return { status: 200, body: { id_register: 7001 } };
      if (path.endsWith("/agent-run/access-request")) {
        return { status: 201, body: { approval_id: 9, status: "pending", resource_type: "register", resource_id: 7001, who_can_approve: [] } };
      }
      return { status: 404, body: {} };
    };
    await run(["access", "request", "--register", `https://app.cange.me/register/${HASH}`, "--reason", "ler"]);
    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ type: "register", resource_id: 7001, role: "M", reason: "ler" });
  });

  it("access request com link ou hash SEM acesso (caso real: 404 no GET por hash): manda ao catálogo, sem pedir nada", async () => {
    // K1 (review kit#22): o recurso do pedido é, por definição, um que o agente não acessa;
    // GET /register?hash= e GET /flow?hash= respondem 404 justamente por isso.
    handler = (method, path) => {
      if (method === "GET" && (path.endsWith("/register") || path.endsWith("/flow"))) {
        return { status: 404, body: { message: "Não foi possivel encontrar o cadastro ou você não possuí acesso" } };
      }
      return { status: 201, body: { approval_id: 9, status: "pending", who_can_approve: [] } };
    };
    const cases: string[][] = [
      ["access", "request", "--register", `https://app.cange.me/register/${HASH}`, "--reason", "ler"],
      ["access", "request", "--flow", HASH, "--reason", "ler"]
    ];
    for (const args of cases) {
      process.exitCode = undefined;
      stderr.length = 0;
      await run(args);
      expect(process.exitCode, args.join(" ")).toBe(EXIT_CODES.USAGE);
      const message = JSON.parse(stderr.join("")).message as string;
      expect(message).toBe(NO_ACCESS_LINK_HINT);
      expect(message).not.toContain("\n");
      expect(message).not.toContain("—");
    }
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(requests.some((r) => r.query.get("hash") === HASH)).toBe(true);
  });

  it("help do access request não promete hash nem link", () => {
    const access = createProgram().commands.find((c) => c.name() === "access")!;
    const request = access.commands.find((c) => c.name() === "request")!;
    for (const long of ["--flow", "--register"]) {
      const description = request.options.find((o) => o.long === long)?.description ?? "";
      expect(description).toContain("Id numérico");
      expect(description).not.toMatch(/hash|link/i);
    }
  });

  it("catalog --search é sinônimo de --q", async () => {
    handler = () => ({ status: 200, body: { anchor: null, scope: "agent_only", items: [], total: 0, truncated: false } });
    await run(["catalog", "--search", "compras"]);
    expect(requests[0]?.query.get("q")).toBe("compras");
  });

  it("my-registers e my-flows filtram por --q/--search", async () => {
    handler = (_method, path) => {
      if (path.endsWith("/register/my-registers") || path.includes("register")) {
        return { status: 200, body: [{ id_register: 1, name: "Clientes" }, { id_register: 2, name: "Fornecedores" }] };
      }
      return { status: 200, body: [{ id_flow: 10, name: "Compras" }, { id_flow: 11, name: "Vendas" }] };
    };
    await run(["my-registers", "--q", "client"]);
    expect(JSON.parse(stdout.join("")).summaries.map((s: { title: string }) => s.title)).toEqual(["Clientes"]);
    stdout.length = 0;
    await run(["my-flows", "--search", "vend"]);
    expect(JSON.parse(stdout.join("")).summaries.map((s: { title: string }) => s.title)).toEqual(["Vendas"]);
  });

  it("card list e flow query aceitam --q (vai como busca do V2)", () => {
    const program = createProgram();
    const card = program.commands.find((c) => c.name() === "card")!;
    const list = card.commands.find((c) => c.name() === "list")!;
    const flow = program.commands.find((c) => c.name() === "flow")!;
    const query = flow.commands.find((c) => c.name() === "query")!;
    for (const command of [list, query]) {
      const longs = command.options.map((o) => o.long);
      expect(longs).toContain("--search");
      expect(longs).toContain("--q");
    }
  });

  it("card update aceita --validate-fields sem efeito (dry-run)", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const payload = join(tmpdir(), `p7-card-update-${Date.now()}.json`);
    await writeFile(payload, JSON.stringify({ flowId: 192, cardId: 5, complete: "S" }), "utf8");
    try {
      await run(["card", "update", "--payload", payload, "--validate-fields", "--dry-run"]);
    } finally {
      await unlink(payload);
    }
    expect(process.exitCode).toBeUndefined();
    expect(stdout.join("")).toContain('"dryRun":true');
  });

  it("runCli: `cange search` responde com a sugestão e exit 2", async () => {
    await runCli(["node", "cange", "search", "acme"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const err = stderr.join("");
    expect(err).toContain("cange register entries --register <id> --search <texto>");
    expect(err).toContain("cange catalog --q <texto>");
    expect(requests).toHaveLength(0);
  });

  it("runCli: `cange register-entries` sugere `register entries`", async () => {
    await runCli(["node", "cange", "register-entries", "--register-id", "1"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("Você quis dizer: cange register entries --register-id 1");
  });
});

describe("receita cadastro-por-nome", () => {
  it("está listada e ensina o caminho sem `cange search`", () => {
    expect(recipeNames()).toContain("cadastro-por-nome");
    const text = renderRecipe("cadastro-por-nome", {});
    expect(text).toContain("cange register entries --register-id <id> --search");
    expect(text).toContain("`--q` é sinônimo");
    expect(text).toContain("cange catalog --type register");
    expect(text).not.toContain("—");
  });
});
