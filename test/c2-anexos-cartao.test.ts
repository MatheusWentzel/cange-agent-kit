import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { isFileAllowed, mimeTypeOf, parseAllowedFileTypes } from "../src/utils/attachFieldTypes.js";
import { resolveRunFile } from "../src/utils/runFile.js";

/**
 * C2 (onda 1, 14/10/2026): o agente lê e põe arquivos no cartão, nos campos de anexo e
 * nos comentários. Fetch mockado, nada real.
 *
 * Desenho: `attachment upload` só sobe (o arquivo não aparece para ninguém); pôr no
 * cartão é `comment create --attachment-id` ou `attachment link-field`, e é esse passo
 * que o back trata como a ação "Anexos" (permissão e aprovação). Assim a retomada depois
 * da aprovação roda o MESMO comando, com o mesmo id, sem precisar do arquivo de novo.
 */

const envBackup = { ...process.env };
/** Tmp do sistema ANTES de o teste apontar o TMPDIR para a pasta do run. */
const BASE_TMP = tmpdir();

function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

/** O bot do agente é o usuário 9995. */
const TOKEN = runToken({ id_user: 9995, company_id: 67, agent_id: 206, run_id: 500, token_type: "agent_run" });

const FLOW = {
  id_flow: 316,
  name: "CNG CRM",
  form_init_id: 900,
  flow_steps: [
    { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
    { id_step: 2, name: "Fiscal", form_id: 902, index: 2 }
  ]
};

const FIELDS = [
  { id_field: 701, name: "hashcontrato", title: "Contrato", type: "INPUT_ATTACH_FIELD", form_id: 900, filter_schema: '{"allowedFileTypes":["pdf"]}' },
  { id_field: 702, name: "hashcomprovante", title: "Comprovante", type: "INPUT_ATTACH_FIELD", form_id: 901 },
  { id_field: 703, name: "hashnf", title: "Nota fiscal", type: "INPUT_ATTACH_FIELD", form_id: 902 },
  { id_field: 704, name: "hashobs", title: "Observação", type: "TEXT_SHORT_FIELD", form_id: 900 }
];

/** Cadastro 175 (form 950) com um campo de anexo; a entrada 8812 já tem o 8001 (de outra pessoa). */
const REGISTER = { id_register: 175, name: "Fornecedores", form_id: 950 };
const REGISTER_FIELDS = [
  { id_field: 801, name: "hashdocfornec", title: "Documento", type: "INPUT_ATTACH_FIELD", form_id: 950 },
  { id_field: 802, name: "hashnomefornec", title: "Nome", type: "TEXT_SHORT_FIELD", form_id: 950 }
];
const REGISTER_ENTRY = [
  {
    id_form_answer: 8812,
    register_id: 175,
    form_id: 950,
    deleted: "N",
    form_answer_fields: [
      { field_id: 801, value: "8001", deleted: "N", field: { id_field: 801, type: "INPUT_ATTACH_FIELD", name: "hashdocfornec" } },
      { field_id: 802, value: "ACME", deleted: "N" }
    ]
  }
];

/** Cartão 55 na etapa Triagem. O 5002 foi tirado do campo; a resposta 2 foi apagada. */
const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  title: "Pedido ACME",
  form_answers: [
    {
      id_form_answer: 1,
      form_id: 900,
      deleted: "N",
      dt_created: "2026-10-01T10:00:00.000Z",
      form_answer_fields: [
        { field_id: 701, value: "5001", deleted: "N" },
        { field_id: 701, value: "5002", deleted: "S" },
        { field_id: 704, value: "texto", deleted: "N" }
      ]
    },
    {
      id_form_answer: 2,
      form_id: 901,
      deleted: "S",
      dt_created: "2026-10-02T10:00:00.000Z",
      form_answer_fields: [{ field_id: 702, value: "5003", deleted: "N" }]
    }
  ]
};

const COMMENTS = [
  {
    id_card_comment: 77,
    card_id: 55,
    description: "segue a foto",
    dt_created_string: "01/10/2026 às 10:00",
    user: { id_user: 7, name: "Ana Souza" },
    attachments: [{ id_attachment: 6001, original_name: "foto.png", mime_type: "image/png", blob_size: 12.4, user_id: 7 }]
  },
  { id_card_comment: 78, card_id: 55, description: "sem arquivo", user: { id_user: 7, name: "Ana Souza" }, attachments: [] }
];

/** Anexos da empresa (o `POST /attachment/batch` devolve só os pedidos que existem). */
const ATTACHMENTS: Record<number, Record<string, unknown>> = {
  5001: { id_attachment: 5001, original_name: "contrato.pdf", mime_type: "application/pdf", blob_size: 100, user_id: 7 },
  5002: { id_attachment: 5002, original_name: "antigo.pdf", mime_type: "application/pdf", blob_size: 10, user_id: 7 },
  6001: { id_attachment: 6001, original_name: "foto.png", mime_type: "image/png", blob_size: 12.4, user_id: 7 },
  7001: { id_attachment: 7001, original_name: "relatorio.pdf", mime_type: "application/pdf", blob_size: 40, user_id: 9995 },
  7002: { id_attachment: 7002, original_name: "grafico.png", mime_type: "image/png", blob_size: 20, user_id: 9995 },
  8001: { id_attachment: 8001, original_name: "segredo.pdf", mime_type: "application/pdf", blob_size: 5, user_id: 5 }
};

interface Captured {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
  form?: FormData;
}

const stdout: string[] = [];
const stderr: string[] = [];
const requests: Captured[] = [];
let cardBody: Record<string, unknown> = CARD;
let fieldsBody: Array<Record<string, unknown>> = FIELDS;
/** Aba Anexos do cartão (`GET /attachment/by-card`). */
let cardTabBody: Array<Record<string, unknown>> = [];
/** `GET /form/pre-answer` por formulário (ausente = 404, a rota que não existe). */
let preAnswers: Record<string, { status?: number; body: unknown }> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let runDir = "";

beforeAll(async () => {
  runDir = await mkdtemp(join(BASE_TMP, "cange-c2-run-"));
});

afterAll(async () => {
  await rm(runDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = TOKEN;
  process.env.TMPDIR = runDir;
  for (const name of [
    "CANGE_OUTPUT_PROFILE",
    "RUNNER_FLOW_ID",
    "CANGE_CARD_FLOW_ID",
    "CANGE_FLOW_ID",
    "RUNNER_CARD_ID",
    "CANGE_CARD_ID",
    "CANGE_FORCE_DRY_RUN"
  ]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  cardBody = CARD;
  fieldsBody = FIELDS;
  cardTabBody = [];
  preAnswers = {};
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
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, query: url.searchParams, body, ...(form ? { form } : {}) });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (method === "GET" && path === "/card") return json(cardBody);
    if (method === "GET" && path === "/flow") return json(FLOW);
    if (method === "GET" && path === "/field/by-flow") return json(fieldsBody);
    if (method === "GET" && path === "/attachment/by-card") return json(cardTabBody);
    if (method === "GET" && path === "/register") return json(REGISTER);
    if (method === "GET" && path === "/field/by-register") return json(REGISTER_FIELDS);
    if (method === "GET" && path === "/form/answer") {
      return url.searchParams.get("id_form_answer") === "8812" ? json(REGISTER_ENTRY) : json([]);
    }
    if (method === "POST" && path === "/form/new-answer") return json({ id_form_answer: 9300, id_card: 990, flow_id: 316, flow_step_id: 1 });
    if (method === "GET" && path === "/card-comment/by-card") return json(COMMENTS);
    if (method === "GET" && path === "/form/pre-answer") {
      const pre = preAnswers[String(url.searchParams.get("id_form"))];
      if (pre) return json(pre.body, pre.status ?? 200);
    }
    if (method === "POST" && path === "/attachment/batch") {
      const ids = ((body as { ids?: number[] })?.ids ?? []).map(Number);
      return json(ids.map((id) => ATTACHMENTS[id]).filter(Boolean));
    }
    if (method === "GET" && path === "/attachment/url-download") {
      const id = Number(url.searchParams.get("id_attachment"));
      const record = ATTACHMENTS[id];
      if (!record) return json({ message: "não encontrado" }, 404);
      return json({
        url: `https://blob.test/${id}`,
        file_name: record.original_name,
        mime_type: record.mime_type,
        ...(url.searchParams.get("withBase64") === "true"
          ? { base64: Buffer.from(`conteudo-${id}`).toString("base64") }
          : {})
      });
    }
    if (method === "POST" && path === "/attachment") {
      return json({ id_attachment: 9100, original_name: "x", hash: "h" });
    }
    if (method === "POST" && path === "/card-comment") return json({ id_card_comment: 501, card_id: 55 });
    if (method === "PUT" && path === "/form/answer") return json({ ok: true });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<Record<string, any> | undefined> {
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? JSON.parse(out) : undefined;
}

function writes(): Captured[] {
  return requests.filter((request) => request.method !== "GET" && request.path !== "/attachment/batch");
}

function errorMessage(): string {
  return String(JSON.parse(stderr.join("")).message);
}

const CARD_ARGS = ["--card-id", "55", "--flow-id", "316"];

describe("arquivo só da pasta desta execução (resolveRunFile)", () => {
  it("aceita arquivo dentro da pasta e devolve nome e tamanho", async () => {
    const file = join(runDir, "proposta.pdf");
    await writeFile(file, "%PDF-1.4 teste");
    const resolved = await resolveRunFile(file, { root: runDir });
    expect(resolved.fileName).toBe("proposta.pdf");
    expect(resolved.bytes).toBe(14);
  });

  it('recusa caminho com "..", mesmo que caia dentro da pasta', async () => {
    await mkdir(join(runDir, "sub"), { recursive: true });
    await writeFile(join(runDir, "a.txt"), "x");
    await expect(resolveRunFile(`${runDir}/sub/../a.txt`, { root: runDir })).rejects.toThrow('sem ".."');
  });

  it("recusa arquivo fora da pasta da execução", async () => {
    const outside = await mkdtemp(join(BASE_TMP, "cange-c2-fora-"));
    try {
      await writeFile(join(outside, "x.txt"), "x");
      await expect(resolveRunFile(join(outside, "x.txt"), { root: runDir })).rejects.toThrow("pasta desta execução");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("recusa link simbólico que aponta para fora da pasta", async () => {
    const outside = await mkdtemp(join(BASE_TMP, "cange-c2-alvo-"));
    try {
      await writeFile(join(outside, "segredo.txt"), "x");
      await symlink(join(outside, "segredo.txt"), join(runDir, "link.txt"));
      await expect(resolveRunFile(join(runDir, "link.txt"), { root: runDir })).rejects.toThrow("aponta para fora");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("recusa arquivo vazio, pasta e arquivo acima do limite", async () => {
    await writeFile(join(runDir, "vazio.txt"), "");
    await mkdir(join(runDir, "pasta"), { recursive: true });
    await writeFile(join(runDir, "grande.bin"), Buffer.alloc(2048));
    await expect(resolveRunFile(join(runDir, "vazio.txt"), { root: runDir })).rejects.toThrow("vazio");
    await expect(resolveRunFile(join(runDir, "pasta"), { root: runDir })).rejects.toThrow("não é um arquivo comum");
    await expect(resolveRunFile(join(runDir, "grande.bin"), { root: runDir, maxBytes: 1024 })).rejects.toThrow("limite");
  });
});

describe("tipos aceitos pelo campo (espelho do back #674)", () => {
  it("lê o filter_schema e confere por tipo OU extensão", () => {
    const pdf = parseAllowedFileTypes('{"allowedFileTypes":["pdf","coisa"]}');
    expect(pdf).toEqual(["pdf"]);
    expect(isFileAllowed("application/octet-stream", "proposta.PDF", pdf)).toBe(true);
    expect(isFileAllowed("image/png", "foto.png", pdf)).toBe(false);
    expect(isFileAllowed("image/png", "foto.png", parseAllowedFileTypes("lixo"))).toBe(true);
    expect(isFileAllowed("image/png", "foto.png", parseAllowedFileTypes(undefined))).toBe(true);
  });

  it("tipo pela extensão só da lista que o back aceita (html vira octet-stream)", () => {
    expect(mimeTypeOf("a.pdf")).toBe("application/pdf");
    expect(mimeTypeOf("planilha.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeTypeOf("pagina.html")).toBe("application/octet-stream");
  });
});

describe("(a)(b) attachment list: arquivos dos campos de anexo e dos comentários", () => {
  it("lista cada campo de anexo (com os tipos aceitos) e os comentários com arquivo", async () => {
    const out = await run(["attachment", "list", ...CARD_ARGS]);
    expect(out?.total).toBe(2);
    const contrato = out?.fields.find((field: any) => field.title === "Contrato");
    expect(contrato).toMatchObject({ fieldId: 701, allowedTypes: "PDF" });
    // O 5002 foi tirado do campo (deleted "S") e a resposta 2 foi apagada: não aparecem.
    expect(contrato.files).toEqual([{ attachmentId: 5001, fileName: "contrato.pdf", mimeType: "application/pdf", sizeKb: 100 }]);
    expect(out?.fields.map((field: any) => field.title)).toEqual(["Contrato", "Comprovante", "Nota fiscal"]);
    expect(out?.comments).toEqual([
      {
        commentId: 77,
        author: "Ana Souza",
        createdAt: "01/10/2026 às 10:00",
        files: [{ attachmentId: 6001, fileName: "foto.png", mimeType: "image/png", sizeKb: 12 }]
      }
    ]);
    expect(writes()).toEqual([]);
  });
});

describe("onda 1b (item 6): o arquivo que a pessoa citou, no campo ou na colaboração", () => {
  /** O cartão 55 com um contrato no campo e outro na colaboração (comentário da Ana). */
  const TWO_CONTRACTS = [
    ...COMMENTS,
    {
      id_card_comment: 79,
      card_id: 55,
      description: "versão assinada",
      dt_created_string: "02/10/2026 às 09:00",
      user: { id_user: 7, name: "Ana Souza" },
      attachments: [{ id_attachment: 6002, original_name: "Contrato assinado.pdf", mime_type: "application/pdf", blob_size: 80, user_id: 7 }]
    }
  ];

  it("files junta campo e colaboração numa lista só, cada um dizendo de onde vem", async () => {
    const out = await run(["attachment", "list", ...CARD_ARGS]);
    expect(out?.files).toEqual([
      { attachmentId: 5001, fileName: "contrato.pdf", source: "campo", where: 'campo "Contrato"', field: "Contrato", mimeType: "application/pdf", sizeKb: 100 },
      {
        attachmentId: 6001,
        fileName: "foto.png",
        source: "colaboracao",
        where: "colaboração (comentário de Ana Souza em 01/10/2026 às 10:00)",
        author: "Ana Souza",
        createdAt: "01/10/2026 às 10:00",
        mimeType: "image/png",
        sizeKb: 12
      }
    ]);
    // Onda 1i (revisão do Alex): sem --name é listagem. Dois arquivos não viram pergunta:
    // automação e rotina leem os anexos sem ter a quem perguntar.
    expect(out?.ask).toBeUndefined();
    expect(out?.match).toBeUndefined();
    expect(out?.next).toBe("cange attachment download --card-id 55 --attachment-id <id> --out <pasta>");
  });

  it("--name que só diz \"o arquivo do cartão\" com dois arquivos: a pessoa citou, então pergunta", async () => {
    const out = await run(["attachment", "list", ...CARD_ARGS, "--name", "o arquivo do cartão"]);
    expect(out?.ask).toBe(
      'Encontrei o arquivo contrato.pdf no campo "Contrato" e o arquivo foto.png na colaboração (comentário de Ana Souza em 01/10/2026 às 10:00). De qual você está falando?'
    );
  });

  it("--name compara palavra inteira ou começo de palavra, sem a data do comentário", async () => {
    // "10" estava na data do comentário (01/10/2026 às 10:00): achava a foto sozinha e o agente usava direto.
    const byDate = await run(["attachment", "list", ...CARD_ARGS, "--name", "10"]);
    expect(byDate?.match).toEqual({ name: "10", found: 0, exact: false });
    expect(byDate?.ask).toMatch(/^Não encontrei arquivo com o nome "10"/);
    // Pedaço do meio da palavra não acha ("trato" dentro de "contrato").
    stdout.length = 0;
    const middle = await run(["attachment", "list", ...CARD_ARGS, "--name", "trato"]);
    expect(middle?.match).toEqual({ name: "trato", found: 0, exact: false });
    // Começo de palavra acha.
    stdout.length = 0;
    const prefix = await run(["attachment", "list", ...CARD_ARGS, "--name", "contr"]);
    expect(prefix?.files.map((f: any) => f.attachmentId)).toEqual([5001]);
    expect(prefix?.ask).toBeUndefined();
  });

  it("--name com um só candidato: usa direto (sem pergunta, o next já baixa ele)", async () => {
    const out = await run(["attachment", "list", ...CARD_ARGS, "--name", "a foto do cartão"]);
    expect(out?.files.map((f: any) => f.attachmentId)).toEqual([6001]);
    expect(out?.match).toEqual({ name: "a foto do cartão", found: 1, exact: true });
    expect(out?.ask).toBeUndefined();
    expect(out?.next).toBe("cange attachment download --card-id 55 --attachment-id 6001 --out <pasta>");
  });

  it("--name que bate no campo E na colaboração: pergunta qual, citando os dois", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.replace(/\/+$/, "") === "/card-comment/by-card") return json(TWO_CONTRACTS);
      if ((init?.method ?? "GET") === "GET" && url.pathname.replace(/\/+$/, "") === "/card") return json(CARD);
      if ((init?.method ?? "GET") === "GET" && url.pathname.replace(/\/+$/, "") === "/field/by-flow") return json(FIELDS);
      if ((init?.method ?? "GET") === "GET" && url.pathname.replace(/\/+$/, "") === "/attachment/by-card") return json([]);
      if ((init?.method ?? "GET") === "GET" && url.pathname.replace(/\/+$/, "") === "/flow") return json(FLOW);
      if (url.pathname.replace(/\/+$/, "") === "/attachment/batch") {
        const ids = (JSON.parse(String(init?.body)).ids ?? []).map(Number);
        return json(ids.map((id: number) => ATTACHMENTS[id]).filter(Boolean));
      }
      return json({ message: "rota não mockada" }, 404);
    });
    const out = await run(["attachment", "list", ...CARD_ARGS, "--name", "o contrato"]);
    expect(out?.files.map((f: any) => f.attachmentId)).toEqual([5001, 6002]);
    expect(out?.ask).toBe(
      'Encontrei o arquivo contrato.pdf no campo "Contrato" e o arquivo Contrato assinado.pdf na colaboração (comentário de Ana Souza em 02/10/2026 às 09:00). De qual você está falando?'
    );
    expect(out?.next).toBe("cange attachment download --card-id 55 --attachment-id <id> --out <pasta>");
    // "o contrato da colaboração" separa os dois pelo lugar.
    stdout.length = 0;
    const narrowed = await run(["attachment", "list", ...CARD_ARGS, "--name", "o contrato da colaboração"]);
    expect(narrowed?.files.map((f: any) => f.attachmentId)).toEqual([6002]);
    expect(narrowed?.ask).toBeUndefined();
  });

  it("--name que não bate com nenhum: devolve todos e pergunta qual é", async () => {
    const out = await run(["attachment", "list", ...CARD_ARGS, "--name", "planilha de custos"]);
    expect(out?.match).toEqual({ name: "planilha de custos", found: 0, exact: false });
    expect(out?.files.map((f: any) => f.attachmentId)).toEqual([5001, 6001]);
    expect(out?.ask).toBe(
      'Não encontrei arquivo com o nome "planilha de custos" neste cartão. Os arquivos dele são: o arquivo contrato.pdf no campo "Contrato" e o arquivo foto.png na colaboração (comentário de Ana Souza em 01/10/2026 às 10:00). De qual você está falando?'
    );
  });

  it("cartão sem arquivo nenhum: hint, sem pergunta", async () => {
    cardBody = { ...CARD, form_answers: [] };
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/card") return json(cardBody);
      if (path === "/field/by-flow") return json(FIELDS);
      if (path === "/card-comment/by-card") return json([]);
      if (path === "/attachment/by-card") return json([]);
      if (path === "/flow") return json(FLOW);
      if (path === "/attachment/batch") return json([]);
      return json({ message: "rota não mockada" }, 404);
    });
    const out = await run(["attachment", "list", ...CARD_ARGS, "--name", "contrato"]);
    expect(out?.total).toBe(0);
    expect(out?.ask).toBeUndefined();
    expect(out?.hint).toMatch(/não tem arquivo nos campos de anexo nem na colaboração/);
  });
});

describe("(a)(b) attachment download --attachment-id / --from", () => {
  it("baixa o anexo do comentário pelo id, com o id na frente do nome", async () => {
    const outDir = join(runDir, "anexos-1");
    const out = await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "6001", "--out", outDir]);
    expect(out?.count).toBe(1);
    expect(out?.files[0]).toMatchObject({ attachmentId: 6001, file_name: "6001-foto.png" });
    expect(await readFile(join(outDir, "6001-foto.png"), "utf8")).toBe("conteudo-6001");
    const download = requests.find((request) => request.path === "/attachment/url-download");
    expect(download?.query.get("withBase64")).toBe("true");
  });

  it("--from todos baixa os dos campos e dos comentários", async () => {
    const outDir = join(runDir, "anexos-2");
    const out = await run(["attachment", "download", ...CARD_ARGS, "--from", "todos", "--out", outDir]);
    expect(out?.files.map((file: any) => file.attachmentId)).toEqual([5001, 6001]);
    expect((await readdir(outDir)).sort()).toEqual(["5001-contrato.pdf", "6001-foto.png"]);
  });

  it("anexo que não é do cartão: exit 2 e nada baixado", async () => {
    await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "8001", "--out", join(runDir, "anexos-3")]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("não está num campo, num comentário nem na aba Anexos do cartão 55");
    expect(requests.some((request) => request.path === "/attachment/url-download")).toBe(false);
  });
});

describe("attachment upload: só sobe, da pasta desta execução", () => {
  it("sobe com o nome e o tipo pela extensão e devolve o próximo passo", async () => {
    const file = join(runDir, "relatorio.pdf");
    await writeFile(file, "%PDF-1.4 relatorio");
    const out = await run(["attachment", "upload", "--file", file]);
    expect(out).toMatchObject({ ok: true, attachmentId: 9100, fileName: "relatorio.pdf", mimeType: "application/pdf" });
    expect(out?.next[0]).toContain("--attachment-id 9100");
    const upload = writes().find((request) => request.path === "/attachment");
    const sent = upload?.form?.get("file") as File | null;
    expect(sent?.name).toBe("relatorio.pdf");
    expect(sent?.type).toBe("application/pdf");
  });

  it("arquivo fora da pasta da execução: exit 2 e nada sobe", async () => {
    const outside = await mkdtemp(join(BASE_TMP, "cange-c2-up-"));
    try {
      await writeFile(join(outside, "x.pdf"), "x");
      await run(["attachment", "upload", "--file", join(outside, "x.pdf")]);
      expect(process.exitCode).toBe(2);
      expect(errorMessage()).toContain("pasta desta execução");
      expect(writes()).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("--dry-run e CANGE_FORCE_DRY_RUN conferem sem subir", async () => {
    const file = join(runDir, "seco.pdf");
    await writeFile(file, "%PDF");
    const out = await run(["attachment", "upload", "--file", file, "--dry-run"]);
    expect(out).toMatchObject({ dryRun: true, executed: false, payload: { fileName: "seco.pdf", bytes: 4 } });
    stdout.length = 0;
    process.env.CANGE_FORCE_DRY_RUN = "1";
    const forced = await run(["attachment", "upload", "--file", file]);
    expect(forced).toMatchObject({ dryRun: true, executed: false });
    expect(writes()).toEqual([]);
  });
});

describe("(c) comment create --attachment-id: comentário com arquivo", () => {
  it("anexo que o próprio agente subiu vai em attachment_ids", async () => {
    const out = await run(["comment", "create", ...CARD_ARGS, "--text", "Segue o relatório", "--attachment-id", "7001"]);
    expect(out).toMatchObject({ ok: true, commentId: 501, attachments: [{ attachmentId: 7001, fileName: "relatorio.pdf" }] });
    const post = writes().find((request) => request.path === "/card-comment");
    expect(post?.body).toMatchObject({ card_id: 55, flow_id: 316, description: "Segue o relatório", attachment_ids: [7001] });
  });

  it("anexo de outro comentário do cartão também vale (repassar um arquivo do cartão)", async () => {
    await run(["comment", "create", ...CARD_ARGS, "--text", "Reenviando", "--attachment-id", "6001"]);
    expect(writes().find((request) => request.path === "/card-comment")?.body).toMatchObject({ attachment_ids: [6001] });
  });

  it("--dry-run devolve o plano com action attachment (o runner pede a aprovação de Anexos)", async () => {
    const out = await run(["comment", "create", ...CARD_ARGS, "--text", "Segue", "--attachment-id", "7001", "--dry-run"]);
    expect(out).toMatchObject({ dryRun: true, executed: false, payload: { cardId: 55, attachmentIds: [7001], fileNames: ["relatorio.pdf"] } });
    expect(out?.calls).toEqual([
      { action: "attachment", payload: expect.objectContaining({ cardId: 55, flowId: 316, attachmentIds: [7001], fileNames: ["relatorio.pdf"] }) }
    ]);
    expect(writes()).toEqual([]);
  });

  it("anexo de fora do cartão e de outra pessoa: exit 2, nada gravado", async () => {
    await run(["comment", "create", ...CARD_ARGS, "--text", "Olha isto", "--attachment-id", "8001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("não está no cartão 55 e não foi você que subiu");
    expect(writes()).toEqual([]);
  });

  it("anexo no --payload é recusado (só pela flag)", async () => {
    const payload = join(runDir, "comentario.json");
    await writeFile(payload, JSON.stringify({ cardId: 55, flowId: 316, description: "x", attachmentIds: [7001] }));
    await run(["comment", "create", "--payload", payload]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
  });
});

describe("(d) attachment link-field: arquivo num campo de anexo", () => {
  it("soma ao que o campo já tem (o PUT troca a lista inteira)", async () => {
    const out = await run(["attachment", "link-field", ...CARD_ARGS, "--field", "contrato", "--attachment-id", "7001"]);
    expect(out).toMatchObject({ ok: true, field: "Contrato", added: [{ attachmentId: 7001, fileName: "relatorio.pdf" }] });
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ id_form: 900, flow_id: 316, card_id: 55, values: { hashcontrato: [5001, 7001] } });
    // Só o campo de anexo vai no PUT (o back trata como a ação Anexos).
    expect(Object.keys((put?.body as { values: Record<string, unknown> }).values)).toEqual(["hashcontrato"]);
  });

  it("campo da etapa atual sem resposta ainda: grava a lista nova", async () => {
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "702", "--attachment-id", "7002"]);
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ id_form: 901, values: { hashcomprovante: [7002] } });
  });

  it("tipo que o campo não aceita: exit 2, nada gravado", async () => {
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Contrato", "--attachment-id", "7002"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain('o campo "Contrato" aceita só PDF');
    expect(writes()).toEqual([]);
  });

  it("arquivo que já está no campo: noop, sem gravar", async () => {
    const out = await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Contrato", "--attachment-id", "5001"]);
    expect(out).toMatchObject({ ok: true, noop: true });
    expect(writes()).toEqual([]);
  });

  it("campo de etapa que o cartão ainda não passou: exit 2", async () => {
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Nota fiscal", "--attachment-id", "7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain('é da etapa "Fiscal"');
    expect(writes()).toEqual([]);
  });

  it("campo que não é de anexo: exit 2 com a lista dos campos de anexo", async () => {
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Observação", "--attachment-id", "7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain('não é um campo de anexo deste fluxo');
    expect(writes()).toEqual([]);
  });

  it("--dry-run devolve o plano action attachment com a lista que será gravada", async () => {
    const out = await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Contrato", "--attachment-id", "7001", "--dry-run"]);
    expect(out).toMatchObject({ dryRun: true, executed: false });
    expect(out?.calls).toEqual([
      {
        action: "attachment",
        payload: {
          cardId: 55,
          flowId: 316,
          idForm: 900,
          fieldId: 701,
          fieldTitle: "Contrato",
          fileNames: ["relatorio.pdf"],
          attachmentIds: [7001],
          values: { hashcontrato: [5001, 7001] }
        }
      }
    ]);
    expect(writes()).toEqual([]);
  });

  it("--dry-run de arquivo que já está no campo: noop com plano vazio (o runner libera sem pedido)", async () => {
    const out = await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Contrato", "--attachment-id", "5001", "--dry-run"]);
    expect(out).toMatchObject({ dryRun: true, executed: false, noop: true, calls: [] });
  });
});

describe("--set em campo de anexo é recusado (trocaria a lista inteira)", () => {
  it("card update-values com campo de anexo: exit 2 com o comando certo", async () => {
    await run(["card", "update-values", ...CARD_ARGS, "--set", "Contrato=7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("attachment link-field");
    expect(writes()).toEqual([]);
  });
});

describe("B1 (review do Alex): o rascunho da etapa atual entra na lista do campo", () => {
  /** Cartão 55 na Triagem (form 901), com o rascunho da etapa: a pessoa anexou o 5001 pela tela. */
  const CARD_ON_TRIAGEM = { ...CARD, flow_step: { id_step: 1, name: "Triagem", form_id: 901 } };
  const DRAFT = {
    fields: [],
    formsAnswers: {
      id_form_answer: 3,
      form_id: 901,
      card_id: 55,
      flow_step_id: null,
      deleted: "N",
      dt_created: "2026-10-03T10:00:00.000Z",
      form_answer_fields: [
        { field_id: 702, value: "5001", deleted: "N", field: { id_field: 702, type: "INPUT_ATTACH_FIELD", name: "hashcomprovante" } }
      ]
    }
  };

  it("link-field do 7001 grava [5001, 7001]: o arquivo do rascunho não some", async () => {
    cardBody = CARD_ON_TRIAGEM;
    preAnswers = { "901": { body: DRAFT } };
    const out = await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Comprovante", "--attachment-id", "7001"]);
    expect(out).toMatchObject({ ok: true, field: "Comprovante", added: [{ attachmentId: 7001 }] });
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ id_form: 901, values: { hashcomprovante: [5001, 7001] } });
  });

  it("attachment list mostra o 5001 no campo da etapa atual", async () => {
    cardBody = CARD_ON_TRIAGEM;
    preAnswers = { "901": { body: DRAFT } };
    const out = await run(["attachment", "list", ...CARD_ARGS]);
    const comprovante = out?.fields.find((field: any) => field.title === "Comprovante");
    expect(comprovante.files.map((file: any) => file.attachmentId)).toEqual([5001]);
    const pre = requests.find((request) => request.path === "/form/pre-answer");
    expect(pre?.query.get("card_id")).toBe("55");
    expect(pre?.query.get("id_form")).toBe("901");
  });

  it("download --from campos e --attachment-id enxergam o arquivo do rascunho", async () => {
    cardBody = CARD_ON_TRIAGEM;
    preAnswers = { "901": { body: DRAFT } };
    const byId = await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "5001"]);
    expect(byId?.files.map((file: any) => file.attachmentId)).toEqual([5001]);
    stdout.length = 0;
    const fromFields = await run(["attachment", "download", ...CARD_ARGS, "--from", "campos"]);
    expect(fromFields?.files.map((file: any) => file.attachmentId)).toEqual([5001]);
  });

  it("sem flow_step no cartão, acha o formulário da etapa pelo fluxo", async () => {
    preAnswers = { "901": { body: DRAFT } };
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Comprovante", "--attachment-id", "7001"]);
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ values: { hashcomprovante: [5001, 7001] } });
  });

  it("rascunho mais novo que a passagem confirmada: vale o rascunho (onde o back grava)", async () => {
    cardBody = {
      ...CARD_ON_TRIAGEM,
      form_answers: [
        ...CARD.form_answers,
        {
          id_form_answer: 4,
          form_id: 901,
          flow_step_id: 1,
          deleted: "N",
          dt_created: "2026-10-02T12:00:00.000Z",
          form_answer_fields: [{ field_id: 702, value: "6001", deleted: "N" }]
        }
      ]
    };
    preAnswers = { "901": { body: DRAFT } };
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Comprovante", "--attachment-id", "7001"]);
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ values: { hashcomprovante: [5001, 7001] } });
  });

  it("objeto montado da última passagem (sem id) não conta como rascunho", async () => {
    cardBody = CARD_ON_TRIAGEM;
    preAnswers = {
      "901": {
        body: {
          fields: [],
          formsAnswers: { form_id: 901, flow_step_id: null, deleted: "N", origin: "return-step-autocomplete", form_answer_fields: [{ field_id: 702, value: "5001" }] }
        }
      }
    };
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Comprovante", "--attachment-id", "7001"]);
    const put = writes().find((request) => request.path === "/form/answer");
    expect(put?.body).toMatchObject({ values: { hashcomprovante: [7001] } });
  });

  it("falha ao ler o rascunho: exit diferente de 0 e nada gravado", async () => {
    cardBody = CARD_ON_TRIAGEM;
    preAnswers = { "901": { status: 403, body: { message: "sem acesso" } } };
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Comprovante", "--attachment-id", "7001"]);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
    expect(writes()).toEqual([]);
  });
});

describe("I1 (review do Alex): campo de anexo na criação de cartão e no cadastro aceita o id", () => {
  function newAnswer(): Record<string, any> | undefined {
    return writes().find((request) => request.method === "POST" && request.path === "/form/new-answer")?.body as any;
  }

  it("card create --set no campo de anexo do formulário inicial grava o id que o bot subiu", async () => {
    const out = await run(["card", "create", "--flow-id", "316", "--set", "Contrato=7001"]);
    expect(out).toMatchObject({ ok: true });
    expect(newAnswer()).toMatchObject({ id_form: 900, flow_id: 316, values: { hashcontrato: [7001] } });
  });

  it("card create --payload com o id no campo de anexo (hash) também vale", async () => {
    const payload = join(runDir, "cartao-anexo.json");
    await writeFile(payload, JSON.stringify({ flowId: 316, idForm: 900, origin: "/x", values: { hashcontrato: "7001,7002" } }));
    await run(["card", "create", "--payload", payload]);
    expect(newAnswer()).toMatchObject({ values: { hashcontrato: [7001, 7002] } });
  });

  it("anexo obrigatório no formulário inicial: o id conta como preenchido", async () => {
    fieldsBody = FIELDS.map((field) => (field.id_field === 701 ? { ...field, required: true } : field));
    const out = await run(["card", "create", "--flow-id", "316", "--set", "Contrato=7001", "--validate-fields", "--dry-run"]);
    expect(out?.validation).toEqual({ valid: true });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("card create com anexo de outra pessoa: exit 2, nada gravado", async () => {
    await run(["card", "create", "--flow-id", "316", "--set", "Contrato=8001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("o anexo 8001 não foi você que subiu");
    expect(writes()).toEqual([]);
  });

  it("card create com texto no campo de anexo: exit 2 com o comando de subir", async () => {
    await run(["card", "create", "--flow-id", "316", "--set", "Contrato=contrato.pdf"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("attachment upload");
    expect(writes()).toEqual([]);
  });

  it("register create grava o id que o bot subiu", async () => {
    await run(["register", "create", "--register-id", "175", "--set", "Documento=7001", "--set", "Nome=Beta"]);
    expect(newAnswer()).toMatchObject({ id_form: 950, register_id: 175, values: { hashdocfornec: [7001], hashnomefornec: "Beta" } });
  });

  it("register create com anexo de outra pessoa: exit 2, nada gravado", async () => {
    await run(["register", "create", "--register-id", "175", "--set", "Documento=8001"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
  });

  it("register update soma à lista da entrada (o PUT troca a lista inteira)", async () => {
    await run(["register", "update", "--register-id", "175", "--form-answer-id", "8812", "--set", "Documento=7001"]);
    const read = requests.find((request) => request.method === "GET" && request.path.replace(/\/+$/, "") === "/form/answer");
    expect(read?.query.get("id_form_answer")).toBe("8812");
    const put = writes().find((request) => request.method === "PUT" && request.path === "/form/answer");
    expect(put?.body).toMatchObject({ id_form: 950, register_id: 175, form_answer_id: 8812, values: { hashdocfornec: [8001, 7001] } });
  });

  it("register update com o anexo que já está na entrada (de outra pessoa) passa e não repete", async () => {
    await run(["register", "update", "--register-id", "175", "--form-answer-id", "8812", "--set", "Documento=8001"]);
    const put = writes().find((request) => request.method === "PUT" && request.path === "/form/answer");
    expect(put?.body).toMatchObject({ values: { hashdocfornec: [8001] } });
  });

  it("register update --payload soma do mesmo jeito", async () => {
    const payload = join(runDir, "cadastro-anexo.json");
    await writeFile(payload, JSON.stringify({ idForm: 950, registerId: 175, formAnswerId: 8812, values: { hashdocfornec: [7002] } }));
    await run(["register", "update", "--payload", payload]);
    const put = writes().find((request) => request.method === "PUT" && request.path === "/form/answer");
    expect(put?.body).toMatchObject({ values: { hashdocfornec: [8001, 7002] } });
  });

  it("register update de entrada que não existe: exit 2, nada gravado", async () => {
    await run(["register", "update", "--register-id", "175", "--form-answer-id", "1", "--set", "Documento=7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("não achei a entrada 1");
    expect(writes()).toEqual([]);
  });

  it("card move segue recusando campo de anexo, apontando o link-field", async () => {
    await run(["card", "move", ...CARD_ARGS, "--to", "Fiscal", "--set", "Nota fiscal=7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("attachment link-field");
    expect(writes()).toEqual([]);
  });
});

describe("M2/M3 (review do Alex): sob o runner, só a pasta do run", () => {
  it("upload sob o runner sem TMPDIR: exit 2, não cai no tmp do sistema", async () => {
    process.env.RUNNER_CARD_ID = "55";
    delete process.env.TMPDIR;
    const file = join(runDir, "sem-tmpdir.pdf");
    await writeFile(file, "%PDF");
    await run(["attachment", "upload", "--file", file]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("TMPDIR");
    expect(writes()).toEqual([]);
  });

  it("upload sob o runner com TMPDIR = /tmp do sistema: exit 2", async () => {
    process.env.RUNNER_AGENT_ID = "206";
    process.env.TMPDIR = "/tmp";
    await run(["attachment", "upload", "--file", "/tmp/qualquer.pdf"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain("TMPDIR");
    expect(writes()).toEqual([]);
  });

  it("upload sob o runner com o TMPDIR do run segue valendo", async () => {
    process.env.RUNNER_CARD_ID = "55";
    const file = join(runDir, "com-tmpdir.pdf");
    await writeFile(file, "%PDF");
    const out = await run(["attachment", "upload", "--file", file]);
    expect(out).toMatchObject({ ok: true, attachmentId: 9100 });
  });

  it("download --out fora da pasta do run: exit 2, nada lido nem baixado", async () => {
    process.env.RUNNER_CARD_ID = "55";
    const outside = await mkdtemp(join(BASE_TMP, "cange-c2-out-"));
    try {
      await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "6001", "--out", outside]);
      expect(process.exitCode).toBe(2);
      expect(errorMessage()).toContain("pasta desta execução");
      expect(requests).toEqual([]);
      stdout.length = 0;
      stderr.length = 0;
      process.exitCode = undefined;
      await run(["attachment", "download", ...CARD_ARGS, "--out", join(runDir, "..", "fora")]);
      expect(process.exitCode).toBe(2);
      expect(requests).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("download --out com link para fora da pasta do run: exit 2", async () => {
    process.env.RUNNER_CARD_ID = "55";
    const outside = await mkdtemp(join(BASE_TMP, "cange-c2-link-"));
    try {
      await symlink(outside, join(runDir, "atalho"));
      await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "6001", "--out", join(runDir, "atalho", "anexos")]);
      expect(process.exitCode).toBe(2);
      expect(requests).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("download --out dentro da pasta do run baixa", async () => {
    process.env.RUNNER_CARD_ID = "55";
    const outDir = join(runDir, "run-anexos");
    const out = await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "6001", "--out", outDir]);
    expect(out?.files[0]).toMatchObject({ attachmentId: 6001, path: join(outDir, "6001-foto.png") });
  });
});

describe("M4 (review do Alex): aba Anexos no índice do cartão e deleted só S", () => {
  const TAB_FILE = { id_attachment: 8001, original_name: "segredo.pdf", mime_type: "application/pdf", blob_size: 5, user_id: 5 };

  it("arquivo da aba Anexos entra no list, no download por id e no comentário", async () => {
    cardTabBody = [TAB_FILE];
    const list = await run(["attachment", "list", ...CARD_ARGS]);
    expect(list?.cardTab).toEqual([{ attachmentId: 8001, fileName: "segredo.pdf", mimeType: "application/pdf", sizeKb: 5 }]);
    expect(list?.total).toBe(3);
    const tab = requests.find((request) => request.path === "/attachment/by-card");
    expect(tab?.query.get("id_card")).toBe("55");
    expect(tab?.query.get("flow_id")).toBe("316");
    stdout.length = 0;
    const byId = await run(["attachment", "download", ...CARD_ARGS, "--attachment-id", "8001"]);
    expect(byId?.files.map((file: any) => file.attachmentId)).toEqual([8001]);
    stdout.length = 0;
    // O 8001 é de outra pessoa, mas está no cartão (aba Anexos): pode ir num comentário.
    await run(["comment", "create", ...CARD_ARGS, "--text", "Reenviando", "--attachment-id", "8001"]);
    expect(writes().find((request) => request.path === "/card-comment")?.body).toMatchObject({ attachment_ids: [8001] });
  });

  it("deleted NULL e vazio contam como vivos; só S fica de fora", async () => {
    cardBody = {
      ...CARD,
      form_answers: [
        {
          id_form_answer: 1,
          form_id: 900,
          deleted: null,
          dt_created: "2026-10-01T10:00:00.000Z",
          form_answer_fields: [
            { field_id: 701, value: "5001", deleted: null },
            { field_id: 701, value: "5002", deleted: "" },
            { field_id: 701, value: "6001", deleted: " s " }
          ]
        }
      ]
    };
    const out = await run(["attachment", "list", ...CARD_ARGS]);
    const contrato = out?.fields.find((field: any) => field.title === "Contrato");
    expect(contrato.files.map((file: any) => file.attachmentId)).toEqual([5001, 5002]);
  });

  it("formulário só com resposta excluída (S com espaço) não conta como etapa por onde o cartão passou", async () => {
    cardBody = {
      ...CARD,
      flow_step_id: 1,
      form_answers: [
        ...CARD.form_answers,
        { id_form_answer: 9, form_id: 902, deleted: " S ", dt_created: "2026-10-02T10:00:00.000Z", form_answer_fields: [] }
      ]
    };
    await run(["attachment", "link-field", ...CARD_ARGS, "--field", "Nota fiscal", "--attachment-id", "7001"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toContain('é da etapa "Fiscal"');
    expect(writes()).toEqual([]);
  });
});
