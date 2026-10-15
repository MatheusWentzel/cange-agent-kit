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
    if (method === "GET" && path === "/field/by-flow") return json(FIELDS);
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
    expect(errorMessage()).toContain("não está num campo nem num comentário do cartão 55");
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
