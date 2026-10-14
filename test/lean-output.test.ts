import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderRecipe, recipeNames } from "../src/cli/commands/recipe.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { dropEmpty, htmlToMarkdown, looksLikeHtml, resolveOutputProfile } from "../src/utils/lean.js";

/**
 * Rodada 5 (custo, decisão 3 do Matheus): saída ENXUTA é o padrão para todos;
 * `--full` (ou CANGE_OUTPUT_PROFILE=full) devolve o formato anterior; `--raw`
 * continua cru. Estes testes fixam os dois formatos de cada comando que mudou.
 */

const envBackup = { ...process.env };

describe("lean utils", () => {
  it("resolveOutputProfile: padrão lean; --full ou CANGE_OUTPUT_PROFILE=full = full", () => {
    expect(resolveOutputProfile(undefined, {})).toBe("lean");
    expect(resolveOutputProfile(false, { CANGE_OUTPUT_PROFILE: "lean" })).toBe("lean");
    expect(resolveOutputProfile(true, {})).toBe("full");
    expect(resolveOutputProfile(undefined, { CANGE_OUTPUT_PROFILE: " FULL " })).toBe("full");
  });

  it("dropEmpty tira nulo/vazio por dentro, mantém 0/false e as chaves do envelope", () => {
    const out = dropEmpty({
      summaries: [],
      total: 0,
      items: [{ a: null, b: "", c: [], d: {}, e: 0, f: false, g: "x", h: { i: null } }]
    });
    expect(out).toEqual({ summaries: [], total: 0, items: [{ e: 0, f: false, g: "x" }] });
  });

  it("htmlToMarkdown preserva links, listas e quebras; texto sem HTML volta igual", () => {
    const html =
      '<p>Reunião <strong>ok</strong>: <a target="_blank" rel="noopener noreferrer nofollow" href="https://app.tactiq.io/t/1">transcrição</a></p>' +
      "<ul><li>item 1</li><li>item &amp; 2</li></ul><p>linha<br/>quebrada</p>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("[transcrição](https://app.tactiq.io/t/1)");
    expect(md).toContain("**ok**");
    expect(md).toContain("- item 1");
    expect(md).toContain("- item & 2");
    expect(md).toContain("linha\nquebrada");
    expect(md).not.toMatch(/<\/?(p|a|li|ul|br)\b/);
    expect(htmlToMarkdown("texto puro com < e >")).toBe("texto puro com < e >");
    expect(looksLikeHtml("a < b")).toBe(false);
  });
});

describe("recipe (receitas sob demanda)", () => {
  it("renderiza a receita com a pasta do run quando há TMPDIR", () => {
    const text = renderRecipe("anexo", { TMPDIR: "/runs/run-9/tmp/" });
    expect(text.split("\n")[1]).toBe(
      "PASTA_DO_RUN = /runs/run-9/tmp (troque <PASTA_DO_RUN> por este caminho, escrito por extenso)"
    );
    expect(text).toContain("cange attachment download");
    expect(text).toContain("<PASTA_DO_RUN>/anexos");
  });

  it("sem TMPDIR não inventa pasta", () => {
    expect(renderRecipe("comentar", {})).not.toContain("PASTA_DO_RUN =");
  });

  it("lista as receitas de escrita e a do anexo", () => {
    expect(recipeNames()).toEqual([
      "anexo",
      "comentar",
      "mencionar",
      "criar-card",
      "mover-card",
      "gravar-campos",
      "publicar-artefato",
      "cadastro-por-nome",
      "contar-somar",
      "ler-campos"
    ]);
  });

  it("receita desconhecida falha com erro de uso", () => {
    expect(() => renderRecipe("deletar", {})).toThrow(/não existe/);
  });

  it("sem travessão no texto das receitas", () => {
    for (const name of recipeNames()) {
      expect(renderRecipe(name, {})).not.toContain("—");
    }
  });
});

describe("saída enxuta x --full (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown }> = [];
  let routes: Record<string, unknown> = {};

  beforeEach(() => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    delete process.env.CANGE_OUTPUT_PROFILE;
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
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, query: url.searchParams, body });
      const key = `${method} ${url.pathname}`;
      if (!(key in routes)) {
        return new Response(JSON.stringify({ message: `rota não mockada: ${key}` }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
    });
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<string> {
    const program = createProgram();
    await program.parseAsync(["node", "cange", "--output", "json", ...args]);
    return stdout.join("");
  }

  const MY_FLOWS = [
    {
      id_flow: 316,
      hash: "a".repeat(40),
      name: "CNG CRM",
      form_init_id: 900,
      company_id: 1,
      color: "#fff",
      icon: "FaFire",
      schema_view: JSON.stringify({ fieldView: [{ id: 1 }] }),
      dt_created: "2026-01-01",
      company_email_config_id: null,
      total_cards: 42,
      typeUserAccess: "A"
    },
    { id_flow: 317, name: "Compras", form_init_id: 901, total_cards: 0, typeUserAccess: "" }
  ];

  it("my-flows: enxuto = [{id, title, formInitId, totalCards, access}] em JSON compacto, sem raw", async () => {
    routes["GET /flow/my-flows"] = MY_FLOWS;
    const out = await run(["my-flows"]);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({
      summaries: [
        { id: 316, title: "CNG CRM", formInitId: 900, totalCards: 42, access: "A" },
        { id: 317, title: "Compras", formInitId: 901, totalCards: 0 }
      ],
      total: 2
    });
    expect(out).not.toContain("schema_view");
    expect(out).not.toContain("a".repeat(40));
  });

  it("my-flows --full e CANGE_OUTPUT_PROFILE=full devolvem o formato anterior (raw + summaries, indentado)", async () => {
    routes["GET /flow/my-flows"] = MY_FLOWS;
    const full = await run(["--full", "my-flows"]);
    const parsed = JSON.parse(full);
    expect(parsed.raw).toEqual(MY_FLOWS);
    expect(parsed.summaries[0]).toMatchObject({ id: 316, hash: "a".repeat(40), title: "CNG CRM", formInitId: 900 });
    expect(full).toContain('\n  "raw": [');

    stdout.length = 0;
    process.env.CANGE_OUTPUT_PROFILE = "full";
    expect(await run(["my-flows"])).toBe(full);
  });

  function cardRaw(): Record<string, unknown> {
    return {
      id_card: 1001,
      flow_id: 316,
      flow_step_id: 485,
      title: "Pedido ACME",
      complete: "N",
      form_answers: [
        {
          id_form_answer: 1,
          deleted: "N",
          form_answer_fields: [
            {
              field_id: 10,
              field: { id_field: 10, name: "h10", title: "Resumo", type: "INPUT_RICH_TEXT_FIELD" },
              value: '<p>Ver <a href="https://tela.example/x">a tela</a></p>',
              valueString: '<p>Ver <a href="https://tela.example/x">a tela</a></p>',
              deleted: "N"
            },
            {
              field_id: 11,
              field: { id_field: 11, name: "h11", title: "Pedido pai", type: "COMBO_BOX_FLOW_FIELD" },
              value: "2002",
              valueString: "Pedido pai X",
              deleted: "N"
            },
            {
              field_id: 12,
              field: { id_field: 12, name: "h12", title: "Valor", type: "CURRENCY_FIELD" },
              value: "10,00",
              deleted: "N"
            }
          ]
        }
      ]
    };
  }

  it("card read: enxuto traz o título do campo, o vínculo uma vez e rich text em markdown", async () => {
    routes["GET /card/"] = cardRaw();
    const out = JSON.parse(await run(["card", "read", "--flow-id", "316", "--card-id", "1001"]));
    expect(out.fields).toEqual([
      // R5-KR-07: o valor convertido de HTML vem marcado (não reescrever sem buscar o original).
      { id: 10, title: "Resumo", value: "Ver [a tela](https://tela.example/x)", format: "markdown" },
      { id: 11, title: "Pedido pai", cards: [{ cardId: 2002, label: "Pedido pai X" }] },
      { id: 12, title: "Valor", value: "10,00" }
    ]);
    expect(out).not.toHaveProperty("fieldValues");
    expect(out).not.toHaveProperty("links");
    expect(out).toMatchObject({ cardId: 1001, title: "Pedido ACME", flowId: 316 });
  });

  it("card read --field-ids devolve o valor ORIGINAL (HTML), sem converter", async () => {
    routes["GET /card/"] = cardRaw();
    const out = JSON.parse(await run(["card", "read", "--flow-id", "316", "--card-id", "1001", "--field-ids", "10"]));
    expect(out.fields).toEqual([
      { id: 10, title: "Resumo", value: '<p>Ver <a href="https://tela.example/x">a tela</a></p>' }
    ]);
    // O original não leva o marcador de conversão.
    expect(out.fields[0]).not.toHaveProperty("format");
  });

  it("card read --full mantém fieldValues + links (formato anterior)", async () => {
    routes["GET /card/"] = cardRaw();
    const out = JSON.parse(await run(["card", "read", "--flow-id", "316", "--card-id", "1001", "--full"]));
    expect(out.fieldValues).toMatchObject({ "11": "Pedido pai X", "12": "10,00" });
    expect(out.links).toEqual({ "11": [{ cardId: 2002, label: "Pedido pai X" }] });
    expect(out).not.toHaveProperty("fields");
  });

  function comments(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      id_card_comment: i + 1,
      card_id: 1001,
      user_id: 76,
      user: { id_user: 76, name: "Lia" },
      description: `<p>comentário ${i + 1}<br/>linha 2</p>`,
      dt_created: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      dt_created_string: "01/09/2026 10:00",
      fixed: 0,
      attachments: []
    }));
  }

  it("comment list: enxuto = 15 mais recentes, markdown, sem campos repetidos, com marcador de corte", async () => {
    routes["GET /card-comment/by-card"] = comments(20);
    const out = JSON.parse(await run(["comment", "list", "--flow-id", "316", "--card-id", "1001"]));
    expect(out.total).toBe(20);
    expect(out.shown).toBe(15);
    expect(out.more).toContain("--limit 20");
    expect(out.summaries).toHaveLength(15);
    expect(out.summaries[0]).toEqual({
      id: 20,
      userName: "Lia",
      dtCreated: "2026-09-20T10:00:00.000Z",
      description: "comentário 20\nlinha 2"
    });
  });

  it("comment list --limit traz mais; --full (do subcomando) devolve raw + summaries completos", async () => {
    routes["GET /card-comment/by-card"] = comments(20);
    const limited = JSON.parse(await run(["comment", "list", "--flow-id", "316", "--card-id", "1001", "--limit", "20"]));
    expect(limited.shown).toBe(20);
    expect(limited).not.toHaveProperty("more");

    stdout.length = 0;
    const full = JSON.parse(await run(["comment", "list", "--flow-id", "316", "--card-id", "1001", "--full"]));
    expect(full.raw).toHaveLength(20);
    expect(full.summaries[0]).toMatchObject({ cardId: 1001, userId: 76, dtCreatedFormatted: "01/09/2026 10:00" });
  });

  function mapRoutes(): void {
    routes["GET /flow/my-flows"] = MY_FLOWS;
    routes["GET /flow"] = { id_flow: 316, flow_steps: [{ id_step: 485, name: "Priorizados", form_id: 658, index: 1 }] };
    routes["GET /field/by-flow"] = [
      { id_field: 10, name: "h".repeat(40), title: "Resumo", type: "TEXT_SHORT_FIELD", required: "S", form_id: 900 },
      { id_field: 11, name: "k".repeat(40), title: "Fornecedor", type: "COMBO_BOX_FLOW_FIELD", form_id: 900, flow_id: 317 }
    ];
  }

  it("map: enxuto sem o hash do campo e sem relationships/registersUsed repetidos", async () => {
    mapRoutes();
    const out = JSON.parse(await run(["map", "--flow-id", "316"]));
    // C4: resumido, com os campos agrupados no formulário de criação e em cada etapa.
    expect(out.flows[0].startFields).toEqual([
      { id: 10, title: "Resumo", type: "TEXT_SHORT_FIELD", required: true },
      { id: 11, title: "Fornecedor", type: "COMBO_BOX_FLOW_FIELD", linksToFlowId: 317 }
    ]);
    expect(out.flows[0].steps).toEqual([{ id: 485, name: "Priorizados" }]);
    expect(out.flows[0]).not.toHaveProperty("fields");
    expect(out).not.toHaveProperty("relationships");
    expect(out).not.toHaveProperty("dica");
  });

  it("map --full traz o hash `name` e os relationships", async () => {
    mapRoutes();
    const out = JSON.parse(await run(["--full", "map", "--flow-id", "316"]));
    expect(out.flows[0].fields[0].name).toBe("h".repeat(40));
    expect(out.relationships).toEqual([{ fromFlowId: 316, fieldId: 11, fieldTitle: "Fornecedor", toFlowId: 317 }]);
  });

  const V2_ITEM = (id: number) => ({
    card: { id_card: id, flow_id: 316, title: `Cartão ${id}`, flow_step_id: 485, user_id: 76 },
    fields: {}
  });

  it("card list (V2): enxuto pede o título real, traz o nome da etapa e tira os aliases", async () => {
    routes["POST /flow/v2/query"] = { items: [V2_ITEM(1), V2_ITEM(2)], page_info: { has_more: false } };
    routes["GET /flow"] = { id_flow: 316, flow_steps: [{ id_step: 485, name: "Priorizados", form_id: 658 }] };
    const out = JSON.parse(await run(["card", "list", "--flow-id", "316", "--engine", "v2"]));
    const query = requests.find((r) => r.path === "/flow/v2/query");
    expect(query?.body).toMatchObject({ flags: { ensure_card_title: true } });
    expect(out).toMatchObject({ engine: "v2", flowId: 316, total: 2 });
    expect(out.summaries[0]).toMatchObject({ cardId: 1, title: "Cartão 1", currentStepId: 485, stepName: "Priorizados" });
    for (const key of ["id_card", "flow_id", "step_id", "fields", "flowHash", "companyId", "flowId"]) {
      expect(out.summaries[0]).not.toHaveProperty(key);
    }
  });

  it("card list --full mantém o envelope anterior e não pede o título forçado", async () => {
    routes["POST /flow/v2/query"] = { items: [V2_ITEM(1)], page_info: { has_more: false } };
    const out = JSON.parse(await run(["--full", "card", "list", "--flow-id", "316", "--engine", "v2"]));
    const query = requests.find((r) => r.path === "/flow/v2/query");
    expect((query?.body as { flags?: unknown }).flags).toBeUndefined();
    expect(out).toHaveProperty("requestedEngine");
    expect(out.summaries[0]).toHaveProperty("id_card", 1);
    expect(requests.some((r) => r.method === "GET" && r.path === "/flow")).toBe(false);
  });

  it("card get: enxuto sem aliases nem campos internos; --full com o summary de antes", async () => {
    routes["GET /card/"] = cardRaw();
    const lean = JSON.parse(await run(["card", "get", "--flow-id", "316", "--card-id", "1001"]));
    for (const key of ["id_card", "flow_id", "step_id", "fields", "flowHash", "companyId"]) {
      expect(lean.summary).not.toHaveProperty(key);
    }
    expect(lean.summary).toMatchObject({ cardId: 1001 });

    stdout.length = 0;
    const full = JSON.parse(await run(["card", "get", "--flow-id", "316", "--card-id", "1001", "--full"]));
    expect(full.summary).toHaveProperty("id_card", 1001);
  });

  it("recipe sai como texto cru (não JSON) e nome inválido sai com exit de uso", async () => {
    process.env.TMPDIR = "/runs/run-9/tmp";
    const out = await run(["recipe", "comentar"]);
    expect(out).toContain("# Comentar num cartão");
    expect(out).toContain("PASTA_DO_RUN = /runs/run-9/tmp");
    expect(() => JSON.parse(out)).toThrow();
    expect(requests).toHaveLength(0);

    await run(["recipe", "apagar"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });
});
