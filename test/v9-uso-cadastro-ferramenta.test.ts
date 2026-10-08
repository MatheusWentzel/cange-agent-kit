import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeApiError, CangeToolCallError } from "../src/client/errors.js";
import { buildManifest } from "../src/cli/command-metadata.js";
import { explainUnknownOption } from "../src/cli/command-suggest.js";
import { toolCallErrorFrom } from "../src/cli/commands/tool-call.js";
import { EXIT_CODES, exitCodeForError } from "../src/cli/exit-codes.js";
import { createProgram, runCli } from "../src/cli/index.js";
import { guidePayload } from "../src/guide.js";

/**
 * v9 (decisões j e k, 08/10), bloco 2 do kit.
 * - Run 1131: `register entries 183` (valor solto), `register entry` (comando que não
 *   existia) e `map --register-id` (opção que o comando não tem) custaram 6 passos de
 *   manifest e jq; a entrada da Zagonel veio sem o "CNPJ/CPF" e o agente não sabia se
 *   o campo estava vazio ou se não tinha sido lido.
 * - Conversa 859 (runs 1128, 1129, 1133): `tool call` com `success:false` saiu com exit 0
 *   e o agente buscou o CNPJ em sites que ninguém cadastrou.
 * Fetch mockado, nada real.
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
let routes: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of [
    "CANGE_OUTPUT_PROFILE",
    "CANGE_OUTPUT_FORMAT",
    "CANGE_FORCE_DRY_RUN",
    "RUNNER_FLOW_ID",
    "RUNNER_CARD_ID",
    "CANGE_CARD_FLOW_ID",
    "RUNNER_SPEAKER_USER_ID"
  ]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  routes = {};
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
    const key = `${method} ${path}`;
    if (!(key in routes)) return json({ message: `rota não mockada: ${key}` }, 404);
    const route = routes[key];
    const payload = typeof route === "function" ? (route as (q: URLSearchParams, b?: unknown) => unknown)(url.searchParams, body) : route;
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
    if (record && typeof record.__status === "number") {
      const { __status, ...rest } = record;
      return json(rest, __status as number);
    }
    return json(payload);
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

async function runJson(args: string[]): Promise<Record<string, any>> {
  stdout.length = 0;
  await run(args);
  return JSON.parse(stdout.join("")) as Record<string, any>;
}

function errorJson(): Record<string, any> {
  return JSON.parse(stderr.join("")) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Cadastro 183 ([CNG] - Clientes), na ordem do formulário, com divisor e título.
// ---------------------------------------------------------------------------

const FIELDS_183 = [
  { id_field: 36776, name: "h-status", title: "Status", type: "COMBO_BOX_FIELD", form_id: 500 },
  { id_field: 9803, name: "h-razao", title: "Razão social", type: "TEXT_SHORT_FIELD", form_id: 500 },
  { id_field: 7771, name: "h-fantasia", title: "Nome fantasia", type: "TEXT_SHORT_FIELD", form_id: 500 },
  { id_field: 9802, name: "h-doc", title: "CNPJ/CPF", type: "DOC_FIELD", form_id: 500 },
  { id_field: 99122, name: "h-div", title: "Divisor", type: "DIVIDER_FIELD", form_id: 500 },
  { id_field: 99123, name: "h-tit", title: "Dados do contato técnico", type: "TITLE_FIELD", form_id: 500 },
  { id_field: 105412, name: "h-coment", title: "Comentários", type: "INPUT_RICH_TEXT_FIELD", form_id: 500 }
];
const TITLES_183 = ["Status", "Razão social", "Nome fantasia", "CNPJ/CPF", "Comentários"];

/** A linha da Zagonel no V2: sem CNPJ/CPF e sem comentários (o caso do run 1131). */
const ZAGONEL_ROW = {
  "form_answer.id_form_answer": 6507,
  "form_answer.register_id": 183,
  "field:36776": { display_value: "Inativo", value: "2" },
  "field:9803": { display_value: "CONSTRUTORA ZAGONEL LTDA" },
  "field:7771": { display_value: "CONSTRUTORA ZAGONEL" }
};

function registerV2Routes(): void {
  routes["GET /register/v2/query-engine-status"] = { use_query_v2: "S", isLargeData: "S" };
  routes["GET /field/by-register"] = FIELDS_183;
  routes["POST /register/v2/query"] = {
    items: [ZAGONEL_ROW],
    page_info: { has_more: false },
    execution_stats: { total_count: 1 }
  };
}

describe("register entries: fieldTitles e --fields (run 1131)", () => {
  it("fieldTitles lista os campos que guardam valor, na ordem do formulário; a v2 reaproveita a lista (1 GET)", async () => {
    registerV2Routes();
    const out = await runJson(["register", "entries", "--register-id", "183", "--search", "zagonel"]);
    expect(out).toEqual({
      registerId: 183,
      engine: "v2",
      total: 1,
      count: 1,
      fieldTitles: TITLES_183,
      entries: [
        {
          id: 6507,
          fields: { Status: "Inativo", "Razão social": "CONSTRUTORA ZAGONEL LTDA", "Nome fantasia": "CONSTRUTORA ZAGONEL" }
        }
      ]
    });
    expect(requests.filter((r) => r.path === "/field/by-register")).toHaveLength(1);
    const query = requests.find((r) => r.path === "/register/v2/query");
    const filter = JSON.parse(String(query?.body?.filterSchema)) as { fieldView: unknown[]; searchText: string };
    expect(filter.fieldView.length).toBeGreaterThan(0);
    expect(filter.searchText).toBe("zagonel");
  });

  it("sem a lista de campos (falhou), a leitura segue sem fieldTitles", async () => {
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "N" };
    routes["GET /register"] = {
      id_register: 183,
      form_answers: [
        { id_form_answer: 6507, form_answer_fields: [{ field_id: 9803, field: { title: "Razão social" }, valueString: "ZAGONEL" }] }
      ]
    };
    const out = await runJson(["register", "entries", "--register-id", "183"]);
    expect(out).not.toHaveProperty("fieldTitles");
    expect(out.entries).toEqual([{ id: 6507, fields: { "Razão social": "ZAGONEL" } }]);
    expect(process.exitCode).toBeUndefined();
  });

  it("--fields traz exatamente os campos pedidos, na ordem pedida, com null quando vazio (título sem acento e caixa)", async () => {
    registerV2Routes();
    routes["POST /register/v2/query"] = {
      items: [ZAGONEL_ROW],
      page_info: { has_more: true, next_cursor: "c2" },
      execution_stats: { total_count: 2 }
    };
    const out = await runJson(["register", "entries", "--register-id", "183", "--fields", "cnpj/cpf, razao social"]);
    expect(out.entries).toEqual([{ id: 6507, fields: { "CNPJ/CPF": null, "Razão social": "CONSTRUTORA ZAGONEL LTDA" } }]);
    expect(Object.keys(out.entries[0].fields)).toEqual(["CNPJ/CPF", "Razão social"]);
    expect(out.next).toBe('cange register entries --register-id 183 --fields "cnpj/cpf, razao social" --cursor c2');
    expect(out.fieldTitles).toEqual(TITLES_183);
  });

  it("--fields com a lista de campos que falhou 1 vez: lê de novo e usa a 2a leitura", async () => {
    registerV2Routes();
    let calls = 0;
    routes["GET /field/by-register"] = () => {
      calls += 1;
      return calls === 1 ? { __status: 404, message: "instável" } : FIELDS_183;
    };
    const out = await runJson(["register", "entries", "--register-id", "183", "--fields", "Status"]);
    expect(out.entries[0].fields).toEqual({ Status: "Inativo" });
    expect(out.fieldTitles).toEqual(TITLES_183);
  });

  it("--fields por id e por hash também valem", async () => {
    registerV2Routes();
    const out = await runJson(["register", "entries", "--register-id", "183", "--fields", "9802,h-status"]);
    expect(out.entries[0].fields).toEqual({ "CNPJ/CPF": null, Status: "Inativo" });
  });

  it("--fields com campo que não existe: exit 2 com os títulos do cadastro, sem ler as entradas", async () => {
    registerV2Routes();
    await run(["register", "entries", "--register-id", "183", "--fields", "CNPJ"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorJson().message).toBe(
      'Campo "CNPJ" não existe no cadastro 183 (campos: Status, Razão social, Nome fantasia, CNPJ/CPF, Comentários).'
    );
    expect(requests.some((r) => r.path === "/register/v2/query")).toBe(false);
  });

  it("valor cortado aponta para --entry-id <id> --fields \"<campo>\" (o caminho do valor inteiro)", async () => {
    registerV2Routes();
    routes["POST /register/v2/query"] = {
      items: [{ ...ZAGONEL_ROW, "field:105412": { display_value: "y".repeat(700) } }],
      page_info: { has_more: false }
    };
    const out = await runJson(["register", "entries", "--register-id", "183"]);
    const value = out.entries[0].fields["Comentários"] as string;
    expect(value.startsWith("y".repeat(600))).toBe(true);
    expect(value).toContain('…(cortado: o valor inteiro em cange register entries --entry-id 6507 --fields "Comentários")');
  });

  it("`register entry` é apelido de `register entries`", async () => {
    registerV2Routes();
    const out = await runJson(["register", "entry", "--register-id", "183"]);
    expect(out.entries).toHaveLength(1);
    const register = createProgram().commands.find((c) => c.name() === "register")!;
    expect(register.commands.find((c) => c.name() === "entries")?.aliases()).toEqual(["entry"]);
  });
});

describe("register entries --entry-id (run 1131)", () => {
  function entryRoutes(): void {
    routes["GET /form/answer"] = [{ id_form_answer: 6507, register_id: 183, card_id: null, form_id: 500 }];
    routes["GET /field/by-register"] = FIELDS_183;
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "S" };
    routes["GET /register/v2/query-single"] = {
      item: { ...ZAGONEL_ROW, "field:-3": { display_value: "6507" }, "field:105412": { display_value: "<p>" + "z".repeat(700) + "</p>" } }
    };
  }

  it("uma entrada com TODOS os campos (vazio = null), na ordem do formulário; o cadastro sai da entrada", async () => {
    entryRoutes();
    const out = await runJson(["register", "entries", "--entry-id", "6507"]);
    expect(out.registerId).toBe(183);
    expect(out.entry.id).toBe(6507);
    expect(Object.keys(out.entry.fields)).toEqual(TITLES_183);
    expect(out.entry.fields).toMatchObject({
      Status: "Inativo",
      "Razão social": "CONSTRUTORA ZAGONEL LTDA",
      "Nome fantasia": "CONSTRUTORA ZAGONEL",
      "CNPJ/CPF": null
    });
    expect(out.entry.fields["Comentários"]).toContain(
      '…(cortado: o valor inteiro em cange register entries --entry-id 6507 --fields "Comentários")'
    );
    const locate = requests.find((r) => r.path === "/form/answer");
    expect(locate?.query.get("id_form_answer")).toBe("6507");
    const single = requests.find((r) => r.path === "/register/v2/query-single");
    expect(single?.query.get("id_register")).toBe("183");
    expect(single?.query.get("id_form_answer")).toBe("6507");
    expect(requests.filter((r) => r.path === "/field/by-register")).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("--entry-id com --fields: só esses, inteiros, null quando vazio; com --register-id certo não localiza", async () => {
    entryRoutes();
    const out = await runJson([
      "register",
      "entry",
      "--entry-id",
      "#6507",
      "--register-id",
      "183",
      "--fields",
      "Comentários,CNPJ/CPF"
    ]);
    expect(out).toEqual({
      registerId: 183,
      entry: { id: 6507, fields: { "Comentários": "z".repeat(700), "CNPJ/CPF": null } }
    });
    expect(requests.some((r) => r.path === "/form/answer")).toBe(false);
  });

  it("cadastro divergente: exit 2 dizendo de qual cadastro é a entrada", async () => {
    entryRoutes();
    routes["GET /register/v2/query-single"] = { __status: 404, message: "[V2 Query-Single] Registro não encontrado" };
    await run(["register", "entries", "--entry-id", "6507", "--register-id", "203"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorJson().message).toBe("A entrada 6507 é do cadastro 183, não do 203.");
  });

  it("sem acesso ao cadastro da entrada: o 404 de sempre com o pedido de acesso do cadastro descoberto", async () => {
    entryRoutes();
    routes["GET /field/by-register"] = {
      __status: 404,
      message: "Parâmetro inválido! Não foi possivel encontrar o registro ou você não possuí acesso para realizar esta ação!"
    };
    routes["GET /register/v2/query-single"] = {
      __status: 404,
      message: "[V2 Query-Single] Register não encontrado ou sem acesso direto (sem parent)"
    };
    await run(["register", "entries", "--entry-id", "6507"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const error = errorJson();
    expect(error.status).toBe(404);
    expect(error.hint).toContain("cange access request --register 183");
    expect(stdout.join("")).toBe("");
  });

  it("entrada que não existe: exit 4 sem pedir acesso", async () => {
    routes["GET /form/answer"] = [];
    await run(["register", "entries", "--entry-id", "6507"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const error = errorJson();
    expect(error.message).toBe("A entrada 6507 não existe ou foi apagada.");
    expect(error.hint).not.toContain("access request");
  });

  it("resposta de cartão (não de cadastro): exit 2 com o card read pronto", async () => {
    routes["GET /form/answer"] = [{ id_form_answer: 6507, register_id: null, card_id: 991 }];
    await run(["register", "entries", "--entry-id", "6507"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorJson().message).toBe(
      "A resposta 6507 não é entrada de cadastro (é do cartão 991: cange card read --card-id 991)."
    );
  });

  it("engine v1: a entrada sai da lista do cadastro, pelo id", async () => {
    routes["GET /form/answer"] = [{ id_form_answer: 6508, register_id: 183 }];
    routes["GET /field/by-register"] = FIELDS_183;
    routes["GET /register/v2/query-engine-status"] = { use_query_v2: "N" };
    routes["GET /register"] = {
      id_register: 183,
      form_answers: [
        { id_form_answer: 6507, form_answer_fields: [{ field_id: 9803, field: { title: "Razão social" }, valueString: "OUTRA" }] },
        { id_form_answer: 6508, form_answer_fields: [{ field_id: 9803, field: { title: "Razão social" }, valueString: "ACME" }] }
      ]
    };
    const out = await runJson(["register", "entries", "--entry-id", "6508"]);
    expect(out.entry).toEqual({
      id: 6508,
      fields: { Status: null, "Razão social": "ACME", "Nome fantasia": null, "CNPJ/CPF": null, "Comentários": null }
    });
  });

  it("--entry-id com --search, --q ou --cursor, ou sem número: exit 2 sem chamar o Cange", async () => {
    const cases: Array<[string[], string]> = [
      [["--entry-id", "6507", "--search", "acme"], "Use --entry-id sozinho ou --search, não os dois."],
      [["--entry-id", "6507", "--q", "acme"], "Use --entry-id sozinho ou --search, não os dois."],
      [["--entry-id", "6507", "--cursor", "20"], "Use --entry-id sozinho ou --cursor, não os dois."],
      [["--entry-id", "abc"], "--entry-id precisa do número da entrada (recebido: abc). O número é o id de cada item em cange register entries."]
    ];
    for (const [args, message] of cases) {
      stderr.length = 0;
      process.exitCode = undefined;
      await run(["register", "entries", ...args]);
      expect(process.exitCode, args.join(" ")).toBe(EXIT_CODES.USAGE);
      expect(errorJson().message).toBe(message);
    }
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Erros de uso que ensinam (os 3 casos do run 1131 e os vizinhos).
// ---------------------------------------------------------------------------

describe("erros de uso que devolvem o comando certo", () => {
  async function usage(args: string[]): Promise<Record<string, any>> {
    stderr.length = 0;
    process.exitCode = undefined;
    await runCli(["node", "cange", ...args]);
    expect(process.exitCode, args.join(" ")).toBe(EXIT_CODES.USAGE);
    return errorJson();
  }

  it("run 1131, valor solto: `register entries 183` vira --register-id 183", async () => {
    expect(await usage(["register", "entries", "183"])).toEqual({
      name: "CangeCliUsageError",
      message:
        'Valor solto "183" em cange register entries: este comando não recebe valor sem opção.\n' +
        "Você quis dizer: cange register entries --register-id 183",
      code: "commander.excessArguments",
      suggestion: "cange register entries --register-id 183"
    });
    expect(requests).toHaveLength(0);
  });

  it("valor solto com #, com outras opções e pelo apelido (`register entry 6507` vira --entry-id)", async () => {
    expect((await usage(["register", "entries", "#183", "--search", "acme"])).suggestion).toBe(
      "cange register entries --register-id 183 --search acme"
    );
    expect((await usage(["register", "entry", "6507"])).suggestion).toBe("cange register entry --entry-id 6507");
    expect((await usage(["card", "read", "1223901"])).suggestion).toBe("cange card read --card-id 1223901");
    const link = "https://app.cange.me/register/3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901";
    expect((await usage(["register", "get", link])).suggestion).toBe(`cange register get --register-id ${link}`);
  });

  it("valor solto que não é id, ou com a opção já dada: lista as opções, sem comando pronto", async () => {
    const list = await usage(["register", "entries", "list", "--register-id", "183"]);
    expect(list.message).toBe(
      'Valor solto "list" em cange register entries: este comando não recebe valor sem opção.\n' +
        "Opções: --register-id, --register, --id-register, --search, --fields, --entry-id, --page-size, --cursor, --q"
    );
    expect(list).not.toHaveProperty("suggestion");
    const twice = await usage(["register", "entries", "--register-id", "183", "184"]);
    expect(twice).not.toHaveProperty("suggestion");
    const tool = await usage(["tool", "call", "12", "13"]);
    expect(tool.message).toBe(
      'Valor solto "13" em cange tool call: este comando recebe só 1 valor sem opção (<toolId>).\nOpções: --params, --params-json'
    );
  });

  it("run 1131, opção que o comando não tem: `map --register-id` lista as opções e quem aceita", async () => {
    const error = await usage(["map", "--register-id", "183"]);
    const lines = (error.message as string).split("\n");
    expect(lines[0]).toBe("cange map não tem a opção --register-id.");
    expect(lines[1]).toBe("Opções: --flow-id, --max-flows");
    expect(lines[2]).toMatch(/^Quem aceita --register-id: cange register get, cange register entries/);
    expect(lines[2]!.split(", ")).toHaveLength(4);
    expect(error.code).toBe("commander.unknownOption");
    expect(error).not.toHaveProperty("suggestion");
  });

  it("opção parecida (sinônimo ou edição) do mesmo comando vira o comando pronto", async () => {
    expect((await usage(["register", "create", "--register", "183", "--set", "Nome=ACME"])).suggestion).toBe(
      "cange register create --register-id 183 --set Nome=ACME"
    );
    expect((await usage(["register", "entries", "--register-id", "183", "--serch", "acme"])).suggestion).toBe(
      "cange register entries --register-id 183 --search acme"
    );
    expect((await usage(["register", "entries", "--entry=6507"])).suggestion).toBe("cange register entries --entry-id=6507");
    const message = (await usage(["catalog", "--query", "clientes"])).message as string;
    expect(message).toBe("cange catalog não tem a opção --query.\nVocê quis dizer: cange catalog --search clientes");
  });

  it("opção obrigatória que faltou porque veio com o nome parecido: explica a opção, não só a obrigatória", async () => {
    const error = await usage(["fields", "by-register", "--register", "183"]);
    expect(error.message).toBe(
      "cange fields by-register não tem a opção --register.\nVocê quis dizer: cange fields by-register --register-id 183"
    );
    expect(error.code).toBe("commander.missingMandatoryOptionValue");
    expect(error.suggestion).toBe("cange fields by-register --register-id 183");
    // Sem opção parecida: a mensagem do commander com a rota de discovery, como antes.
    const plain = await usage(["fields", "by-register"]);
    expect(plain.message).toContain("cange manifest --output json");
    expect(plain).not.toHaveProperty("suggestion");
  });

  it("comando desconhecido: irmão único com 4 letras em comum no começo; com suggestion", async () => {
    expect(await usage(["register", "entradas", "--register-id", "183"])).toEqual({
      name: "CangeCliUsageError",
      message: 'Comando "entradas" não existe em cange register.\nVocê quis dizer: cange register entries --register-id 183',
      code: "commander.unknownCommand",
      suggestion: "cange register entries --register-id 183"
    });
    const ambiguous = await usage(["notif"]);
    expect(ambiguous.message).toContain("cange manifest --output json");
    expect(ambiguous).not.toHaveProperty("suggestion");
    expect(await usage(["search", "acme"])).not.toHaveProperty("suggestion");
  });

  it("argv longo demais: diz a troca em vez de ecoar o comando inteiro", () => {
    const text = "x".repeat(500);
    const explained = explainUnknownOption(
      createProgram(),
      ["node", "cange", "comment", "create", "--card", "55", "--text", text],
      "--card"
    );
    expect(explained.suggestion).toBeUndefined();
    expect(explained.message).toBe("cange comment create não tem a opção --card.\nUse --card-id no lugar de --card.");
  });
});

// ---------------------------------------------------------------------------
// tool call com success:false (conversa 859).
// ---------------------------------------------------------------------------

/** A resposta real do run 1128 (back sem os campos novos do C5). */
const RUN_1128_RESPONSE = {
  success: false,
  statusCode: 500,
  error: {
    message: "Request failed with status code 500",
    code: "ERR_BAD_RESPONSE",
    details: { message: "Request failed with status code 503", type: "internal_error", name: "AxiosError" }
  },
  executionTime: 5904,
  resolvedUrl: "https://brasilapi.com.br/api/cnpj/v1/91292987000110"
};

describe("tool call: success:false é falha com exit 6 (conversa 859)", () => {
  it("resposta real do run 1128: exit 6, nada em stdout, nome do erro, status e host", async () => {
    routes["POST /agent-tool/api/12/invoke"] = RUN_1128_RESPONSE;
    await run(["tool", "call", "12", "--params-json", '{"cnpj":"91292987000110"}']);
    expect(process.exitCode).toBe(EXIT_CODES.TOOL_FAILED);
    expect(stdout.join("")).toBe("");
    const error = errorJson();
    expect(Object.keys(error)).toEqual(["name", "code", "message", "tool", "status", "host", "durationMs", "details", "hint"]);
    expect(error).toMatchObject({
      name: "CangeToolCallError",
      code: "TOOL_CALL_FAILED",
      message: "A ferramenta de API #12 falhou: o serviço respondeu 503 em brasilapi.com.br.",
      tool: { id: 12, name: null },
      status: 503,
      host: "brasilapi.com.br",
      durationMs: 5904,
      details: RUN_1128_RESPONSE.error
    });
    expect(error.hint).toContain("Não busque o dado em outra fonte");
    expect(requests[0]?.body).toEqual({ params: { cnpj: "91292987000110" } });
  });

  it("com os campos do back novo (C5): nome da ferramenta, upstream_status e host do back", () => {
    const error = toolCallErrorFrom(12, {
      ...RUN_1128_RESPONSE,
      tool: { id: 12, name: "Consulta CNPJ" },
      upstream_status: 502,
      host: "api.exemplo.com"
    });
    expect(error.message).toBe('A ferramenta de API "Consulta CNPJ" (#12) falhou: o serviço respondeu 502 em api.exemplo.com.');
    expect(error.toJSON()).toMatchObject({ tool: { id: 12, name: "Consulta CNPJ" }, status: 502, host: "api.exemplo.com" });
  });

  it("sem status: prazo (ECONNABORTED/ETIMEDOUT) ou conexão; upstream_status null do back vale", () => {
    const timeout = toolCallErrorFrom(12, {
      success: false,
      error: { message: "timeout of 30000ms exceeded", code: "ECONNABORTED" },
      executionTime: 30001,
      resolvedUrl: "https://brasilapi.com.br/api/cnpj/v1/1"
    });
    expect(timeout.message).toBe("A ferramenta de API #12 falhou: o serviço não respondeu a tempo (brasilapi.com.br).");
    expect(timeout.upstreamStatus).toBeNull();

    const refused = toolCallErrorFrom(12, {
      success: false,
      tool: { id: 12, name: "Consulta CNPJ" },
      upstream_status: null,
      host: "brasilapi.com.br",
      statusCode: 500,
      error: { message: "getaddrinfo ENOTFOUND brasilapi.com.br", code: "ENOTFOUND" }
    });
    expect(refused.message).toBe(
      'A ferramenta de API "Consulta CNPJ" (#12) falhou: não foi possível conectar em brasilapi.com.br.'
    );

    const bare = toolCallErrorFrom(7, { success: false, error: { message: "Erro desconhecido", code: "UNKNOWN_ERROR" } });
    expect(bare.message).toBe("A ferramenta de API #7 falhou: não foi possível conectar ao serviço.");
    expect(bare.toJSON()).toMatchObject({ status: null, host: null });
  });

  it("back antigo: status por error.message e depois por statusCode", () => {
    expect(
      toolCallErrorFrom(12, { success: false, statusCode: 404, error: { message: "Request failed with status code 404" } }).upstreamStatus
    ).toBe(404);
    expect(toolCallErrorFrom(12, { success: false, statusCode: 429, error: { message: "falhou" } }).upstreamStatus).toBe(429);
  });

  it("success:true segue igual (stdout, exit 0); erro do próprio Cange continua exit 4", async () => {
    routes["POST /agent-tool/api/12/invoke"] = { success: true, statusCode: 200, data: { razao_social: "ACME" }, executionTime: 80 };
    await run(["tool", "call", "12", "--params-json", "{}"]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(stdout.join(""))).toMatchObject({ success: true, data: { razao_social: "ACME" } });

    stdout.length = 0;
    routes["POST /agent-tool/api/12/invoke"] = { __status: 403, message: "Esta tool não pertence a este agente." };
    await run(["tool", "call", "12", "--params-json", "{}"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
  });

  it("exit codes: TOOL_FAILED = 6 só para CangeToolCallError", () => {
    expect(EXIT_CODES.TOOL_FAILED).toBe(6);
    const error = new CangeToolCallError("x", { tool: { id: 1, name: null }, status: null, host: null });
    expect(exitCodeForError(error)).toBe(6);
    expect(exitCodeForError(new CangeApiError("x", { status: 503 }))).toBe(EXIT_CODES.API);
  });
});

// ---------------------------------------------------------------------------
// Manifest, ajuda e guia com os comandos dos dois blocos.
// ---------------------------------------------------------------------------

describe("manifest e guia refletem os comandos novos", () => {
  it("register entries (apelido, --fields, --entry-id, fieldTitles), card update e tool call no manifest", () => {
    const manifest = buildManifest(createProgram());
    const register = manifest.commands.find((c) => c.name === "register")!;
    const entries = register.subcommands.find((c) => c.name === "entries")!;
    expect(entries.aliases).toEqual(["entry"]);
    const flags = entries.options.map((o) => o.flags);
    expect(flags).toContain("--fields <campos>");
    expect(flags).toContain("--entry-id <id>");
    expect(entries.envelope).toContain("fieldTitles");
    expect(entries.envelope).toContain("não aparece na entrada está VAZIO");

    const card = manifest.commands.find((c) => c.name === "card")!;
    const update = card.subcommands.find((c) => c.name === "update")!;
    expect(update.options.map((o) => o.flags.split(" ")[0])).toEqual(
      expect.arrayContaining(["--due", "--responsible", "--add-tag", "--remove-tag"])
    );

    const tool = manifest.commands.find((c) => c.name === "tool")!;
    const call = tool.subcommands.find((c) => c.name === "call")!;
    expect(call.envelope).toContain("exit 6");
  });

  it("guia: jornada de vencimento/responsável/etiqueta, cadastro com --entry-id e as armadilhas novas", () => {
    const guide = guidePayload();
    const due = guide.jornadas.find((j) => j.id === "vencimento_responsavel_etiqueta");
    expect(due?.passos.join(" ")).toContain("cange card update --card-id <c> --due 27/10/2026");
    const register = guide.jornadas.find((j) => j.id === "ler_cadastro");
    expect(register?.passos.join(" ")).toContain("--entry-id");
    expect(guide.armadilhas.join(" ")).toContain("Exit 6");
    expect(guide.armadilhas.join(" ")).toContain("suggestion");
    // Texto novo sem jargão ("run", "runner", "step_ref") e sem travessão.
    const fresh = [...(due?.passos ?? []), due?.armadilha ?? "", ...guide.armadilhas.filter((g) => /Exit 6|suggestion/.test(g))].join(" ");
    expect(fresh).not.toMatch(/\brun\b|runner|step_ref|—/i);
  });
});
