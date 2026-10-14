import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { applyMentionMarkup } from "../src/cli/commands/card-comment-create.js";

/**
 * P4 + P5 (cards #1367455 e #1367456): escrita em 1 passo, sem arquivo.
 *   card create --flow-id N --set ...
 *   card update-values --card-id N --set ...
 *   card move --card-id N --to <etapa> --set ...
 *   comment create --card-id N --text ... --mention ...
 * Tudo com fetch mockado (nada contra ambiente real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];

const FLOW = {
  id_flow: 316,
  name: "CNG CRM",
  form_init_id: 900,
  flow_steps: [
    { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
    { id_step: 2, name: "Agendamento", form_id: 902, index: 2 },
    { id_step: 3, name: "Ganho", form_id: 903, index: 3, isEndStep: "1" }
  ]
};

const FIELDS = [
  { id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900, required: "1" },
  { id_field: 21, name: "h_valor_ini", title: "Valor estimado", type: "CURRENCY_FIELD", form_id: 900 },
  { id_field: 30, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", form_id: 901, required: "1" },
  { id_field: 31, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 901 },
  { id_field: 32, name: "h_qualif", title: "Qualificado", type: "RADIO_BOX_FIELD", form_id: 901, options: [
    { value: "1", label: "Sim" },
    { value: "2", label: "Não" }
  ] },
  { id_field: 40, name: "h_data", title: "Data da ligação", type: "DATE_PICKER_FIELD", form_id: 902, required: "1" },
  { id_field: 50, name: "h_motivo", title: "Motivo do ganho", type: "TEXT_SHORT_FIELD", form_id: 903 }
];

/** Cartão 55 na etapa Triagem, com Observação já preenchida. */
const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  flow_step: { id_step: 1, name: "Triagem" },
  form_answers: [
    { id_form_answer: 700, form_id: 900, form_answer_fields: [{ field_id: 20, value: "Pedido ACME" }] },
    { id_form_answer: 701, form_id: 901, form_answer_fields: [{ field_id: 31, value: "cliente quente" }] }
  ]
};

const USERS = [
  { id_user: 7, name: "Ana Souza", email: "ana@acme.com" },
  { id_user: 8, name: "Ana Lima", email: "lima@acme.com" },
  { id_user: 9, name: "Bruno Reis", email: "bruno@acme.com" }
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let putFailsWith: { status: number; message: string } | undefined;
/** Respostas do PUT /form/answer em ordem (depois disso, o padrão). */
let putQueue: Array<{ status: number; body: unknown }> = [];
let cardResponse: { status: number; body: unknown } | undefined;

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  delete process.env.CANGE_FLOW_ID;
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  putFailsWith = undefined;
  putQueue = [];
  cardResponse = undefined;
  process.env.CANGE_BUSY_RETRY_MS = "5";
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
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && url.pathname === "/field/by-flow") return json(FIELDS);
    if (method === "GET" && url.pathname === "/card/") {
      return cardResponse ? json(cardResponse.body, cardResponse.status) : json(CARD);
    }
    if (method === "GET" && url.pathname === "/user/by-company") return json(USERS);
    if (method === "POST" && url.pathname === "/form/new-answer") return json({ id_card: 7001, flow_id: 316, flow_step_id: 1 });
    if (method === "PUT" && url.pathname === "/form/answer") {
      const next = putQueue.shift();
      if (next) return json(next.body, next.status);
      if (putFailsWith) return json({ message: putFailsWith.message }, putFailsWith.status);
      return json({ id_card: 55 });
    }
    if (method === "POST" && url.pathname === "/card/v2/move-step") return json({ id_card: 55, flow_step_id: body?.to_step_id });
    if (method === "POST" && url.pathname === "/card-comment") return json({ id_card_comment: 901, card_id: body?.card_id });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<unknown> {
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? JSON.parse(out) : undefined;
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

function errorMessage(): string {
  return String(JSON.parse(stderr.join("")).message);
}

describe("card create em 1 passo", () => {
  it("--flow-id + --set pelo título: payload no formulário inicial com número convertido", async () => {
    const out = (await run([
      "card", "create", "--flow-id", "316", "--set", "título=Pedido ACME", "--set", "Valor estimado=R$ 2.500,00"
    ])) as Record<string, unknown>;

    expect(process.exitCode ?? 0).toBe(0);
    const [post] = writes();
    expect(post?.path).toBe("/form/new-answer");
    expect(post?.body).toMatchObject({ id_form: 900, flow_id: 316, values: { h_titulo: "Pedido ACME", h_valor_ini: 2500 } });
    expect(out).toMatchObject({ ok: true, cardId: 7001 });
    expect(String(out.summary)).toContain("gravou Título, Valor estimado");
  });

  it("--dry-run imprime o payload resolvido + validação e não grava; obrigatório faltando = exit 2", async () => {
    const out = (await run(["card", "create", "--flow-id", "316", "--set", "Valor estimado=10", "--dry-run"])) as Record<string, any>;

    expect(writes()).toEqual([]);
    expect(out.payload).toEqual({ flowId: 316, idForm: 900, origin: "/cange-agent-kit", values: { h_valor_ini: 10 } });
    expect(out.validation).toEqual({ valid: false, message: "Falta para o formulário inicial: Título (texto)" });
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("--dry-run válido sai com exit 0", async () => {
    const out = (await run(["card", "create", "--flow-id", "316", "--values-json", '{"Título":"X"}', "--dry-run"])) as Record<string, any>;
    expect(out.validation).toEqual({ valid: true });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("campo de uma etapa na criação: erro dizendo de qual etapa ele é, nada gravado", async () => {
    await run(["card", "create", "--flow-id", "316", "--set", "Título=X", "--set", "Horas=3"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain('"Horas" é da etapa Triagem');
  });
});

describe("card update-values em 1 passo", () => {
  it("--card-id + --set: acha o formulário pelo campo (etapa atual e inicial = 2 PUTs)", async () => {
    const out = (await run([
      "card", "update-values", "--card-id", "55", "--flow-id", "316",
      "--set", "Horas=12", "--set", "Qualificado=sim", "--set", "Valor estimado=2.500,00"
    ])) as Record<string, unknown>;

    expect(process.exitCode ?? 0).toBe(0);
    const puts = writes();
    expect(puts.map((put) => put.body?.id_form)).toEqual([901, 900]);
    expect(puts[0]?.body?.values).toEqual({ h_horas: 12, h_qualif: "1" });
    expect(puts[1]?.body?.values).toEqual({ h_valor_ini: 2500 });
    expect(out).toMatchObject({ ok: true, cardId: 55, updated: ["Horas", "Qualificado", "Valor estimado"] });
  });

  it("fluxo vem do ambiente do run quando falta --flow-id", async () => {
    process.env.RUNNER_FLOW_ID = "316";
    await run(["card", "update-values", "--card-id", "55", "--set", "Horas=1"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(requests.find((request) => request.path === "/card/")?.query.get("flow_id")).toBe("316");
  });

  it("número como texto que não é número e título inexistente: uma mensagem só, exit 2", async () => {
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=doze", "--set", "Fase=2"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain('Valor inválido: Horas (número): "doze" não é número');
    expect(message).toContain('Campo desconhecido: campo "Fase" não existe');
  });

  it("campo de etapa futura: diz de qual etapa é (não grava)", async () => {
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Motivo do ganho=preço"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain('"Motivo do ganho" é da etapa Ganho');
  });

  it("422 do back (campo de outra etapa) é repassado como veio", async () => {
    putFailsWith = { status: 422, message: "O campo Horas é da etapa Triagem" };
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=1"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(errorMessage()).toBe("O campo Horas é da etapa Triagem");
  });
});

describe("card move em 1 passo", () => {
  it("origem resolvida pelo cartão, destino pelo nome; campo da origem vai no mover com o que o cartão já tem", async () => {
    const out = (await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "agendamento", "--set", "Horas=3,5"
    ])) as Record<string, unknown>;

    expect(process.exitCode ?? 0).toBe(0);
    const [move, ...rest] = writes();
    expect(rest).toEqual([]);
    expect(move?.path).toBe("/card/v2/move-step");
    expect(move?.body).toMatchObject({
      flow_id: 316,
      id_card: 55,
      from_step_id: 1,
      to_step_id: 2,
      id_form: 901,
      complete: "N",
      isFromCurrentStep: true,
      values: { h_obs: "cliente quente", h_horas: 3.5 }
    });
    expect(out).toMatchObject({ ok: true, fromStepId: 1, toStepId: 2, kept: 1 });
    expect(String(out.summary)).toBe("Cartão 55 movido de Triagem para Agendamento; gravou Horas.");
  });

  it("campos da origem, do destino e do inicial: inicial antes, mover, destino depois", async () => {
    await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "2",
      "--set", "Horas=1", "--set", "Data da ligação=06/10/2026", "--set", "Valor estimado=100"
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    const calls = writes().map((write) => `${write.method} ${write.path} ${String(write.body?.id_form)}`);
    expect(calls).toEqual(["PUT /form/answer 900", "POST /card/v2/move-step 901", "PUT /form/answer 902"]);
    expect(writes()[2]?.body?.values).toEqual({ h_data: new Date(2026, 9, 6).toISOString() });
  });

  it("--dry-run lista as chamadas resolvidas e cobra os obrigatórios da etapa atual (exit 2)", async () => {
    const out = (await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--dry-run"])) as Record<string, any>;

    expect(writes()).toEqual([]);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ call: "POST /card/v2/move-step", action: "card_move" });
    expect(out.validation.valid).toBe(false);
    expect(out.validation.message.split("\n")[0]).toBe("Falta para a etapa Triagem (atual): Horas (número)");
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("etapa final marca complete S", async () => {
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Ganho", "--set", "Horas=1"]);
    expect(writes()[0]?.body?.complete).toBe("S");
  });

  it("mover para a própria etapa: erro de uso apontando update-values, sem gravar", async () => {
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Triagem", "--set", "Horas=1"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("card update-values --card-id 55");
  });

  it("etapa inexistente lista as etapas", async () => {
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Perdido"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Triagem (id 1), Agendamento (id 2), Ganho (id 3)");
  });

  it("move-step-with-values sem --payload é o mesmo mover em 1 passo", async () => {
    await run(["card", "move-step-with-values", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=2"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()[0]?.body).toMatchObject({ id_form: 901, values: { h_horas: 2 } });
  });

  it("falha depois de uma escrita = exit 5 (parcial) com o que foi feito", async () => {
    putFailsWith = { status: 404, message: "Não foi possível encontrar o registro que você deseja alterar" };
    const out = (await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=1", "--set", "Data da ligação=06/10/2026"
    ])) as Record<string, any>;
    expect(process.exitCode).toBe(EXIT_CODES.PARTIAL);
    expect(out.done).toEqual(["POST /card/v2/move-step (etapa Triagem (atual))"]);
    expect(out.error).toContain("registro que você deseja alterar");
  });
});

describe("move-step-with-values com --payload: validação olha origem, destino e inicial", () => {
  it("campo de outra etapa diz de qual é e sugere o card move", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kit-move-"));
    const file = join(dir, "move.json");
    await writeFile(
      file,
      JSON.stringify({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_horas: "3" } })
    );
    await run(["card", "move-step-with-values", "--payload", file, "--validate-fields"]);
    await rm(dir, { recursive: true, force: true });

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain('"Horas" é da etapa Triagem (atual) (form 901)');
    expect(message).toContain("cange card move --card-id 55");
  });
});

describe("comment create em 1 passo", () => {
  it("--mention por e-mail e nome: gera mentions E marca @[Nome](id) no texto", async () => {
    const out = (await run([
      "comment", "create", "--card-id", "55", "--flow-id", "316",
      "--text", "Proposta pronta, @Bruno confere?", "--mention", "bruno", "--mention", "ana@acme.com"
    ])) as Record<string, unknown>;

    expect(process.exitCode ?? 0).toBe(0);
    const [post] = writes();
    expect(post?.path).toBe("/card-comment");
    expect(post?.body).toMatchObject({
      card_id: 55,
      flow_id: 316,
      mentions: [9, 7],
      description: "@[Ana Souza](7) Proposta pronta, @[Bruno Reis](9) confere?"
    });
    expect(out).toMatchObject({ ok: true, commentId: 901, mentions: [9, 7] });
    expect(String(out.summary)).toContain("mencionando Bruno Reis, Ana Souza");
  });

  it("menção ambígua: não grava e lista os candidatos (exit 2)", async () => {
    await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "oi", "--mention", "Ana"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Ana Souza (id 7, ana@acme.com), Ana Lima (id 8, lima@acme.com)");
  });

  it("--dry-run mostra texto e mentions resolvidos", async () => {
    const out = (await run([
      "comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "oi", "--mention", "7", "--dry-run"
    ])) as Record<string, any>;
    expect(writes()).toEqual([]);
    expect(out.payload).toMatchObject({ cardId: 55, flowId: 316, description: "@[Ana Souza](7) oi", mentions: [7] });
  });

  it("sem --text: erro de uso com o comando certo", async () => {
    await run(["comment", "create", "--card-id", "55"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain('--text "<texto>"');
  });
});

describe("applyMentionMarkup", () => {
  it("não duplica marcação existente", () => {
    expect(applyMentionMarkup("@[Ana Souza](7) oi", [{ id: 7, name: "Ana Souza" }])).toBe("@[Ana Souza](7) oi");
  });
});

describe("--set", () => {
  it("o primeiro = separa (valor pode ter =) e --set sem = é erro de uso", async () => {
    const out = (await run(["card", "create", "--flow-id", "316", "--set", "Título=a=b", "--dry-run"])) as Record<string, any>;
    expect(out.payload.values).toEqual({ h_titulo: "a=b" });
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = undefined;
    await run(["card", "create", "--flow-id", "316", "--set", "Título"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain('--set espera "Campo=valor"');
  });
});

describe("contrato do back P1 no PUT /form/answer", () => {
  const backError = (status: number, message: string, complement: Record<string, unknown>) => ({
    status,
    body: { status: "error", message, complement }
  });

  it("409 STEP_FORM_ANSWER_BUSY: tenta de novo 1 vez e grava", async () => {
    putQueue = [backError(409, "Outra gravação neste cartão está em andamento.", { code: "STEP_FORM_ANSWER_BUSY" })];
    const out = (await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=1"])) as Record<string, unknown>;
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toHaveLength(2);
    expect(out).toMatchObject({ ok: true });
  });

  it("409 duas vezes: desiste e repassa a mensagem do back", async () => {
    const busy = backError(409, "Outra gravação neste cartão está em andamento.", { code: "STEP_FORM_ANSWER_BUSY" });
    putQueue = [busy, busy];
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=1"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(writes()).toHaveLength(2);
    expect(errorMessage()).toBe("Outra gravação neste cartão está em andamento.");
  });

  it("422 FIELD_FORM_MISMATCH: refaz 1 vez com o expected_form_id", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kit-upd-"));
    const file = join(dir, "upd.json");
    await writeFile(file, JSON.stringify({ idForm: 902, flowId: 316, cardId: 55, values: { h_horas: 1 } }));
    putQueue = [
      backError(422, 'O campo "Horas" é da etapa Triagem, não do formulário enviado.', {
        code: "FIELD_FORM_MISMATCH",
        field: "h_horas",
        expected_form_id: 901,
        sent_form_id: 902
      })
    ];
    await run(["card", "update-values", "--payload", file]);
    await rm(dir, { recursive: true, force: true });

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((write) => write.body?.id_form)).toEqual([902, 901]);
  });

  it("422 FIELD_FORM_MISMATCH de novo depois do retry: mensagem do back", async () => {
    const mismatch = backError(422, 'O campo "Horas" é da etapa Triagem, não do formulário enviado.', {
      code: "FIELD_FORM_MISMATCH",
      expected_form_id: 903
    });
    putQueue = [mismatch, mismatch];
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=1"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(writes().map((write) => write.body?.id_form)).toEqual([901, 903]);
    expect(errorMessage()).toBe('O campo "Horas" é da etapa Triagem, não do formulário enviado.');
  });

  it("422 STEP_FORM_NOT_CURRENT: 1 linha com o caminho do card move, sem self-move", async () => {
    putQueue = [
      backError(422, "O campo Horas é da etapa Triagem.\nO cartão está em Agendamento.", {
        code: "STEP_FORM_NOT_CURRENT",
        form_id: 901,
        steps: [{ id_step: 1, name: "Triagem" }],
        current_step_id: 2,
        current_step_name: "Agendamento"
      })
    ];
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=1"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(writes()).toHaveLength(1);
    const message = errorMessage();
    expect(message).not.toContain("\n");
    expect(message).toBe(
      'O campo Horas é da etapa Triagem. O cartão está em Agendamento. Grave ao mover para ela: cange card move --card-id 55 --to "Triagem" --set "Campo=valor".'
    );
    expect(writes().some((write) => write.path === "/card/v2/move-step")).toBe(false);
  });

  it("GET /card 404 CARD_DELETED: mensagem do back como está, nada gravado", async () => {
    cardResponse = {
      status: 404,
      body: { status: "error", message: "Cartão excluído: não há o que processar.", complement: { code: "CARD_DELETED", card_id: 55 } }
    };
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toBe("Cartão excluído: não há o que processar.");
  });
});
