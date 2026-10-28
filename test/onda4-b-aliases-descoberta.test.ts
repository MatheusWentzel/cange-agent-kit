import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildManifest } from "../src/cli/command-metadata.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { flowPlacement } from "../src/cli/commands/flow-build/flow.js";
import { renderRecipe } from "../src/cli/commands/recipe.js";
import { createProgram, runCli } from "../src/cli/index.js";
import { applyOptionAliases } from "../src/cli/option-aliases.js";
import { cardNotVisibleMessage, FLOW_FROM_CARD_HINT } from "../src/cli/resource-ref.js";

/**
 * Onda 4, bloco B (N5, N6 e N10 da análise de produção de 06 a 28/10):
 *  1. nomes errados de opção com equivalente único rodam sem aviso (alias);
 *  2. `card relationship` descobre o fluxo pelo cartão;
 *  3. `recipe <nome> --file <arquivo>` põe o caminho no lugar do exemplo;
 *  4. locate 403/404 vira "o agente não enxerga o cartão N";
 *  5. `flow-build flow create` diz o estado e onde o fluxo aparece.
 * Fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
let routes: Record<string, { status?: number; body: unknown }> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FLOW = {
  id_flow: 316,
  name: "CNG CRM",
  form_init_id: 900,
  flow_steps: [{ id_step: 1, name: "Triagem", form_id: 901, index: 1 }]
};
const FIELDS = [{ id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900 }];
const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  flow_step: { id_step: 1, name: "Triagem" },
  form_answers: [{ id_form_answer: 700, form_id: 900, form_answer_fields: [{ field_id: 20, value: "Pedido ACME" }] }]
};

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of [
    "CANGE_OUTPUT_PROFILE",
    "CANGE_OUTPUT_FORMAT",
    "CANGE_FORCE_DRY_RUN",
    "CANGE_APP_ORIGIN",
    "RUNNER_FLOW_ID",
    "CANGE_CARD_FLOW_ID",
    "CANGE_FLOW_ID",
    "RUNNER_CARD_ID",
    "CANGE_CARD_ID",
    "RUNNER_SPEAKER_USER_ID",
    "TMPDIR"
  ]) {
    delete process.env[name];
  }
  process.env.CANGE_BUSY_RETRY_MS = "5";
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  routes = {
    "GET /card/locate": { body: { id_card: 55, flow_id: 316, flow_name: "CNG CRM" } },
    "GET /flow": { body: FLOW },
    "GET /field/by-flow": { body: FIELDS },
    "GET /card": { body: CARD },
    "GET /card/relationship": { body: { formsAnswerFields: [], cards: [], registerAnswers: [] } },
    "GET /user/by-flow": { body: [{ id_user: 8, name: "Ana Souza", email: "ana@acme.com" }] },
    "GET /user/by-company": { body: [{ id_user: 8, name: "Ana Souza", email: "ana@acme.com" }] },
    "POST /card-comment": { body: { id_card_comment: 901, card_id: 55 } }
  };
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
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace(/\/+$/, "");
    requests.push({ method, path, query: url.searchParams, body });
    const route = routes[`${method} ${path}`];
    if (!route) return json({ message: `rota não mockada: ${method} ${path}` }, 404);
    return json(route.body, route.status ?? 200);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Pela entrada real da CLI (`runCli`), onde o alias vale. */
async function cli(args: string[]): Promise<Record<string, any> | undefined> {
  await runCli(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out.trim().startsWith("{") ? (JSON.parse(out) as Record<string, any>) : undefined;
}

function errorMessage(): string {
  return String((JSON.parse(stderr.join("")) as { message: string }).message);
}

function calls(method: string, path: string) {
  return requests.filter((request) => request.method === method && request.path === path);
}

const argv = (...args: string[]) => ["node", "cange", ...args];

describe("1. alias: o nome errado com equivalente único roda", () => {
  it("register entries --limit vira --page-size (as duas formas)", () => {
    const program = createProgram();
    expect(applyOptionAliases(program, argv("register", "entries", "--register-id", "183", "--limit", "50"))).toEqual(
      argv("register", "entries", "--register-id", "183", "--page-size", "50")
    );
    expect(applyOptionAliases(program, argv("register", "entry", "--register-id", "183", "--limit=50"))).toEqual(
      argv("register", "entry", "--register-id", "183", "--page-size=50")
    );
  });

  it("comment create --mentions vira --mention", () => {
    expect(
      applyOptionAliases(createProgram(), argv("comment", "create", "--card-id", "55", "--text", "x", "--mentions", "Ana"))
    ).toEqual(argv("comment", "create", "--card-id", "55", "--text", "x", "--mention", "Ana"));
  });

  it("card get --fields vira --field-ids só com lista de ids; título fica com a mensagem de sempre", () => {
    const program = createProgram();
    expect(applyOptionAliases(program, argv("card", "get", "--card-id", "55", "--fields", "20,30"))).toEqual(
      argv("card", "get", "--card-id", "55", "--field-ids", "20,30")
    );
    const titles = argv("card", "get", "--card-id", "55", "--fields", "Valor,Data");
    expect(applyOptionAliases(program, titles)).toEqual(titles);
  });

  it("recipe --input e --pdf viram --file", () => {
    const program = createProgram();
    expect(applyOptionAliases(program, argv("recipe", "anexo", "--pdf", "/run/a.pdf"))).toEqual(
      argv("recipe", "anexo", "--file", "/run/a.pdf")
    );
    expect(applyOptionAliases(program, argv("recipe", "anexo", "--input", "/run/a.pdf"))).toEqual(
      argv("recipe", "anexo", "--file", "/run/a.pdf")
    );
  });

  it("não troca em outro comando, nem valor de outra opção, nem opção que o comando tem", () => {
    const program = createProgram();
    const otherCommand = argv("card", "list", "--flow-id", "316", "--limit", "5");
    expect(applyOptionAliases(program, otherCommand)).toEqual(otherCommand);
    const asValue = argv("comment", "create", "--card-id", "55", "--text", "--mentions");
    expect(applyOptionAliases(program, asValue)).toEqual(asValue);
    const read = argv("card", "read", "--card-id", "55", "--fields", "Título");
    expect(applyOptionAliases(program, read)).toEqual(read);
  });

  it("runCli: comment create --mentions roda sem aviso e notifica a pessoa", async () => {
    const out = await cli(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "Pronto", "--mentions", "8"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(calls("POST", "/card-comment")[0]?.body?.mentions).toEqual([8]);
    expect(out?.ok).toBe(true);
  });

  it("runCli: card get --fields 20 roda como --field-ids", async () => {
    const out = await cli(["card", "get", "--card-id", "55", "--flow-id", "316", "--fields", "20"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.requestedFieldIds).toEqual(["20"]);
  });

  it("runCli: register entries --limit não vira erro de opção", async () => {
    await cli(["register", "entries", "--register-id", "183", "--limit", "5"]);
    expect(stderr.join("")).not.toContain("não tem a opção --limit");
  });

  it("--help e manifest mostram só o nome oficial", () => {
    const manifest = buildManifest(createProgram());
    const find = (path: string) => {
      const visit = (nodes: typeof manifest.commands): (typeof manifest.commands)[number] | undefined => {
        for (const node of nodes) {
          if (node.path === path) return node;
          const hit = visit(node.subcommands);
          if (hit) return hit;
        }
        return undefined;
      };
      return visit(manifest.commands)!;
    };
    const flags = (path: string) => find(path).options.map((option) => option.flags).join(" ");
    expect(flags("register entries")).not.toContain("--limit");
    expect(flags("comment create")).not.toContain("--mentions");
    expect(flags("card get")).not.toContain("--fields");
    expect(flags("recipe")).not.toMatch(/--input|--pdf/);
    expect(flags("recipe")).toContain("--file");
  });
});

describe("2. card relationship sem --flow-id", () => {
  it("descobre o fluxo pelo cartão de --card-id", async () => {
    const out = await cli(["card", "relationship", "--card-id", "55"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(calls("GET", "/card/locate")).toHaveLength(1);
    const relationship = calls("GET", "/card/relationship")[0];
    expect(relationship?.query.get("flow_id")).toBe("316");
    expect(relationship?.query.get("id_card")).toBe("55");
    expect(out?.resolved).toEqual({ flow_id: 316, flow_name: "CNG CRM", via: "card-locate" });
  });

  it("--flow-id explícito continua valendo (sem locate)", async () => {
    await cli(["card", "relationship", "--card-id", "55", "--flow-id", "400"]);

    expect(calls("GET", "/card/locate")).toEqual([]);
    expect(calls("GET", "/card/relationship")[0]?.query.get("flow_id")).toBe("400");
  });

  it("o cartão do run usa o fluxo do ambiente; outro cartão, o locate", async () => {
    process.env.RUNNER_FLOW_ID = "999";
    process.env.RUNNER_CARD_ID = "55";
    await cli(["card", "relationship", "--card-id", "55"]);
    expect(calls("GET", "/card/locate")).toEqual([]);
    expect(calls("GET", "/card/relationship")[0]?.query.get("flow_id")).toBe("999");

    requests.length = 0;
    stdout.length = 0;
    process.env.RUNNER_CARD_ID = "777";
    await cli(["card", "relationship", "--card-id", "55"]);
    expect(calls("GET", "/card/locate")).toHaveLength(1);
    expect(calls("GET", "/card/relationship")[0]?.query.get("flow_id")).toBe("316");
  });

  it("fluxo no ambiente sem cartão do run: não presume o fluxo (vínculo vazio enganaria)", async () => {
    process.env.RUNNER_FLOW_ID = "999";
    await cli(["card", "relationship", "--card-id", "55"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(calls("GET", "/card/relationship")).toEqual([]);
  });
});

describe("3. recipe com o arquivo da tarefa", () => {
  it("anexo + pdf: o comando do pdftotext sai com o caminho", () => {
    const text = renderRecipe("anexo", {}, "/run/42/anexos/proposta.pdf");
    expect(text).toContain("ARQUIVO = /run/42/anexos/proposta.pdf (já está nos comandos abaixo)");
    expect(text).toContain("pdftotext /run/42/anexos/proposta.pdf ");
    expect(text).not.toContain("<arquivo>.pdf");
    expect(text).toContain('"<arquivo>.docx"');
  });

  it("anexo + docx com espaço: vai entre aspas no unzip", () => {
    const text = renderRecipe("anexo", {}, "/run/42/anexos/Proposta ACME.docx");
    expect(text).toContain("unzip -p '/run/42/anexos/Proposta ACME.docx' word/document.xml");
    expect(text).toContain("<arquivo>.pdf");
  });

  it("caminho relativo vira absoluto; <PASTA_DO_RUN> vira o TMPDIR", () => {
    expect(renderRecipe("enviar-anexo", {}, "saida/relatorio.pdf", "/run/42")).toContain(
      "cange attachment upload --file /run/42/saida/relatorio.pdf"
    );
    expect(renderRecipe("anexo", { TMPDIR: "/run/42/" }, "<PASTA_DO_RUN>/anexos/a.pdf")).toContain(
      "pdftotext /run/42/anexos/a.pdf "
    );
  });

  it("receita sem exemplo de arquivo: só a linha do ARQUIVO", () => {
    const text = renderRecipe("comentar", {}, "/run/42/a.pdf");
    expect(text.split("\n")[1]).toBe("ARQUIVO = /run/42/a.pdf");
  });

  it("runCli: --file, caminho solto e --pdf imprimem a receita (antes: erro de uso)", async () => {
    await cli(["recipe", "anexo", "--file", "/run/42/a.pdf"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("")).toContain("pdftotext /run/42/a.pdf ");

    stdout.length = 0;
    await cli(["recipe", "anexo", "/run/42/b.pdf"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("")).toContain("pdftotext /run/42/b.pdf ");

    stdout.length = 0;
    await cli(["recipe", "anexo", "--pdf", "/run/42/c.pdf"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("")).toContain("pdftotext /run/42/c.pdf ");
  });

  it("dois arquivos diferentes: erro de uso curto", async () => {
    await cli(["recipe", "anexo", "/run/a.pdf", "--file", "/run/b.pdf"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Passe o arquivo uma vez só");
  });
});

describe("4. cartão que o agente não enxerga", () => {
  const expected = cardNotVisibleMessage("55");

  it("texto: sem travessão, com o pedido de acesso certo, sem dizer se existe", () => {
    expect(expected).toBe(
      "O agente não enxerga o cartão 55: ele não existe ou o agente não tem acesso ao fluxo dele. " +
        'Se você sabe o fluxo, peça acesso com `cange access request --flow <id> --reason "<para que precisa>"`.'
    );
    expect(expected).not.toContain("—");
  });

  it.each([404, 403])("locate %i no card read: a mensagem nova, exit 2", async (status) => {
    routes["GET /card/locate"] = { status, body: { message: "não encontrado ou sem acesso" } };
    await cli(["card", "read", "--card-id", "55"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toBe(expected);
  });

  it("vale para card relationship e comment create", async () => {
    routes["GET /card/locate"] = { status: 404, body: { message: "não encontrado" } };
    await cli(["card", "relationship", "--card-id", "55"]);
    expect(errorMessage()).toBe(expected);

    stderr.length = 0;
    await cli(["comment", "create", "--card-id", "55", "--text", "x"]);
    expect(errorMessage()).toBe(expected);
    expect(calls("POST", "/card-comment")).toEqual([]);
  });

  it("comando sem número de cartão: a dica de sempre (o 429 do locate também, em card-locate.test.ts)", async () => {
    await cli(["card", "read"]);
    expect(errorMessage()).toBe(FLOW_FROM_CARD_HINT);
  });
});

describe("5. flow-build flow create: estado e onde aparece", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onda4-b-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("privado (padrão): publicado, privado, link e o aviso para quem pediu", async () => {
    routes["POST /flow/v2/build/flows"] = {
      status: 201,
      body: { id_flow: 77, hash: "abc123", name: "Compras", isPrivate: "1", rascunho: "S", form_init_id: 900 }
    };
    const payload = join(dir, "fluxo.json");
    await writeFile(payload, JSON.stringify({ name: "Compras" }));
    const out = await cli(["flow-build", "flow", "create", "--payload", payload]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.raw?.id_flow).toBe(77);
    expect(out?.flow).toEqual({
      id_flow: 77,
      name: "Compras",
      link: "https://app.cange.me/flow/abc123",
      state: "publicado",
      visibility: "privado"
    });
    expect(out?.notice).toContain("só os membros veem, e hoje o único membro é quem criou");
    expect(out?.notice).toContain("Painel do Administrador > Controle de Acesso");
    expect(out?.notice).toContain('flow update --id-flow 77 --payload <arquivo com {"isPrivate": "0"}>');
    expect(out?.notice).not.toContain("—");
  });

  it("sem nome é rascunho; público aparece para todos do ambiente", () => {
    const draft = flowPlacement({ id_flow: 78, hash: "h", name: null, isPrivate: "1" }, {}, "https://app.cange.me");
    expect(draft.flow.state).toBe("rascunho");
    expect(draft.notice).toContain("não tem nome");
    expect(draft.notice).toContain('flow update --id-flow 78 --payload <arquivo com {"name": "<nome>"}>');

    const open = flowPlacement({ id_flow: 79, hash: "h2", name: "RH", isPrivate: "0" }, {}, "https://app.cange.me");
    expect(open.flow.visibility).toBe("ambiente");
    expect(open.notice).toContain("aparece em Meus fluxos para todos do ambiente");
  });

  it("flow update devolve o mesmo estado (confirma depois de abrir o fluxo)", async () => {
    routes["PATCH /flow/v2/build/flows/77"] = { body: { id_flow: 77, hash: "abc123", name: "Compras", isPrivate: "0" } };
    const payload = join(dir, "abrir.json");
    await writeFile(payload, JSON.stringify({ isPrivate: "0" }));
    const out = await cli(["flow-build", "flow", "update", "--id-flow", "77", "--payload", payload]);

    expect(out?.flow).toMatchObject({ state: "publicado", visibility: "ambiente" });
  });
});
