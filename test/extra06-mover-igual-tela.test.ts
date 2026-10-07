import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { validateValuesAgainstFields } from "../src/contracts/payload-builder.js";
import { normalizeFieldsFromApiResponse } from "../src/schemas/fields.js";
import { readStepCarryOver, resolveByCards, sanitizeAutoCompleteDate } from "../src/utils/carryOver.js";
import { FORCE_DRY_RUN_ENV } from "../src/utils/forceDryRun.js";
import {
  checkListProgress,
  hasRequiredRule,
  isEmptyForField,
  isEmptyRichText,
  isRequiredOnScreen
} from "../src/utils/requiredFields.js";

/**
 * EXTRA-06 (E2E do lote F2-F6, 07/10/2026): o mover do kit igual à tela.
 *  - D1 (P0): o que o cartão tem na etapa vem da pré-resposta (`GET /form/pre-answer`, o
 *    rascunho da etapa ou a última passagem), não do `GET /card`; e é REENVIADO no mover
 *    (o `/card/v2/move-step` apaga o rascunho).
 *  - D2/D3: obrigatório é o que a tela cobra (regra `required` em `field.validations`).
 *  - D4: rich text `<p></p>` (e HTML sem texto) é vazio.
 *  - D5: check list com "exigir todos concluídos" (`formula = '1'`) bloqueia com item sem marcar.
 *  - Revisão (07/10): F1 rascunho x confirmada pela recência da LINHA; F2 autocompletar da
 *    tela; F3 `card move-step --allow-data-loss`.
 *  - Revisão 2 (07/10): A2-F1 origem do autocompletar vazia bloqueia (e a opção pelo rótulo é
 *    calculada); A2-F2 o mover apaga o rascunho do formulário que grava (o do destino também).
 * Fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, any> }> = [];

const STEPS = [
  { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
  { id_step: 2, name: "Agendamento", form_id: 902, index: 2 }
];

const REQUIRED = [{ id_field_validation: 1, type: "required", params: "obrigatório" }];

/** Campos como o GET /field/by-flow devolve: `required` (coluna), `validations`, `validation_type`. */
function baseFields(): Array<Record<string, unknown>> {
  return [
    { id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900, required: "1", validation_type: "string", validations: REQUIRED },
    { id_field: 30, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", form_id: 901, required: "1", validation_type: "number", validations: REQUIRED },
    { id_field: 31, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] },
    { id_field: 33, name: "h_resp", title: "Responsável pelo Atendimento", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED },
    { id_field: 36, name: "h_anexo", title: "Proposta", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] },
    { id_field: 40, name: "h_data", title: "Data da ligação", type: "DATE_PICKER_FIELD", form_id: 902, required: "1", validation_type: "string", validations: REQUIRED }
  ];
}

let fields: Array<Record<string, unknown>>;
let flow: Record<string, unknown>;
/** Respostas confirmadas (o GET /card só traz estas). */
let confirmed: Array<Record<string, any>>;
/** Pré-resposta da etapa: `undefined` = a rota responde 404 (back sem a rota), salvo com `preFields`. */
let preAnswer: Record<string, any> | undefined;
let preAnswerStatus = 200;
/** `fields` da pré-resposta (autocompletar). Definido sem `preAnswer`: a rota responde sem rascunho. */
let preFields: Array<Record<string, unknown>> | undefined;
/** Rascunho de OUTRO formulário (ex.: o do destino), por id do formulário. */
let otherDrafts: Record<number, Record<string, any>>;
/** Movimentos do cartão (`GET /card/moviment`); `undefined` = a rota responde 404. */
let movements: Array<Record<string, unknown>> | undefined;
/** Resposta do `POST /form/answers/by-register` (o autocompletar de vínculo do blur da tela). */
let byRegister: ((body: Record<string, any>) => unknown) | undefined;
/**
 * `POST /form/answers/by-cards` (o autocompletar da tela ao abrir o cartão): undefined = o mock
 * emula o back (a resposta mais nova do cartão com a origem, rascunhos incluídos); função =
 * resposta própria; "falha" = 500.
 */
let byCards: ((body: Record<string, any>) => unknown) | "falha" | undefined;
/** Vínculo do by-cards emulado: `<valor da origem>:<campo filho>` → linhas do cadastro/cartão apontado. */
let linked: Record<string, Array<Record<string, unknown>>>;
/** `GET /user/by-flow?form_id` (a lista do campo de usuário da tela); undefined = a rota responde 404. */
let usersByForm: Array<Record<string, unknown>> | undefined;
/** `POST /card/by-cards` (os cartões que o campo de cartão carrega); undefined = 404. */
let cardsByIds: ((body: Record<string, any>) => unknown) | undefined;
/** Anexos que não existem mais (`GET /attachment` responde 404); os outros respondem 200. */
let missingAttachments: Set<number>;
/** Relógio do back mockado: cada linha gravada pelo PUT ganha um `dt_last_update` mais novo. */
let clock = 0;
let nextRowId = 0;

function row(fieldId: number, value: string, index = 0, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const field = fields.find((item) => item.id_field === fieldId);
  return { field_id: fieldId, index, value, deleted: "N", field: { id_field: fieldId, name: field?.name, type: field?.type }, ...extra };
}

/** Linha com a data da última edição (e o id), como o back grava. */
function stamped(fieldId: number, value: string, at: string, index = 0): Record<string, unknown> {
  nextRowId += 1;
  return row(fieldId, value, index, { id_form_answer_field: nextRowId, dt_created: at, dt_last_update: at });
}

/** Rascunho da etapa Triagem (form_answer com flow_step_id NULL), como a tela grava. */
function draft(rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    id_form_answer: 800,
    form_id: 901,
    flow_step_id: null,
    origin: "/Flow/Card-Pre",
    dt_created: "2026-10-02T10:00:00.000Z",
    deleted: "N",
    form_answer_fields: rows,
    ...extra
  };
}

function cardRaw(): Record<string, unknown> {
  return { id_card: 55, flow_id: 316, flow_step_id: 1, user_id_creator: 76, form_answers: confirmed };
}

/** O texto da linha (o `valueString` do back): o rótulo da opção, senão o próprio valor. */
function labelOf(fieldId: unknown, value: unknown): unknown {
  const field = fields.find((item) => item.id_field === fieldId);
  const options = Array.isArray(field?.options) ? (field?.options as Array<Record<string, unknown>>) : [];
  const option = options.find((item) => String(item.value) === String(value));
  return option ? option.label : value;
}

/** O `SelectFormAnswersByCardsService` do back, sobre o cartão mockado (confirmadas e rascunhos). */
function emulateByCards(body: Record<string, any>): unknown {
  const answers = [...confirmed, ...(preAnswer ? [preAnswer] : []), ...Object.values(otherDrafts)].filter(
    (answer) => answer.deleted !== "S"
  );
  return (body.field_items as Array<Record<string, any>>).map((item) => {
    let best: Record<string, any> | undefined;
    for (const answer of answers) {
      if (!answer.form_answer_fields.some((faf: any) => faf.field_id === item.field_id)) continue;
      if (!best || best.dt_created < answer.dt_created) best = answer;
    }
    let rows: Array<Record<string, any>> | undefined = best?.form_answer_fields.filter((faf: any) => faf.field_id === item.field_id);
    if (rows && item.child_field_id !== undefined) {
      const key = rows.map((faf) => faf.value).find((value) => value !== undefined && value !== "");
      if (key !== undefined) rows = linked[`${key}:${item.child_field_id}`] ?? [];
    }
    return {
      card_id: body.card_id,
      flow_id: item.flow_id,
      field_id: item.field_id,
      child_field_id: item.child_field_id,
      ...(rows ? { formAnswer: { form_answer_fields: rows.map((faf) => ({ ...faf, valueString: faf.valueString ?? labelOf(faf.field_id, faf.value) })) } } : {})
    };
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** O PUT /form/answer do back: grava na resposta MAIS RECENTE do formulário (pode ser o rascunho). */
function putFormAnswer(body: Record<string, any>): void {
  const candidates = [...confirmed.filter((answer) => answer.form_id === body.id_form)];
  if (preAnswer && preAnswer.form_id === body.id_form) candidates.push(preAnswer);
  candidates.sort((a, b) =>
    a.dt_created === b.dt_created ? a.id_form_answer - b.id_form_answer : a.dt_created < b.dt_created ? -1 : 1
  );
  const target = candidates[candidates.length - 1];
  if (!target) throw new Error("sem resposta para gravar");
  for (const [name, value] of Object.entries(body.values as Record<string, unknown>)) {
    const field = fields.find((item) => item.name === name)!;
    target.form_answer_fields = target.form_answer_fields.filter((item: any) => item.field_id !== field.id_field);
    // O UpdateFormAnswerFieldService apaga a linha e grava outra (data e id novos).
    clock += 1000;
    target.form_answer_fields.push(stamped(field.id_field as number, String(value), new Date(clock).toISOString()));
  }
}

let dir = "";
async function payloadFile(body: Record<string, unknown>): Promise<string> {
  const file = join(dir, `move-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(body), "utf8");
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kit-extra06-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  delete process.env.CANGE_FLOW_ID;
  delete process.env[FORCE_DRY_RUN_ENV];
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  fields = baseFields();
  flow = { id_flow: 316, name: "CNG CRM", form_init_id: 900, flow_steps: STEPS };
  confirmed = [
    { id_form_answer: 700, form_id: 900, flow_step_id: 1, dt_created: "2026-09-30T10:00:00.000Z", form_answer_fields: [] },
    { id_form_answer: 701, form_id: 901, flow_step_id: 1, dt_created: "2026-10-01T10:00:00.000Z", form_answer_fields: [] }
  ];
  confirmed[0]!.form_answer_fields = [row(20, "Pedido ACME")];
  confirmed[1]!.form_answer_fields = [row(31, "antigo")];
  preAnswer = undefined;
  preAnswerStatus = 200;
  preFields = undefined;
  otherDrafts = {};
  // O cartão entrou na Triagem (etapa atual) antes de tudo o que os testes gravam.
  movements = [{ id_card_movement: 1, card_id: 55, flow_step_id: 1, dt_entry: "2026-09-30T09:00:00.000Z", dt_exit: null }];
  byRegister = undefined;
  byCards = undefined;
  linked = {};
  usersByForm = undefined;
  cardsByIds = undefined;
  missingAttachments = new Set();
  clock = Date.parse("2026-10-07T12:00:00.000Z");
  nextRowId = 1000;
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
    if (method === "GET" && url.pathname === "/flow") return json(flow);
    if (method === "GET" && url.pathname === "/field/by-flow") return json(fields);
    if (method === "GET" && url.pathname === "/card/") return json(cardRaw());
    if (method === "GET" && url.pathname === "/form/pre-answer") {
      if (preAnswerStatus !== 200) return json({ message: "falhou" }, preAnswerStatus);
      const formId = Number(url.searchParams.get("id_form"));
      const other = otherDrafts[formId];
      if (preAnswer === undefined && preFields === undefined && other === undefined) return json({ message: "rota não mockada" }, 404);
      const answer = preAnswer && preAnswer.form_id === formId ? preAnswer : (other ?? null);
      return json({ fields: preFields ?? [], formsAnswers: answer });
    }
    if (method === "GET" && url.pathname === "/card/moviment") {
      return movements === undefined ? json({ message: "rota não mockada" }, 404) : json(movements);
    }
    if (method === "POST" && url.pathname === "/form/answers/by-register") {
      return byRegister === undefined ? json({ message: "rota não mockada" }, 404) : json(byRegister(body ?? {}));
    }
    if (method === "POST" && url.pathname === "/form/answers/by-cards") {
      if (byCards === "falha") return json({ message: "falhou" }, 500);
      return json(byCards === undefined ? emulateByCards(body ?? {}) : byCards(body ?? {}));
    }
    if (method === "GET" && url.pathname === "/user/by-flow") {
      return usersByForm === undefined ? json({ message: "rota não mockada" }, 404) : json(usersByForm);
    }
    if (method === "POST" && url.pathname === "/card/by-cards") {
      return cardsByIds === undefined ? json({ message: "rota não mockada" }, 404) : json(cardsByIds(body ?? {}));
    }
    if (method === "GET" && url.pathname === "/attachment") {
      const id = Number(url.searchParams.get("id_attachment"));
      return missingAttachments.has(id)
        ? json({ message: "Parâmetros inválidos! Não foi possivel encontrar o registro!" }, 404)
        : json({ id_attachment: id, uploaded: true });
    }
    if (method === "PUT" && url.pathname === "/form/answer") {
      putFormAnswer(body);
      return json({ id_card: 55 });
    }
    if (method === "POST" && url.pathname === "/card/v2/move-step") return json({ id_card: 55, flow_step_id: body?.to_step_id });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<Record<string, any> | undefined> {
  stdout.length = 0;
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? (JSON.parse(out) as Record<string, any>) : undefined;
}

/** Leituras que o back faz por POST (o autocompletar e o combo de cartão da tela). */
const READ_POSTS = new Set(["/form/answers/by-cards", "/form/answers/by-register", "/card/by-cards"]);

function writes() {
  return requests.filter((request) => request.method !== "GET" && !READ_POSTS.has(request.path));
}

function moveBody(): Record<string, any> | undefined {
  return writes().find((request) => request.path === "/card/v2/move-step")?.body;
}

function errorMessage(): string {
  const text = stderr.join("");
  return String(JSON.parse(text.slice(text.indexOf("{"))).message);
}

// ---------------------------------------------------------------------------
// D1: a fonte é a pré-resposta, e o mover reenvia o que está nela
// ---------------------------------------------------------------------------

describe("EXTRA-06 D1: card move lê a pré-resposta da etapa atual e reenvia", () => {
  it("obrigatório preenchido só no rascunho (como o card 1121223) não bloqueia; o rascunho vai inteiro no mover", async () => {
    preAnswer = draft([row(33, "76"), row(31, "rascunho")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=2"]);

    expect(process.exitCode ?? 0).toBe(0);
    const read = requests.find((request) => request.path === "/form/pre-answer");
    expect(read?.query.get("card_id")).toBe("55");
    expect(read?.query.get("id_form")).toBe("901");
    // O do rascunho (Observação "rascunho", não o "antigo" da resposta confirmada) + o --set.
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_obs: "rascunho", h_horas: 2 });
    expect(out).toMatchObject({ ok: true, kept: 2, keptFrom: "rascunho" });
  });

  it("dry-run (gate do runner) mostra o mover com o rascunho e validação válida, sem gravar", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    preAnswer = draft([row(33, "76"), row(30, "5")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, validation: { valid: true }, kept: 2, keptFrom: "rascunho" });
    expect(out?.calls[0]).toMatchObject({ call: "POST /card/v2/move-step", payload: { values: { h_resp: 76, h_horas: 5 } } });
  });

  it("sem rascunho, o back devolve a última passagem (sintético): ela conta e é reenviada", async () => {
    preAnswer = draft([row(30, "8"), row(33, "76")], { id_form_answer: undefined, origin: "return-step-autocomplete", dt_created: undefined });
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 8, h_resp: 76 });
    expect(out).toMatchObject({ keptFrom: "ultima-passagem" });
  });

  it("rascunho sem o obrigatório: bloqueia igual à tela (a resposta confirmada antiga não conta)", async () => {
    confirmed[1]!.form_answer_fields = [row(30, "4"), row(33, "76")];
    preAnswer = draft([row(31, "só o rascunho")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Horas (número), Responsável pelo Atendimento");
  });

  it("rota sem nada (passagem anterior só com anexo ou sem linha): a tela abre vazio e o kit cobra igual", async () => {
    // O GET /card tem Horas e Responsável de uma passagem antiga; a pré-resposta volta sem
    // formsAnswers (o back não remonta a última passagem sem linha elegível).
    confirmed[1]!.form_answer_fields = [row(30, "4"), row(33, "76"), row(36, "9001")];
    preFields = [];
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Horas (número), Responsável pelo Atendimento");

    process.exitCode = undefined;
    stderr.length = 0;
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=4", "--set", "Responsável pelo Atendimento=76"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(dry).toMatchObject({ validation: { valid: true }, kept: 0, keptFrom: "vazio" });
    expect(dry?.calls[0]?.payload.values).toEqual({ h_horas: 4, h_resp: 76 });
  });

  it("back sem a rota (404): vale o GET /card como antes", async () => {
    confirmed[1]!.form_answer_fields = [row(30, "4"), row(33, "76")];
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 4, h_resp: 76 });
    expect(out).toMatchObject({ keptFrom: "cartao" });
  });

  it("falha ao ler a pré-resposta (500): não move (sem ler o rascunho, gravar poderia apagá-lo)", async () => {
    preAnswerStatus = 500;
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=2"]);

    expect(process.exitCode).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("F1: rascunho editado DEPOIS da confirmada mais nova (como o card 1107439): o rascunho vence o campo", async () => {
    // Rascunho criado às 10:00:00 e editado no dia seguinte pelo autosave da tela (a linha muda,
    // o form_answer não); a confirmada nasceu 11 s depois do rascunho, com o valor antigo.
    preAnswer = draft(
      [stamped(30, "1", "2026-10-03T09:47:24.000Z"), stamped(33, "76", "2026-10-03T09:47:25.000Z")],
      { dt_created: "2026-10-02T10:00:00.000Z" }
    );
    confirmed.push({
      id_form_answer: 801, form_id: 901, flow_step_id: 1, dt_created: "2026-10-02T10:00:11.000Z",
      form_answer_fields: [stamped(30, "9", "2026-10-02T10:00:11.000Z"), stamped(33, "76", "2026-10-02T10:00:11.000Z")]
    });
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry).toMatchObject({ dryRun: true, keptFrom: "rascunho" });
    expect(dry?.calls[0]?.payload.values).toEqual({ h_horas: 1, h_resp: 76 });
  });

  it("F1: card update-values na confirmada DEPOIS do rascunho: a confirmada vence o campo", async () => {
    // Rascunho mais antigo que a confirmada: o PUT /form/answer grava na confirmada (a mais recente).
    preAnswer = draft([stamped(30, "1", "2026-10-04T10:00:00.000Z"), stamped(33, "76", "2026-10-04T10:00:00.000Z")], {
      dt_created: "2026-10-02T10:00:00.000Z"
    });
    confirmed.push({
      id_form_answer: 801, form_id: 901, flow_step_id: 1, dt_created: "2026-10-03T10:00:00.000Z",
      form_answer_fields: [stamped(30, "4", "2026-10-03T10:00:00.000Z")]
    });
    // Antes do update-values: a linha do rascunho (editada em 04/10) é a mais nova.
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const before = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(before?.calls[0]?.payload.values).toMatchObject({ h_horas: 1 });

    delete process.env[FORCE_DRY_RUN_ENV];
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=9"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(confirmed[2]!.form_answer_fields.map((item: any) => [item.field_id, item.value])).toContainEqual([30, "9"]);

    requests.length = 0;
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 9, h_resp: 76 });
  });

  it("confirmada mais nova que o rascunho com anexo (formulário público da etapa, card 896192): o anexo não conta, como na tela", async () => {
    fields = baseFields().map((field) => (field.id_field === 36 ? { ...field, required: "1", validation_type: "mixed", validations: REQUIRED } : field));
    preAnswer = draft([stamped(30, "1", "2026-10-04T10:00:00.000Z"), stamped(33, "76", "2026-10-04T10:00:00.000Z")], {
      dt_created: "2026-10-02T10:00:00.000Z"
    });
    // Resposta confirmada (formulário público da etapa) mais nova que o rascunho, com o anexo e Horas.
    confirmed.push({
      id_form_answer: 801, form_id: 901, flow_step_id: 1, origin: "/PublicForm/Step", dt_created: "2026-10-03T10:00:00.000Z",
      form_answer_fields: [stamped(36, "1166868", "2026-10-05T10:00:00.000Z"), stamped(30, "7", "2026-10-05T10:00:00.000Z")]
    });
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    // A tela só lê o rascunho: o anexo obrigatório está vazio nela e o kit cobra igual.
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Proposta");

    // Campo que o mover reenvia (Horas) segue a régua da linha mais nova: vai o 7 da confirmada.
    const list = normalizeFieldsFromApiResponse(fields);
    const carry = readStepCarryOver({
      cardRaw: cardRaw(),
      preAnswerRaw: { fields: [], formsAnswers: preAnswer },
      formId: "901",
      fields: list.filter((field) => String(field.formId) === "901"),
      stepEntry: Date.parse("2026-09-30T09:00:00.000Z")
    });
    expect(carry.values).toEqual({ h_horas: 7, h_resp: 76 });
    expect(carry.filled.has("h_anexo")).toBe(false);
  });

  it("F1: campo de várias linhas vale a linha mais nova entre elas", () => {
    const list = normalizeFieldsFromApiResponse([
      ...baseFields(),
      { id_field: 41, name: "h_tags", title: "Tags", type: "CHECK_BOX_FIELD", form_id: 901, required: "0", validations: [] }
    ]);
    const scope = list.filter((field) => String(field.formId) === "901");
    fields = [...baseFields(), { id_field: 41, name: "h_tags", type: "CHECK_BOX_FIELD", form_id: 901 }];
    const carry = readStepCarryOver({
      cardRaw: {
        ...cardRaw(),
        form_answers: [
          { id_form_answer: 801, form_id: 901, flow_step_id: 1, dt_created: "2026-10-03T10:00:00.000Z",
            form_answer_fields: [stamped(41, "a", "2026-10-03T10:00:00.000Z", 0), stamped(41, "b", "2026-10-03T10:00:00.000Z", 1)] }
        ]
      },
      preAnswerRaw: {
        fields: [],
        formsAnswers: draft([stamped(41, "x", "2026-10-02T10:00:00.000Z", 0), stamped(41, "y", "2026-10-05T10:00:00.000Z", 1)], {
          dt_created: "2026-10-02T10:00:00.000Z"
        })
      },
      formId: "901",
      fields: scope
    });
    // A 2ª linha do rascunho (05/10) é mais nova que as da confirmada (03/10): o rascunho inteiro vence.
    expect(carry.values.h_tags).toEqual(["x", "y"]);
  });

  it("anexo e botão no rascunho vão no mover como a tela manda (lista de ids e o JSON do clique)", async () => {
    fields = [
      ...baseFields(),
      { id_field: 37, name: "h_botao", title: "IA - Resumo", type: "BUTTON_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] }
    ];
    const click = '{"user_id":76,"name_user":"Ana","last_click":"2026-10-06T13:50:29.000Z"}';
    // Dois arquivos no rascunho (1 linha por anexo, fora de ordem no index) + o último clique do botão.
    preAnswer = draft([row(30, "1"), row(33, "76"), row(36, "9912", 1), row(36, "9911", 0), row(37, click)]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    // O back apaga o rascunho no mover: sem reenviar, o anexo que a pessoa subiu na etapa sumia.
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76, h_anexo: [9911, 9912], h_botao: click });
    expect(out).toMatchObject({ ok: true, kept: 4, keptFrom: "rascunho" });
    expect(out?.warning ?? "").not.toContain("Não reenviados");
  });

  it("fórmula no rascunho o kit não calcula: segue no aviso (Não reenviados) e --fail-on-data-loss bloqueia", async () => {
    fields = [
      ...baseFields(),
      { id_field: 38, name: "h_total", title: "Total", type: "FORMULA_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] }
    ];
    preAnswer = draft([row(30, "1"), row(33, "76"), row(36, "9911"), row(38, "42")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--dry-run"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.warning).toContain("Não reenviados (ficam vazios na etapa Triagem): Total.");
    expect(out?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_anexo: [9911] });

    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--dry-run", "--fail-on-data-loss"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("anexo da última passagem confirmada (GET /card, back sem a rota) segue fora: o back não reaproveita anexo entre passagens", () => {
    const list = normalizeFieldsFromApiResponse(fields).filter((field) => String(field.formId) === "901");
    const raw = { ...cardRaw(), form_answers: [{ id_form_answer: 701, form_id: 901, flow_step_id: 1, form_answer_fields: [row(30, "4"), row(36, "9911")] }] };
    const carry = readStepCarryOver({ cardRaw: raw, preAnswerRaw: undefined, formId: "901", fields: list });

    expect(carry.source).toBe("cartao");
    expect(carry.values).toEqual({ h_horas: 4 });
    expect(carry.notKept).toEqual([{ name: "h_anexo", title: "Proposta" }]);
  });
});

describe("EXTRA-06 D1: card update-values seguido de card move preserva o valor", () => {
  it("o PUT grava no rascunho (a resposta mais recente) e o mover seguinte reenvia o valor", async () => {
    preAnswer = draft([row(33, "76")]);
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=7"]);
    expect(process.exitCode ?? 0).toBe(0);
    // A hipótese do achado: o valor caiu no rascunho, que o GET /card não traz.
    expect(preAnswer.form_answer_fields.map((item: any) => [item.field_id, item.value])).toContainEqual([30, "7"]);
    expect(confirmed[1]!.form_answer_fields.some((item: any) => item.field_id === 30)).toBe(false);

    // Prova por dry-run: o mover resolvido leva o 7.
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(dry).toMatchObject({ dryRun: true, validation: { valid: true } });
    expect(dry?.calls[0]?.payload.values).toMatchObject({ h_horas: 7, h_resp: 76 });

    // E o mover de verdade grava com ele.
    delete process.env[FORCE_DRY_RUN_ENV];
    requests.length = 0;
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_horas: 7 });
  });

  it("rascunho mais antigo que a resposta confirmada: o PUT grava na confirmada e o mover leva o valor mesmo assim", async () => {
    preAnswer = draft([row(33, "76")], { dt_created: "2026-09-01T10:00:00.000Z" });
    await run(["card", "update-values", "--card-id", "55", "--flow-id", "316", "--set", "Horas=6"]);
    expect(confirmed[1]!.form_answer_fields.map((item: any) => [item.field_id, item.value])).toContainEqual([30, "6"]);

    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toMatchObject({ h_horas: 6, h_resp: 76 });
  });
});

describe("F2: autocompletar da tela (campo sem valor na pré-resposta)", () => {
  /** Prioridade como o campo 8616 do fluxo 192: obrigatório, lista de opções, autocompletar estático '2'. */
  function withPriority(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const field = {
      id_field: 42, name: "h_prio", title: "Prioridade", type: "COMBO_BOX_FIELD", form_id: 901, required: "1",
      validation_type: "string", validations: REQUIRED,
      options: [{ value: "1", label: "Baixa" }, { value: "2", label: "Média" }, { value: "3", label: "Alta" }],
      ac_type: 1, ac_parent_field_id: null, ac_child_field_id: null,
      auto_complete: { id_form_answer: 906690, form_answer_fields: [{ id_form_answer_field: 5779242, field_id: 42, index: 0, value: "2", deleted: null }] },
      ...extra
    };
    fields = [...baseFields(), field];
    return field;
  }

  it("estático, rascunho sem linhas (como o card 1120391): conta como preenchido e vai no mover", async () => {
    const prio = withPriority();
    preFields = [prio];
    preAnswer = draft([]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=1", "--set", "Responsável pelo Atendimento=76"
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry).toMatchObject({ validation: { valid: true }, autocompleted: ["Prioridade"] });
    expect(dry?.calls[0]?.payload.values).toMatchObject({ h_prio: "2", h_horas: 1, h_resp: 76 });
  });

  it("rota sem rascunho nenhum (formsAnswers null) também autocompleta; --set vence o autocompletar", async () => {
    const prio = withPriority();
    preFields = [prio];
    const out = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=1", "--set", "Responsável pelo Atendimento=76", "--set", "Prioridade=Alta"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values.h_prio).toBe("3");
    expect(out?.autocompleted).toBeUndefined();
  });

  it("campo com linha (mesmo vazia) na pré-resposta: a tela não autocompleta, o kit também não", async () => {
    const prio = withPriority();
    preFields = [prio];
    preAnswer = draft([row(30, "1"), row(33, "76"), row(42, "")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Prioridade");
  });

  it("dinâmico: valor de outro campo do cartão, data atual e criador do cartão", async () => {
    const extra = [
      { id_field: 43, name: "h_copia", title: "Cópia do título", type: "TEXT_SHORT_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20 },
      { id_field: 44, name: "h_quando", title: "Quando", type: "DATE_PICKER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: -1 },
      { id_field: 45, name: "h_dono", title: "Dono", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: -3 }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    const values = moveBody()?.values;
    expect(values).toMatchObject({ h_copia: "Pedido ACME", h_dono: 76, h_horas: 1, h_resp: 76 });
    expect(Number.isFinite(Date.parse(values?.h_quando))).toBe(true);
    // O by-cards (a origem no cartão) responde depois do que o kit calcula sozinho.
    expect(out?.autocompleted).toEqual(["Quando", "Dono", "Cópia do título"]);
    // A mesma chamada da tela ao abrir o cartão (POP-2), com a lista na ordem dos campos.
    expect(requests.find((request) => request.path === "/form/answers/by-cards")?.body).toEqual({
      card_id: 55,
      field_items: [{ flow_id: 316, field_id: 20 }]
    });
    // O autocompletar não entra no `kept` (é valor novo, não o que o cartão tinha).
    expect(out).toMatchObject({ kept: 2, keptFrom: "rascunho" });
  });

  it("dinâmico de data: a tela lê ISO e dd/MM/yyyy (hora local) e deixa vazio o que não é data (POP-2)", () => {
    fields = [
      ...baseFields(),
      { id_field: 46, name: "h_ref", title: "Referência", type: "TEXT_SHORT_FIELD", form_id: 901 },
      { id_field: 47, name: "h_prazo", title: "Prazo", type: "DUE_DATE_FIELD", form_id: 901, ac_type: 0, ac_parent_field_id: 46 }
    ];
    const scope = normalizeFieldsFromApiResponse(fields).filter((field) => String(field.formId) === "901");
    const carry = readStepCarryOver({
      cardRaw: cardRaw(),
      preAnswerRaw: { fields: [fields[fields.length - 1]], formsAnswers: draft([row(46, "08/10/2026")]) },
      formId: "901",
      fields: scope
    });
    // O valor vem do by-cards da tela; até a resposta o campo fica pendente.
    expect(carry.byCards).toEqual([{ name: "h_prazo", title: "Prazo", parentFieldId: 46 }]);
    expect(carry.autoPending).toEqual([{ name: "h_prazo", title: "Prazo", reason: "campo do cartão" }]);
    resolveByCards(
      carry,
      scope,
      [{ card_id: 55, flow_id: 316, field_id: 46, formAnswer: { form_answer_fields: [{ field_id: 46, index: 0, value: "08/10/2026", valueString: "08/10/2026" }] } }],
      { cardId: "55", flowId: 316 }
    );
    expect(carry.values.h_prazo).toBe(new Date(2026, 9, 8).toISOString());
    expect(carry.autoFilled).toEqual([{ name: "h_prazo", title: "Prazo", rule: "campo-do-cartao" }]);
    expect(carry.autoPending).toEqual([]);

    expect(sanitizeAutoCompleteDate("2026-10-08T15:30:00.000Z")).toBe("2026-10-08T15:30:00.000Z");
    expect(sanitizeAutoCompleteDate("2026-10-08 14:05")).toBe(new Date(2026, 9, 8, 14, 5).toISOString());
    expect(sanitizeAutoCompleteDate("01/03/26")).toBe(new Date(2026, 2, 1).toISOString());
    expect(sanitizeAutoCompleteDate("31/02/2026")).toBeUndefined();
    expect(sanitizeAutoCompleteDate("amanhã")).toBeUndefined();
  });

  it("POP-2: usuário atual e by-cards que falhou viram aviso, obrigatório ou não", async () => {
    const extra = [
      { id_field: 48, name: "h_atual", title: "Quem atende", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: -2 },
      { id_field: 49, name: "h_cliente", title: "Cidade do cliente", type: "TEXT_SHORT_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20, ac_child_field_id: 99 },
      { id_field: 50, name: "h_estoque", title: "Estoque atual", type: "NUMBER_FIELD", form_id: 901, required: "0", validations: [], ac_type: 0, ac_parent_field_id: 20, ac_child_field_id: 98 }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    byCards = "falha";
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76 });
    expect(out?.warning).toContain(
      "Campos com autocompletar que o kit não calcula na etapa Triagem (atual): " +
        "Quem atende (usuário atual), Cidade do cliente (campo de vínculo), Estoque atual (campo de vínculo)"
    );
    // A2-F1: o aviso não afirma que a tela preenche (com a origem sem valor útil ela cobra).
    expect(out?.warning).toContain("a tela tenta preencher");
    expect(out?.warning).not.toContain("—");

    // Só o usuário atual, não obrigatório: também no aviso (antes sumia do mover calado).
    fields = [...baseFields(), { ...extra[0]!, required: "0", validations: [] }];
    preFields = [fields[fields.length - 1]!];
    byCards = undefined;
    process.exitCode = undefined;
    const quiet = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(quiet?.warning).toContain("Quem atende (usuário atual)");
  });

  it("POP-2: vínculo com a origem preenchida e cópia de anexo (como o 433142 e o 1044110) vão no mover pelo by-cards da tela", async () => {
    const extra = [
      { id_field: 49, name: "h_cidade", title: "Cidade do cliente", type: "TEXT_SHORT_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 57, ac_child_field_id: 99 },
      { id_field: 50, name: "h_estoque", title: "Estoque atual", type: "NUMBER_FIELD", form_id: 901, required: "0", validations: [], ac_type: 0, ac_parent_field_id: 57, ac_child_field_id: 98 },
      { id_field: 51, name: "h_copias", title: "Anexos da proposta", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "0", validations: [], ac_type: 0, ac_parent_field_id: 58 }
    ];
    fields = [
      ...baseFields(),
      { id_field: 57, name: "h_produto", title: "Produto", type: "COMBO_BOX_REGISTER_FIELD", form_id: 900 },
      { id_field: 58, name: "h_docs", title: "Documentos", type: "INPUT_ATTACH_FIELD", form_id: 900 },
      ...extra
    ];
    confirmed[0]!.form_answer_fields.push(row(57, "4311039"), row(58, "1031274", 0), row(58, "1031275", 1));
    linked = {
      "4311039:99": [{ field_id: 99, index: 0, value: "Porto Alegre" }],
      "4311039:98": [{ field_id: 98, index: 0, value: "5" }]
    };
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry?.calls[0].payload.values).toEqual({
      h_horas: 1, h_resp: 76, h_cidade: "Porto Alegre", h_estoque: 5, h_copias: [1031274, 1031275]
    });
    expect(dry?.autocompleted).toEqual(["Cidade do cliente", "Estoque atual", "Anexos da proposta"]);
    expect(dry?.warning).toBeUndefined();
    // Liberado no dry-run forçado (é leitura), com a lista na ordem dos campos, como a tela.
    expect(requests.find((request) => request.path === "/form/answers/by-cards")?.body).toEqual({
      card_id: 55,
      field_items: [
        { flow_id: 316, field_id: 57, child_field_id: 99 },
        { flow_id: 316, field_id: 57, child_field_id: 98 },
        { flow_id: 316, field_id: 58 }
      ]
    });

    // O cadastro apontado sem o campo (como o 67034): a tela fica vazia e o obrigatório cobra.
    linked = { "4311039:98": [{ field_id: 98, index: 0, value: "5" }] };
    process.exitCode = undefined;
    const blocked = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(blocked?.validation.message).toContain("Falta para a etapa Triagem (atual): Cidade do cliente (texto)");
  });

  it("autocompletar pendente MANDADO vazio (como o anexo do card 1121209): é campo limpo e bloqueia, como a tela", async () => {
    // Anexo obrigatório com autocompletar estático: o kit não remonta anexo (fica pendente),
    // mas o agente mandou o campo vazio. Na tela o autocompletar só roda ao abrir o cartão:
    // quem limpa o campo fica com ele vazio e o obrigatório cobra.
    const extra = [
      {
        id_field: 51, name: "h_contrato", title: "Contrato", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "1",
        validation_type: "mixed", validations: REQUIRED, ac_type: 1, ac_parent_field_id: null,
        auto_complete: { id_form_answer: 9, form_answer_fields: [{ id_form_answer_field: 1, field_id: 51, index: 0, value: "1166868", deleted: null }] }
      }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    for (const sent of ["", []] as const) {
      process.exitCode = undefined;
      stderr.length = 0;
      requests.length = 0;
      await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--values-json", JSON.stringify({ Contrato: sent })]);
      expect(process.exitCode).toBe(EXIT_CODES.USAGE);
      expect(writes()).toEqual([]);
      expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Contrato");
    }

    // Sem mandar o campo: o anexo do autocompletar vai no mover, como a tela manda (POP-2).
    process.exitCode = undefined;
    stderr.length = 0;
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76, h_contrato: [1166868] });
    expect(out?.autocompleted).toEqual(["Contrato"]);
  });

  it("outro obrigatório bloqueia: a dica cita os pendentes de autocompletar sem cobrá-los", async () => {
    const extra = [
      { id_field: 48, name: "h_atual", title: "Quem atende", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: -2 }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(33, "76")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = errorMessage();
    expect(message).toContain("Falta para a etapa Triagem (atual): Horas");
    expect(message).not.toContain("Falta para a etapa Triagem (atual): Horas (número), Quem atende");
    expect(message).toContain("Também vazios, com autocompletar que o kit não calcula");
  });

  it("--payload que grava a etapa atual leva o autocompletar (e diz em autocompleted)", async () => {
    const prio = withPriority();
    preFields = [prio];
    preAnswer = draft([row(33, "76")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 3 } });
    const out = await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_prio: "2", h_horas: 3 });
    expect(out).toMatchObject({ kept: 1, keptFrom: "rascunho", autocompleted: ["Prioridade"] });
  });
});

describe("A2-F1: origem do autocompletar vazia bloqueia, e a opção pelo rótulo é calculada", () => {
  it("vínculo e opção com a origem sem valor no cartão (como o 233055): a tela não preenche e o obrigatório bloqueia", async () => {
    const extra = [
      // Origem que nem existe mais no fluxo (o 113998 do cartão 233055): nenhuma linha no cartão.
      { id_field: 55, name: "h_det", title: "Detalhe da demanda", type: "TEXT_LONG_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 999, ac_child_field_id: 998 },
      // Origem com linha VAZIA no cartão (o 115489 do 233055), com vínculo.
      { id_field: 56, name: "h_urg", title: "Urgência", type: "COMBO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 57, ac_child_field_id: 997, options: [{ value: "1", label: "Alta" }] },
      // Opção pelo rótulo sem vínculo, origem vazia.
      { id_field: 58, name: "h_tipo", title: "Tipo", type: "RADIO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 59, options: [{ value: "1", label: "Pedido ACME" }] }
    ];
    fields = [
      ...baseFields(),
      { id_field: 57, name: "h_entrada", title: "Entrada", type: "COMBO_BOX_FLOW_FIELD", form_id: 900 },
      { id_field: 59, name: "h_origem", title: "Origem", type: "TEXT_SHORT_FIELD", form_id: 900 },
      ...extra
    ];
    confirmed[0]!.form_answer_fields.push(row(57, ""));
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = String(dry?.validation.message);
    expect(message).toContain("Falta para a etapa Triagem (atual): Detalhe da demanda (texto), Urgência (Alta), Tipo (Pedido ACME)");
    expect(message).not.toContain("autocompletar que o kit não calcula");
    expect(dry?.warning).toBeUndefined();

    // Com os valores no --set, move (o que a tela pediria ao usuário).
    process.exitCode = undefined;
    const ok = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Detalhe da demanda=x", "--set", "Urgência=Alta", "--set", "Tipo=Pedido ACME"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.validation).toMatchObject({ valid: true });
  });

  it("opção pelo rótulo: o texto da origem casa com o rótulo, sem diferenciar maiúscula, e vai no mover", async () => {
    const canal = {
      id_field: 50, name: "h_canal", title: "Canal", type: "RADIO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string",
      validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20, options: [{ value: "1", label: "Telefone" }, { value: "2", label: "PEDIDO acme" }]
    };
    fields = [...baseFields(), canal];
    preFields = [canal];
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76, h_canal: "2" });
    expect(out?.autocompleted).toEqual(["Canal"]);
    expect(out?.warning).toBeUndefined();
  });

  it("opção pelo rótulo que não casa: a tela deixa o campo vazio e o obrigatório bloqueia", async () => {
    const canal = {
      id_field: 50, name: "h_canal", title: "Canal", type: "RADIO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string",
      validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20, options: [{ value: "1", label: "Telefone" }]
    };
    fields = [...baseFields(), canal];
    preFields = [canal];
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Canal (Telefone)");
  });

  it("opção pelo rótulo: o valueString da resposta do by-cards, sem maiúscula, e lista de várias opções", () => {
    fields = [
      ...baseFields(),
      { id_field: 70, name: "h_urg2", title: "Urgência", type: "COMBO_BOX_FIELD", form_id: 901, ac_type: 0, ac_parent_field_id: 64, options: [{ value: "9", label: "ALTA" }] },
      { id_field: 72, name: "h_tags2", title: "Tags 2", type: "CHECK_BOX_FIELD", form_id: 901, ac_type: 0, ac_parent_field_id: 66, options: [{ value: "a", label: "Azul" }, { value: "v", label: "Verde" }, { value: "r", label: "Roxo" }] },
      { id_field: 73, name: "h_nivel3", title: "Nível 3", type: "RADIO_BOX_FIELD", form_id: 901, ac_type: 0, ac_parent_field_id: 65, options: [{ value: "5", label: "baixa" }] }
    ];
    const scope = normalizeFieldsFromApiResponse(fields).filter((field) => String(field.formId) === "901");
    const carry = readStepCarryOver({
      cardRaw: cardRaw(),
      preAnswerRaw: { fields: fields.filter((field) => [70, 72, 73].includes(field.id_field as number)), formsAnswers: draft([row(30, "1")]) },
      formId: "901",
      fields: scope
    });
    resolveByCards(
      carry,
      scope,
      [
        { card_id: 55, flow_id: 316, field_id: 64, formAnswer: { form_answer_fields: [{ field_id: 64, index: 0, value: "3", valueString: "Alta" }] } },
        {
          card_id: 55, flow_id: 316, field_id: 66,
          formAnswer: { form_answer_fields: [{ field_id: 66, index: 0, value: "x", valueString: "azul" }, { field_id: 66, index: 1, value: "y", valueString: "VERDE" }] }
        },
        // Origem sem texto (null): a tela não acha rótulo; o campo fica vazio.
        { card_id: 55, flow_id: 316, field_id: 65, formAnswer: { form_answer_fields: [{ field_id: 65, index: 0, value: "1", valueString: null }] } }
      ],
      { cardId: 55, flowId: "316" }
    );
    expect(carry.values).toEqual({ h_horas: 1, h_urg2: "9", h_tags2: ["a", "v"] });
    expect(carry.autoFilled.map((item) => item.rule)).toEqual(["opcao-pelo-rotulo", "opcao-pelo-rotulo"]);
    expect(carry.autoPending).toEqual([]);
  });
});

describe("A2-F2: o mover apaga o rascunho do formulário que grava (o do destino também)", () => {
  /** Formulário do destino (Agendamento, 902) com anexo, texto e fórmula. */
  function withDestinationForm(): void {
    fields = [
      ...baseFields(),
      { id_field: 52, name: "h_comprov", title: "Comprovante", type: "INPUT_ATTACH_FIELD", form_id: 902 },
      { id_field: 53, name: "h_nota", title: "Nota", type: "TEXT_SHORT_FIELD", form_id: 902 },
      { id_field: 54, name: "h_tot_dest", title: "Total do destino", type: "FORMULA_FIELD", form_id: 902 }
    ];
  }

  /** Rascunho do 902, como o da automação no cartão 494824 (anexos) ou o da tela no 1115530. */
  function destinationDraft(): Record<string, any> {
    return draft([row(40, "2026-10-01T00:00:00.000Z"), row(52, "9911"), row(53, "rascunho"), row(54, "42")], { form_id: 902, id_form_answer: 801 });
  }

  it("payload com o idForm do destino (V1, como o 494824): reenvia o rascunho do destino com o values por cima", async () => {
    withDestinationForm();
    flow = { ...flow, use_query_v2: "N" };
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    otherDrafts[902] = destinationDraft();
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_nota: "do payload" } });

    const dry = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(dry?.payload).toMatchObject({ idForm: 902, values: { h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "do payload" } });
    expect(dry).toMatchObject({ kept: 2, keptFrom: "rascunho" });
    // A régua do detector é a mesma fonte: só a fórmula (que o kit não remonta) fica de fora.
    expect(dry?.dataLossCheck).toMatchObject({ checked: true, orphans: [{ fieldName: "h_tot_dest", currentValue: "42" }] });
    expect(dry?.warning).toContain("Não reenviados (ficam vazios na etapa Agendamento): Total do destino");

    await run(["card", "move-step-with-values", "--payload", file]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()).toMatchObject({ id_form: 902 });
    expect(moveBody()?.values).toEqual({ h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "do payload" });
  });

  it("idForm omitido (cai no destino) num fluxo V2 (como o 1115530): o dry-run mostra o id_form e reenvia o rascunho dele", async () => {
    withDestinationForm();
    flow = { ...flow, use_query_v2: "S" };
    // Etapa atual sem rascunho: a última passagem (o back remonta), que o V2 não apaga.
    preAnswer = { origin: "return-step-autocomplete", form_id: 901, flow_step_id: null, form_answer_fields: [row(30, "1"), row(33, "76")] };
    otherDrafts[902] = destinationDraft();
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, values: {} });

    const dry = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(dry?.payload).toMatchObject({ idForm: 902, values: { h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "rascunho" } });
    expect(dry?.dataLossCheck.checked).toBe(true);
    expect(dry?.dataLossCheck.note).not.toContain("—");

    // O alias deprecado faz igual.
    const alias = await run(["card", "move-step", "--payload", file, "--dry-run"]);
    expect(alias?.payload).toMatchObject({ idForm: 902, values: { h_comprov: [9911], h_nota: "rascunho" } });
  });

  it("R3-F3: --allow-data-loss não apaga o rascunho do formulário gravado (a flag é sobre a etapa atual)", async () => {
    withDestinationForm();
    flow = { ...flow, use_query_v2: "N" };
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    otherDrafts[902] = destinationDraft();
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_nota: "do payload" } });

    const dry = await run(["card", "move-step-with-values", "--payload", file, "--allow-data-loss", "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(dry?.payload.values).toEqual({ h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "do payload" });
    // A checagem do formulário gravado segue ligada: só a fórmula fica de fora.
    expect(dry?.dataLossCheck).toMatchObject({ checked: true, orphans: [{ fieldName: "h_tot_dest" }] });

    await run(["card", "move-step-with-values", "--payload", file, "--allow-data-loss"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "do payload" });
  });

  it("R3-F3: rascunho só na etapa atual (V2) com --allow-data-loss: move, avisa o que some da etapa atual e mantém o do destino", async () => {
    withDestinationForm();
    flow = { ...flow, use_query_v2: "S" };
    preAnswer = draft([row(30, "2"), row(33, "76"), row(31, "rascunho")]);
    otherDrafts[902] = destinationDraft();
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: {} });

    const blocked = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(blocked?.validation.message).toContain(
      "aceita perder esses campos da etapa Triagem; o rascunho do form 902 segue reenviado"
    );

    process.exitCode = undefined;
    stderr.length = 0;
    const out = await run(["card", "move-step-with-values", "--payload", file, "--allow-data-loss", "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.payload.values).toEqual({ h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "rascunho" });
    expect(out?.warning).toContain(
      "Com --allow-data-loss, o rascunho da etapa Triagem some ao sair da etapa: Horas, Responsável pelo Atendimento, Observação."
    );
    expect(out?.dataLossCheck.checked).toBe(true);
  });

  it("card move de etapa sem formulário: o mover grava o form do destino com o rascunho dele e o --set por cima", async () => {
    withDestinationForm();
    flow = {
      ...flow,
      flow_steps: [
        { id_step: 1, name: "Triagem", form_id: null, index: 1 },
        { id_step: 2, name: "Agendamento", form_id: 902, index: 2 }
      ]
    };
    otherDrafts[902] = destinationDraft();
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Nota=novo"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((request) => request.path)).toEqual(["/card/v2/move-step"]);
    expect(moveBody()).toMatchObject({ id_form: 902 });
    expect(moveBody()?.values).toEqual({ h_data: "2026-10-01T00:00:00.000Z", h_comprov: [9911], h_nota: "novo" });
    expect(out).toMatchObject({ kept: 2, keptFrom: "rascunho" });
    expect(out?.warning).toContain("Não reenviados (ficam vazios na etapa Agendamento): Total do destino");
  });
});

describe("EXTRA-06 D1: mover por --payload", () => {
  it("payload que grava a etapa atual: reenvia o rascunho com o values por cima e conta o rascunho", async () => {
    preAnswer = draft([row(33, "76"), row(31, "rascunho")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 3, h_obs: "do payload" } });
    const out = await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_obs: "do payload", h_horas: 3 });
    expect(out).toMatchObject({ kept: 1, keptFrom: "rascunho" });
  });

  it("--dry-run do payload mostra o values já com o rascunho (anexo incluído) e o dataLossCheck pela mesma fonte", async () => {
    fields = [
      ...baseFields(),
      { id_field: 38, name: "h_total", title: "Total", type: "FORMULA_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] }
    ];
    preAnswer = draft([row(33, "76"), row(36, "9911"), row(38, "42")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 3 } });
    const out = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out?.payload.values).toEqual({ h_resp: 76, h_anexo: [9911], h_horas: 3 });
    // Só a fórmula (que o kit não calcula) fica de fora.
    expect(out?.dataLossCheck.orphans).toEqual([{ fieldName: "h_total", fieldTitle: "Total", currentValue: "42" }]);
    expect(out?.warning).toContain("Não reenviados");
  });

  it("payload que grava o formulário do destino com rascunho só na etapa atual: bloqueia (o back apaga o rascunho)", async () => {
    preAnswer = draft([row(30, "2"), row(33, "76"), row(31, "rascunho")]);
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_data: "2026-10-06T00:00:00.000Z" }
    });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("o rascunho da etapa Triagem tem Horas, Responsável pelo Atendimento, Observação");
    expect(message).toContain("cange card move --card-id 55 --to 2");
    expect(message).not.toContain("—");

    process.exitCode = undefined;
    stderr.length = 0;
    await run(["card", "move-step-with-values", "--payload", file, "--allow-data-loss"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fluxo sem o Flow Query V2 (use_query_v2 = 'N'): o back não apaga o rascunho ao sair da etapa, então o payload de outro formulário não bloqueia", async () => {
    preAnswer = draft([row(30, "2"), row(33, "76"), row(31, "rascunho")]);
    const body = { flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_data: "2026-10-06T00:00:00.000Z" } };

    flow = { ...flow, use_query_v2: "N" };
    await run(["card", "move-step-with-values", "--payload", await payloadFile(body), "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);

    flow = { ...flow, use_query_v2: "S" };
    await run(["card", "move-step-with-values", "--payload", await payloadFile(body), "--dry-run"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("F3: card move-step (deprecado) aceita o --allow-data-loss que a mensagem de bloqueio sugere", async () => {
    preAnswer = draft([row(30, "2"), row(33, "76")]);
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_data: "2026-10-06T00:00:00.000Z" }
    });
    await run(["card", "move-step", "--payload", file, "--dry-run"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);

    process.exitCode = undefined;
    stderr.length = 0;
    const out = await run(["card", "move-step", "--payload", file, "--dry-run", "--allow-data-loss"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr.join("")).not.toContain("unknown option");
    expect(out?.validation).toMatchObject({ valid: true });
    expect(writes()).toEqual([]);
  });

  it("card move-step (deprecado) também reenvia o rascunho", async () => {
    preAnswer = draft([row(33, "76")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 1 } });
    await run(["card", "move-step", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_horas: 1 });
  });
});

// ---------------------------------------------------------------------------
// D2/D3: obrigatório = o que a tela cobra
// ---------------------------------------------------------------------------

describe("EXTRA-06 D2/D3: só cobra o que a tela cobra", () => {
  it("switch com required=1 e sem regra (como os 92 do banco) e check list sem regra não bloqueiam", async () => {
    fields = [
      ...baseFields(),
      { id_field: 34, name: "h_ativo", title: "Ativo", type: "SWITCH_FIELD", form_id: 901, required: "1", validation_type: "boolean", validations: [] },
      { id_field: 35, name: "h_lista", title: "Itens", type: "CHECK_LIST_FIELD", form_id: 901, required: "1", validation_type: "array", validations: [] }
    ];
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=1", "--set", "Responsável pelo Atendimento=76"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((request) => request.path)).toEqual(["/card/v2/move-step"]);
  });

  it("regra 'required' com a coluna required=0 (RADIO/usuário no banco): a tela cobra, o kit também", async () => {
    fields = [
      ...baseFields(),
      {
        id_field: 37, name: "h_canal", title: "Canal", type: "RADIO_BOX_FIELD", form_id: 901, required: "0", validation_type: "string", validations: REQUIRED,
        options: [{ value: "1", label: "Telefone" }, { value: "2", label: "E-mail" }]
      }
    ];
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=1", "--set", "Responsável pelo Atendimento=76"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Canal (Telefone | E-mail)");
  });

  it("regra pela lista de validações; sem a lista vale a coluna; validation_type fora do yup não cobra", () => {
    const [withRule, noRule, legacy, noYupType, hidden] = normalizeFieldsFromApiResponse([
      { id_field: 1, name: "a", type: "TEXT_SHORT_FIELD", required: "0", validation_type: "string", validations: REQUIRED },
      { id_field: 2, name: "b", type: "SWITCH_FIELD", required: "1", validation_type: "boolean", validations: [] },
      { id_field: 3, name: "c", type: "TEXT_SHORT_FIELD", required: "1" },
      { id_field: 4, name: "d", type: "TEXT_SHORT_FIELD", required: "1", validation_type: null, validations: REQUIRED },
      { id_field: 5, name: "e", type: "TEXT_SHORT_FIELD", required: "1", validation_type: "string", validations: REQUIRED, show_on_form: "S" }
    ]);
    expect(hasRequiredRule(withRule!)).toBe(true);
    expect(hasRequiredRule(noRule!)).toBe(false);
    expect(hasRequiredRule(legacy!)).toBe(true);
    expect(hasRequiredRule(noYupType!)).toBe(false);
    // Documento e telefone sem tipo: o createYupSchema usa "string" (cobra).
    const [doc] = normalizeFieldsFromApiResponse([
      { id_field: 7, name: "g", type: "DOC_FIELD", required: "1", validation_type: null, validations: REQUIRED }
    ]);
    expect(hasRequiredRule(doc!)).toBe(true);
    expect(isRequiredOnScreen(hidden!)).toBe(false);
    // Switch desligado é valor (o yup aceita false).
    expect(isEmptyForField(noRule!, false)).toBe(false);
  });

  it("validateValuesAgainstFields (card move-step --validate-fields) usa a mesma régua", () => {
    const list = normalizeFieldsFromApiResponse([
      { id_field: 2, name: "b", type: "SWITCH_FIELD", form_id: 9, required: "1", validation_type: "boolean", validations: [] },
      { id_field: 6, name: "r", type: "INPUT_RICH_TEXT_FIELD", form_id: 9, required: "1", validation_type: "string", validations: REQUIRED }
    ]);
    const result = validateValuesAgainstFields({ values: { r: "<p></p>" }, fields: list, requireRequiredFields: true, targetFormId: 9 });
    expect(result.issues.filter((issue) => issue.code === "MISSING_REQUIRED").map((issue) => issue.fieldName)).toEqual(["r"]);
  });
});

// ---------------------------------------------------------------------------
// D4: rich text vazio
// ---------------------------------------------------------------------------

describe("EXTRA-06 D4: rich text sem conteúdo é vazio", () => {
  function withRichRequired(): void {
    fields = [
      ...baseFields(),
      { id_field: 38, name: "h_resumo", title: "Resumo", type: "INPUT_RICH_TEXT_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED }
    ];
  }

  it("'<p></p>' mandado no --values-json não preenche o obrigatório (como no card 837476)", async () => {
    withRichRequired();
    await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--values-json", JSON.stringify({ Horas: 1, "Responsável pelo Atendimento": 76, Resumo: "<p></p>" })
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Resumo");
  });

  it("'<p><br></p>' gravado no rascunho também é vazio; com texto passa", async () => {
    withRichRequired();
    preAnswer = draft([row(30, "1"), row(33, "76"), row(38, "<p><br></p>")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Resumo");

    process.exitCode = undefined;
    preAnswer = draft([row(30, "1"), row(33, "76"), row(38, "<p>ok</p>")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("isEmptyRichText: a régua da tela (isHtmlEmpty do InputRichText), HTML sem texto = vazio", () => {
    expect(isEmptyRichText("<p></p>")).toBe(true);
    expect(isEmptyRichText(" <p> </p> ")).toBe(true);
    expect(isEmptyRichText("<p><br></p>")).toBe(true);
    expect(isEmptyRichText("<p>&nbsp;</p>")).toBe(true);
    expect(isEmptyRichText("<p></p><p></p>")).toBe(true);
    // A tela tira toda tag: imagem ou tabela sem texto viram "" no formulário (o obrigatório recusa).
    expect(isEmptyRichText("<p><img src=\"x.png\"></p>")).toBe(true);
    expect(isEmptyRichText("<table><tr><td></td></tr></table>")).toBe(true);
    expect(isEmptyRichText("<table><tr><td>a</td></tr></table>")).toBe(false);
    // Só `&nbsp;` vira espaço na tela; a entidade numérica conta como texto.
    expect(isEmptyRichText("<p>&#160;</p>")).toBe(false);
    expect(isEmptyRichText("<p>a</p>")).toBe(false);
    // Texto comum com "<p></p>" literal não é rich text: segue preenchido.
    expect(isEmptyForField({ type: "TEXT_SHORT_FIELD" }, "<p></p>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D5: check list "exigir todos concluídos"
// ---------------------------------------------------------------------------

describe("EXTRA-06 D5: check list com formula '1' exige todos os itens marcados", () => {
  const item = (description: string, checked: "S" | "N", index: number) =>
    JSON.stringify({ id_check_list_item: 0, hash: `h${index}`, description, index, checked });

  function withChecklist(formula: string | null): void {
    fields = [
      ...baseFields(),
      { id_field: 39, name: "h_tarefas", title: "Tarefas", type: "CHECK_LIST_FIELD", form_id: 901, required: "0", validation_type: "array", validations: [], formula }
    ];
  }

  it("item sem marcar no rascunho: bloqueia com o motivo da tela", async () => {
    withChecklist("1");
    preAnswer = draft([row(30, "1"), row(33, "76"), row(39, item("Ligar", "S", 1), 1), row(39, item("Enviar proposta", "N", 2), 2)]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("no campo Tarefas (1 de 2 sem marcar) existem itens a concluir na lista");
    expect(message).not.toContain("—");
  });

  it("todos marcados: move e reenvia a lista do jeito que o back grava (index + item)", async () => {
    withChecklist("1");
    preAnswer = draft([row(30, "1"), row(33, "76"), row(39, item("Ligar", "S", 1), 1), row(39, item("Enviar proposta", "S", 2), 2)]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values.h_tarefas).toEqual([
      { value: "1", label: item("Ligar", "S", 1) },
      { value: "2", label: item("Enviar proposta", "S", 2) }
    ]);
  });

  it("sem formula '1' não cobra; lista mandada no mover com tudo marcado vence o rascunho", async () => {
    withChecklist(null);
    preAnswer = draft([row(30, "1"), row(33, "76"), row(39, item("Ligar", "N", 1), 1)]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);

    withChecklist("1");
    requests.length = 0;
    await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--values-json", JSON.stringify({ h_tarefas: [{ value: "1", label: item("Ligar", "S", 1), checked: "S" }] })
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("checkListProgress lê os três formatos e ignora o ilegível", () => {
    expect(checkListProgress([item("a", "S", 1), item("b", "N", 2)])).toEqual({ total: 2, pending: 1 });
    expect(checkListProgress([{ value: "1", label: item("a", "S", 1) }, { value: "2", label: item("b", "S", 2), checked: "S" }])).toEqual({ total: 2, pending: 0 });
    expect(checkListProgress([{ description: "sem checked" }, "texto solto"])).toEqual({ total: 1, pending: 1 });
    expect(checkListProgress([])).toBeUndefined();
  });
});

describe("readStepCarryOver: escolhe a fonte como a tela", () => {
  it("rascunho com campo gravado vence; rota sem nada abre vazio (não cai no GET /card)", () => {
    const list = normalizeFieldsFromApiResponse(baseFields());
    const scope = list.filter((field) => String(field.formId) === "901");
    const withDraft = readStepCarryOver({
      cardRaw: cardRaw(),
      preAnswerRaw: { fields: [], formsAnswers: draft([row(30, "3")]) },
      formId: "901",
      fields: scope
    });
    expect(withDraft.source).toBe("rascunho");
    expect(withDraft.values).toEqual({ h_horas: 3 });

    const emptyDraft = readStepCarryOver({
      cardRaw: cardRaw(),
      preAnswerRaw: { fields: [], formsAnswers: draft([]) },
      formId: "901",
      fields: scope
    });
    // A rota devolveu o rascunho sem linha (e nenhuma última passagem elegível): a tela abre o
    // formulário vazio, então o "antigo" da resposta confirmada não conta.
    expect(emptyDraft.source).toBe("vazio");
    expect(emptyDraft.values).toEqual({});
    expect(emptyDraft.filled.size).toBe(0);

    const noAnswer = readStepCarryOver({ cardRaw: cardRaw(), preAnswerRaw: { fields: [] }, formId: "901", fields: scope });
    expect(noAnswer.source).toBe("vazio");
    expect(noAnswer.values).toEqual({});

    // Só sem a rota (back antigo) vale o GET /card.
    const noRoute = readStepCarryOver({ cardRaw: cardRaw(), preAnswerRaw: undefined, formId: "901", fields: scope });
    expect(noRoute.source).toBe("cartao");
    expect(noRoute.values).toEqual({ h_obs: "antigo" });
  });
});

// ---------------------------------------------------------------------------
// Revisão 3 do EXTRA-06 (07/10)
// ---------------------------------------------------------------------------

describe("R3-F1: só a confirmada escrita nesta passagem disputa com o rascunho", () => {
  /** Como o 799470: "Você aprova a arte abaixo?" (opção obrigatória) e o ajuste (texto obrigatório). */
  function withApproval(): void {
    fields = [
      ...baseFields(),
      {
        id_field: 60, name: "h_aprova", title: "Você aprova a arte abaixo?", type: "RADIO_BOX_FIELD", form_id: 901, required: "1",
        validation_type: "string", validations: REQUIRED, options: [{ value: "1", label: "SIM" }, { value: "2", label: "NÃO" }]
      },
      { id_field: 61, name: "h_ajuste", title: "Ajuste", type: "TEXT_LONG_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED }
    ];
    // Só a resposta da passagem anterior conta como confirmada do 901.
    confirmed = [confirmed[0]!];
    // Rascunho criado na 1ª passagem (05/03), editado depois que o cartão voltou; a aprovação marcada
    // e limpa em 16/03 (a linha apagada não vem na pré-resposta).
    preAnswer = draft([stamped(30, "1", "2026-03-30T19:24:42.000Z"), stamped(33, "76", "2026-03-30T19:24:42.000Z")], {
      dt_created: "2026-03-05T15:04:00.000Z"
    });
    // O formulário público respondeu NÃO e tirou o cartão da etapa (06/03 12:55:47).
    confirmed.push({
      id_form_answer: 3665195, form_id: 901, flow_step_id: 1, origin: "/PublicForm/Step", dt_created: "2026-03-06T12:55:47.000Z",
      form_answer_fields: [stamped(60, "2", "2026-03-06T12:55:47.000Z"), stamped(61, "<p>ajuste antigo</p>", "2026-03-06T12:55:47.000Z")]
    });
  }

  const PASSAGES = [
    { id_card_movement: 1, card_id: 55, flow_step_id: 1, dt_entry: "2026-03-05T15:03:56.000Z", dt_exit: "2026-03-06T12:55:47.000Z" },
    { id_card_movement: 2, card_id: 55, flow_step_id: 2, dt_entry: "2026-03-06T12:55:47.000Z", dt_exit: "2026-03-06T14:34:51.000Z" },
    { id_card_movement: 3, card_id: 55, flow_step_id: 1, dt_entry: "2026-03-06T14:34:51.000Z", dt_exit: null }
  ];

  it("resposta da passagem anterior (o formulário público que tirou o cartão da etapa, como o 799470) fica fora e o obrigatório cobra", async () => {
    withApproval();
    movements = PASSAGES;
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(dry?.validation.message).toContain(
      "Falta para a etapa Triagem (atual): Você aprova a arte abaixo? (SIM | NÃO), Ajuste (texto)"
    );
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });
    const read = requests.find((request) => request.path === "/card/moviment");
    expect(read?.query.get("card_id")).toBe("55");
    expect(read?.query.get("flow_id")).toBe("316");

    // Pelo --payload que grava a etapa atual, igual.
    process.exitCode = undefined;
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: {} });
    const viaPayload = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(viaPayload?.payload.values).toEqual({ h_horas: 1, h_resp: 76 });
  });

  it("a mesma resposta escrita DEPOIS da entrada na etapa (card update-values nesta passagem) segue valendo", async () => {
    withApproval();
    // O cartão nunca saiu da etapa: a resposta mais nova que o rascunho é desta passagem.
    movements = [PASSAGES[0]!];
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_aprova: "2", h_ajuste: "<p>ajuste antigo</p>" });
  });

  it("sem a entrada na etapa (rota 404): nenhuma confirmada disputa, a tela só lê o rascunho", async () => {
    withApproval();
    movements = undefined;
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });
  });

  it("sem confirmada mais nova que o rascunho, o kit nem lê os movimentos", async () => {
    preAnswer = draft([row(30, "1"), row(33, "76")], { dt_created: "2026-10-05T10:00:00.000Z" });
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(requests.some((request) => request.path === "/card/moviment")).toBe(false);
  });
});

describe("R3-F2: linha repetida e obrigatório que o kit não reenvia", () => {
  const item = (description: string, checked: "S" | "N", index: number) =>
    JSON.stringify({ id_check_list_item: 0, hash: `h${index}`, description, index, checked });

  it("linha repetida no rascunho (mesmo campo e index, corrida do autosave): a primeira vale, vai no mover e conta no obrigatório", async () => {
    fields = [
      ...baseFields(),
      {
        id_field: 62, name: "h_tam", title: "Tamanho da empresa", type: "RADIO_BOX_FIELD", form_id: 901, required: "1",
        validation_type: "string", validations: REQUIRED, options: [{ value: "1", label: "Pequena" }, { value: "2", label: "Média" }]
      },
      { id_field: 63, name: "h_valor", title: "Valor final", type: "CURRENCY_FIELD", form_id: 901, required: "1", validation_type: "number", validations: REQUIRED },
      { id_field: 64, name: "h_prot", title: "Protocolo", type: "DATE_PICKER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED },
      { id_field: 65, name: "h_lead", title: "Lead", type: "COMBO_BOX_REGISTER_FIELD", form_id: 901, required: "0", validations: [] },
      { id_field: 66, name: "h_lista", title: "Lista", type: "CHECK_LIST_FIELD", form_id: 901, required: "0", validations: [] }
    ];
    preAnswer = draft([
      row(30, "1"), row(33, "76"),
      row(62, "2"), row(62, "2"),
      row(63, "1500.5"), row(63, "1500.5"),
      // Duas linhas diferentes no mesmo index: fica a primeira, como a tela.
      row(64, "2026-10-01T00:00:00.000Z"), row(64, "2026-10-02T00:00:00.000Z"),
      row(65, "92197"), row(65, "92197"),
      row(66, item("Ligar", "S", 1), 1), row(66, item("Ligar", "S", 1), 1)
    ]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({
      h_horas: 1, h_resp: 76, h_tam: "2", h_valor: 1500.5, h_prot: "2026-10-01T00:00:00.000Z", h_lead: [92197],
      h_lista: [{ value: "1", label: item("Ligar", "S", 1) }]
    });
    expect(out?.kept).toBe(7);
    expect(out?.warning ?? "").not.toContain("Não reenviados");
  });

  it("obrigatório preenchido que o kit não consegue reenviar bloqueia com o motivo, no card move e no --payload", async () => {
    // Horas com texto que não é número: o kit não remonta e o mover deixaria o obrigatório vazio.
    preAnswer = draft([row(30, "doze"), row(33, "76")]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    let message = errorMessage();
    expect(message).toContain("Horas está preenchido no cartão, mas o kit não consegue reenviar o valor gravado");
    expect(message).not.toContain("Falta para a etapa Triagem (atual): Horas");
    expect(message).toContain('--set "Horas=<número>"');
    expect(message).not.toContain("—");

    process.exitCode = undefined;
    stderr.length = 0;
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: {} });
    await run(["card", "move-step-with-values", "--payload", file]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    message = errorMessage();
    expect(message).toContain("Horas está preenchido no cartão, mas o kit não consegue reenviar o valor gravado");

    // Com o valor no mover, move.
    process.exitCode = undefined;
    stderr.length = 0;
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Horas=12"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_horas: 12 });
  });
});

describe("R3-F4: vínculo com a origem escolhida no mover, como o blur da tela", () => {
  function withContract(): void {
    const extra = [
      { id_field: 70, name: "h_contrato", title: "Contrato Cliente", type: "COMBO_BOX_REGISTER_FIELD", form_id: 901, required: "0", validations: [] },
      {
        id_field: 71, name: "h_centro", title: "Centro de custo", type: "COMBO_BOX_REGISTER_FIELD", form_id: 901, required: "1",
        validation_type: "array", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 70, ac_child_field_id: 275851
      }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
  }

  /** O que o back devolve (SelectFormAnswersByRegisterService): a linha do campo filho no cadastro escolhido. */
  function registerAnswer(rows: Array<Record<string, unknown>> | undefined): (body: Record<string, any>) => unknown {
    return (body) =>
      (body.field_items as Array<Record<string, unknown>>).map((item) => ({
        flow_id: item.flow_id,
        field_id: item.field_id,
        child_field_id: item.child_field_id,
        ...(rows ? { formAnswer: { id_form_answer: 4311039, form_answer_fields: rows } } : {})
      }));
  }

  it("origem vazia no cartão e escolhida no --set (como o 963893): o kit pede o vínculo e leva o valor", async () => {
    withContract();
    byRegister = registerAnswer([{ field_id: 275851, index: 0, value: "2983843", valueString: "Alessandra Dutra" }]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Contrato Cliente=4311039"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry).toMatchObject({ validation: { valid: true }, autocompleted: ["Centro de custo"] });
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_centro: [2983843], h_contrato: [4311039] });
    // A mesma chamada da tela (liberada no dry-run forçado: é leitura).
    const call = requests.find((request) => request.path === "/form/answers/by-register");
    expect(call?.body).toEqual({ field_items: [{ flow_id: 316, field_id: 70, child_field_id: 275851, currValue: [4311039] }] });
    expect(dry?.warning ?? "").not.toContain("Centro de custo");
  });

  it("o cadastro escolhido sem o campo: a tela deixa vazio e o obrigatório cobra", async () => {
    withContract();
    byRegister = registerAnswer(undefined);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Contrato Cliente=4311039"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Centro de custo");
  });

  it("consulta do vínculo falhou: aviso (o kit não calcula), sem bloquear", async () => {
    withContract();
    byRegister = undefined;
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Contrato Cliente=4311039"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.warning).toContain("Centro de custo (campo de vínculo)");
  });

  it("origem vazia e fora do mover: segue a A2-F1 (a tela não preenche) e o kit nem consulta", async () => {
    withContract();
    byRegister = registerAnswer([{ field_id: 275851, index: 0, value: "2983843" }]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Centro de custo");
    expect(requests.some((request) => request.path === "/form/answers/by-register")).toBe(false);
  });

  it("--payload que grava a etapa atual com a origem no values: igual", async () => {
    withContract();
    byRegister = registerAnswer([{ field_id: 275851, index: 0, value: "2983843" }]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_contrato: [4311039] } });
    const out = await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76, h_centro: [2983843], h_contrato: [4311039] });
    expect(out?.autocompleted).toEqual(["Centro de custo"]);
  });
});

describe("R3-F5: check list 'exigir todos concluídos' bloqueia oculto e com condicional, como o FormBuilder", () => {
  const item = (description: string, checked: "S" | "N", index: number) =>
    JSON.stringify({ id_check_list_item: 0, hash: `h${index}`, description, index, checked });

  it("oculto (show_on_form S) com item sem marcar bloqueia; item sem descrição a tela descarta", async () => {
    fields = [
      ...baseFields(),
      { id_field: 67, name: "h_faltando", title: "Produtos faltando", type: "CHECK_LIST_FIELD", form_id: 901, required: "0", validations: [], formula: "1", show_on_form: "S" }
    ];
    preAnswer = draft([row(30, "1"), row(33, "76"), row(67, item("Arroz", "N", 1), 1), row(67, item("", "N", 2), 2)]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("no campo Produtos faltando (1 de 1 sem marcar) existem itens a concluir na lista");
  });

  it("com condicional (como o 606564): bloqueia, não é mais aviso", async () => {
    fields = [
      ...baseFields(),
      { id_field: 68, name: "h_cadastral", title: "Checklist Cadastral", type: "CHECK_LIST_FIELD", form_id: 901, required: "0", validations: [], formula: "1" }
    ];
    flow = {
      ...flow,
      flow_steps: STEPS.map((step) =>
        step.id_step === 1
          ? { ...step, form: { id_form: 901, fields: [{ id_field: 68, name: "h_cadastral", conditionals: [{ id_conditional: 9, type: "field", action: "1" }] }] } }
          : step
      )
    };
    preAnswer = draft([row(30, "1"), row(33, "76"), row(68, item("RG", "N", 1), 1), row(68, item("CPF", "N", 2), 2), row(68, item("Comprovante", "N", 3), 3)]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(dry?.validation.message).toContain("no campo Checklist Cadastral (3 de 3 sem marcar) existem itens a concluir na lista");
    expect(dry?.warning ?? "").not.toContain("Check list com itens a concluir e condicional");
  });

  it("checkListProgress descarta o item sem descrição nos três formatos", () => {
    expect(checkListProgress([item("a", "S", 1), item("", "N", 2)])).toEqual({ total: 1, pending: 0 });
    expect(checkListProgress([{ value: "1", label: JSON.stringify({ checked: "N" }) }])).toBeUndefined();
    expect(checkListProgress([{ description: "", checked: "N" }, { description: "b", checked: "N" }])).toEqual({ total: 1, pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// Revisão 4 do EXTRA-06 (07/10)
// ---------------------------------------------------------------------------

describe("R4-F1: a resposta do movimento que começou a passagem fica fora (corte estrito)", () => {
  function withApproval(): void {
    fields = [
      ...baseFields(),
      {
        id_field: 60, name: "h_aprova", title: "Você aprova a arte abaixo?", type: "RADIO_BOX_FIELD", form_id: 901, required: "1",
        validation_type: "string", validations: REQUIRED, options: [{ value: "1", label: "SIM" }, { value: "2", label: "NÃO" }]
      },
      { id_field: 53, name: "h_nota", title: "Nota", type: "TEXT_SHORT_FIELD", form_id: 902 }
    ];
    confirmed = [confirmed[0]!];
  }

  it("etapa atual: confirmada gravada no MESMO segundo da entrada (o formulário público que trouxe o cartão) não disputa com o rascunho", async () => {
    withApproval();
    preAnswer = draft([stamped(30, "1", "2026-07-08T17:18:24.000Z"), stamped(33, "76", "2026-07-08T17:18:24.000Z")], {
      dt_created: "2026-07-08T17:18:24.000Z"
    });
    confirmed.push({
      id_form_answer: 5166799, form_id: 901, flow_step_id: 2, origin: "/PublicForm/Step", dt_created: "2026-07-08T20:19:34.000Z",
      form_answer_fields: [stamped(60, "1", "2026-07-08T20:19:34.000Z")]
    });
    movements = [
      { id_card_movement: 1, card_id: 55, flow_step_id: 2, dt_entry: "2026-07-08T20:17:54.000Z", dt_exit: "2026-07-08T20:19:34.000Z" },
      { id_card_movement: 2, card_id: 55, flow_step_id: 1, dt_entry: "2026-07-08T20:19:34.000Z", dt_exit: null }
    ];
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(dry?.validation.message).toContain("Falta para a etapa Triagem (atual): Você aprova a arte abaixo? (SIM | NÃO)");
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });

    // Um segundo depois da entrada (card update-values nesta passagem) segue valendo.
    confirmed[1]!.form_answer_fields = [stamped(60, "1", "2026-07-08T20:19:35.000Z")];
    process.exitCode = undefined;
    const later = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(later?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_aprova: "1" });
  });

  it("formulário gravado fora da etapa atual (como o 1114758): corta pela SAÍDA da última passagem pela etapa dona dele", async () => {
    withApproval();
    flow = { ...flow, use_query_v2: "N" };
    preAnswer = draft([row(30, "1"), row(33, "76"), row(60, "1")]);
    // Rascunho do 902 (Agendamento) da passagem anterior, sem a Nota; a resposta do formulário
    // público que tirou o cartão do Agendamento traz a Nota, no segundo da saída (e da entrada na Triagem).
    otherDrafts[902] = draft([stamped(40, "2026-07-10T00:00:00.000Z", "2026-07-08T20:18:24.000Z")], {
      form_id: 902, id_form_answer: 5166774, dt_created: "2026-07-08T20:18:24.000Z"
    });
    confirmed.push({
      id_form_answer: 5166799, form_id: 902, flow_step_id: 2, origin: "/PublicForm/Step", dt_created: "2026-07-08T20:19:34.000Z",
      form_answer_fields: [stamped(53, "SIM da rodada anterior", "2026-07-08T20:19:34.000Z")]
    });
    movements = [
      { id_card_movement: 1, card_id: 55, flow_step_id: 2, dt_entry: "2026-07-08T20:17:54.000Z", dt_exit: "2026-07-08T20:19:34.000Z" },
      { id_card_movement: 2, card_id: 55, flow_step_id: 1, dt_entry: "2026-07-08T20:19:34.000Z", dt_exit: null }
    ];
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, values: {} });
    const dry = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(dry?.payload.values).toEqual({ h_data: "2026-07-10T00:00:00.000Z" });
    expect(dry?.keptFrom).toBe("rascunho");
    expect(dry?.dataLossCheck.orphans).toEqual([]);

    // Gravada depois da saída (card update-values com o cartão já na Triagem): vale.
    confirmed[1]!.form_answer_fields = [stamped(53, "nota nova", "2026-07-09T10:00:00.000Z")];
    process.exitCode = undefined;
    const later = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(later?.payload.values).toEqual({ h_data: "2026-07-10T00:00:00.000Z", h_nota: "nota nova" });
  });
});

describe("POP-1/R4-P1: valor gravado que a tela não resolve conta como vazio", () => {
  /** Regra gravada do campo (com o field_id do banco): o createYupSchema usa a lista nova. */
  const dbRequired = (fieldId: number) => [{ id_field_validation: 1, field_id: fieldId, type: "required", params: "obrigatório" }];

  function withUserRule(): void {
    fields = baseFields().map((field) => (field.id_field === 33 ? { ...field, validations: dbRequired(33) } : field));
    usersByForm = [
      { id_user: 76, name: "Matheus", flow_user_type: "A" },
      { id_user: 80, name: "Leitor", flow_user_type: "V" }
    ];
  }

  it("usuário bloqueado ou leitor no rascunho (como o 824006 e o 311243): a tela mostra vazio e o obrigatório bloqueia com o motivo", async () => {
    withUserRule();
    for (const user of ["517", "80"]) {
      preAnswer = draft([row(30, "1"), row(33, user)]);
      process.exitCode = undefined;
      process.env[FORCE_DRY_RUN_ENV] = "1";
      const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

      expect(process.exitCode).toBe(EXIT_CODES.USAGE);
      const message = String(dry?.validation.message);
      expect(message).toContain(`Responsável pelo Atendimento está gravado no cartão, mas a tela mostra o campo vazio (usuário ${user} bloqueado`);
      expect(message).toContain('--set "Responsável pelo Atendimento=<usuário: id, e-mail ou nome>"');
      expect(message).not.toContain("Falta para a etapa Triagem (atual): Responsável");
      expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1 });
    }
    const read = requests.find((request) => request.path === "/user/by-flow");
    expect(read?.query.get("form_id")).toBe("901");

    // O --set com outro usuário bloqueado (fora da lista) não serve; com um da lista, move.
    process.exitCode = undefined;
    const bad = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Responsável pelo Atendimento=3150"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(String(bad?.validation.message)).toContain("o usuário 3150 não aparece neste campo na tela");
    process.exitCode = undefined;
    const ok = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", "Responsável pelo Atendimento=76"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });
  });

  it("campo de usuário não obrigatório fora da lista sai do mover e vai no aviso; sem a regra gravada na 1ª posição a tela não cobra", async () => {
    fields = [
      ...baseFields(),
      { id_field: 34, name: "h_apoio", title: "Apoio", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "0", validations: [] }
    ];
    usersByForm = [{ id_user: 76, flow_user_type: "A" }];
    // Responsável obrigatório SEM o field_id na regra (lista antiga): o `{}` passa no required da tela.
    preAnswer = draft([row(30, "1"), row(33, "517"), row(34, "3101")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1 });
    expect(out?.warning).toContain("Gravados no cartão que a tela não mostra na etapa Triagem (atual): ");
    expect(out?.warning).toContain("Responsável pelo Atendimento (usuário 517 bloqueado");
    expect(out?.warning).toContain("Apoio (usuário 3101 bloqueado");
  });

  it("combo com 'none' ou opção apagada, rádio com opção oculta, caixa de marcação e check list: o que a tela mostra", async () => {
    const item = (description: string, index: number) => JSON.stringify({ id_check_list_item: 0, hash: `h${index}`, description, index, checked: "S" });
    fields = [
      ...baseFields(),
      { id_field: 80, name: "h_motivo", title: "Motivo da perda", type: "COMBO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, options: [{ value: "1", label: "Preço" }, { value: "2", label: "Prazo", hide: "S" }] },
      { id_field: 81, name: "h_canal", title: "Canal", type: "RADIO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, options: [{ value: "1", label: "Telefone" }, { value: "2", label: "Loja", hide: "S" }] },
      { id_field: 82, name: "h_tags", title: "Tags", type: "CHECK_BOX_FIELD", form_id: 901, required: "0", validations: [], options: [{ value: "a", label: "Azul" }, { value: "v", label: "Verde", hide: "S" }] },
      { id_field: 83, name: "h_check", title: "Conferência", type: "CHECK_LIST_FIELD", form_id: 901, required: "1", validation_type: "array", validations: REQUIRED }
    ];
    preAnswer = draft([
      row(30, "1"), row(33, "76"), row(80, "none"), row(81, "2"), row(82, "a", 0), row(82, "v", 1), row(83, item("", 1), 1), row(83, item("", 2), 2)
    ]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = String(dry?.validation.message);
    expect(message).toContain('Motivo da perda está gravado no cartão, mas a tela mostra o campo vazio (gravado "none"');
    expect(message).toContain('Canal está gravado no cartão, mas a tela mostra o campo vazio (opção "2" oculta)');
    expect(message).toContain("Conferência está gravado no cartão, mas a tela mostra o campo vazio (2 item(ns) sem descrição");
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_tags: ["a"] });
    expect(dry?.warning).toContain('Tags (opção "v" oculta ou que não existe mais)');

    // Opção oculta no COMBO vale (a tela acha nas opções todas); a apagada não.
    preAnswer = draft([row(30, "1"), row(33, "76"), row(80, "2"), row(81, "1"), row(83, item("RG", 1), 1)]);
    process.exitCode = undefined;
    const ok = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.calls[0].payload.values).toMatchObject({ h_motivo: "2", h_canal: "1" });
  });

  it("cartão conectado excluído (como o 675472) e anexo que não existe: a tela não carrega e o obrigatório cobra", async () => {
    fields = [
      ...baseFields(),
      { id_field: 84, name: "h_onb", title: "Onboarding CS", type: "COMBO_BOX_FLOW_FIELD", form_id: 901, flow_id: 400, required: "1", validation_type: "array", validations: REQUIRED },
      { id_field: 85, name: "h_contrato", title: "Contrato", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "1", validation_type: "mixed", validations: REQUIRED },
      { id_field: 86, name: "h_extra", title: "Extras", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "0", validations: [] }
    ];
    cardsByIds = (body) => (body.card_items as string[]).filter((id) => id !== "821921").map((id) => ({ id_card: Number(id) }));
    missingAttachments = new Set([1166868]);
    preAnswer = draft([row(30, "1"), row(33, "76"), row(84, "821921"), row(85, "1166868"), row(85, "1166869", 1), row(86, "1166868")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = String(dry?.validation.message);
    expect(message).toContain("Onboarding CS está gravado no cartão, mas a tela mostra o campo vazio (cartão 821921 excluído ou sem acesso");
    expect(message).toContain("Contrato está gravado no cartão, mas a tela mostra o campo vazio (anexo 1166868 que não existe mais");
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });
    expect(dry?.warning).toContain("Extras (anexo 1166868");
    expect(requests.find((request) => request.path === "/card/by-cards")?.body).toEqual({ card_items: ["821921"], flow_id: 400, flow_parent_id: 316 });

    // Cartão que carrega e anexos que existem: vão como estão.
    missingAttachments = new Set();
    preAnswer = draft([row(30, "1"), row(33, "76"), row(84, "821922"), row(85, "1166869")]);
    process.exitCode = undefined;
    const ok = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76, h_onb: [821922], h_contrato: [1166869] });

    // Leitura que falha (rede, 5xx): o kit não afirma o que não conferiu e leva como está.
    cardsByIds = undefined;
    preAnswer = draft([row(30, "1"), row(33, "76"), row(84, "821921"), row(85, "1166869")]);
    process.exitCode = undefined;
    const unknown = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(unknown?.calls[0].payload.values).toMatchObject({ h_onb: [821921] });
  });

  it("--payload: o obrigatório cobra igual, e o não obrigatório que a tela não mostra não vira órfão no dataLossCheck", async () => {
    withUserRule();
    fields = [...fields, { id_field: 34, name: "h_apoio", title: "Apoio", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "0", validations: [] }];
    preAnswer = draft([row(30, "1"), row(33, "517")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: {} });
    const dry = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(String(dry?.validation.message)).toContain("Responsável pelo Atendimento está gravado no cartão, mas a tela mostra o campo vazio");
    expect(dry?.payload.values).toEqual({ h_horas: 1 });

    preAnswer = draft([row(30, "1"), row(33, "76"), row(34, "3101")]);
    process.exitCode = undefined;
    const ok = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.payload.values).toEqual({ h_horas: 1, h_resp: 76 });
    expect(ok?.dataLossCheck.orphans).toEqual([]);
    expect(ok?.warning).toContain("Apoio (usuário 3101 bloqueado");
  });
});

describe("R4-P2: documento e telefone com a régua da tela", () => {
  function withDocs(): void {
    fields = [
      ...baseFields(),
      { id_field: 90, name: "h_cpf", title: "CPF3", type: "DOC_FIELD", form_id: 901, required: "1", validation_type: null, validations: REQUIRED },
      { id_field: 91, name: "h_doc", title: "CPF ou CNPJ", type: "DOC_FIELD", variation: "3", form_id: 901, required: "0", validations: [], show_on_form: "S" },
      { id_field: 92, name: "h_zap", title: "WhatsApp do Executor", type: "PHONE_FIELD", form_id: 901, required: "0", validations: [] }
    ];
  }

  it("valor gravado inválido bloqueia o mover com a frase da tela, mesmo não obrigatório e oculto (como o 52385, 359355 e 1116619)", async () => {
    withDocs();
    preAnswer = draft([row(30, "1"), row(33, "76"), row(90, "555.555.555-55"), row(91, "16.505.668/0001-22"), row(92, "(12) 31231")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = String(dry?.validation.message);
    expect(message).toContain('CPF3 (CPF): "555.555.555-55" não passa na tela (CPF inválido)');
    expect(message).toContain('CPF ou CNPJ (CPF ou CNPJ): "16.505.668/0001-22" não passa na tela (CPF ou CNPJ inválido)');
    expect(message).toContain('WhatsApp do Executor (telefone com DDD): "(12) 31231" não passa na tela (Telefone inválido');
    expect(message).toContain('--set "CPF3=<CPF>"');
    expect(message).not.toContain("—");

    // Válidos (o 13 dígitos a tela corta para 11 e aceita): move e reenvia como gravados.
    preAnswer = draft([row(30, "1"), row(33, "76"), row(90, "123.456.789-09"), row(91, "11222333000181"), row(92, "+55 21 98765-4321")]);
    process.exitCode = undefined;
    const ok = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.calls[0].payload.values).toEqual({
      h_horas: 1, h_resp: 76, h_cpf: "123.456.789-09", h_doc: "11222333000181", h_zap: "+55 21 98765-4321"
    });
  });

  it("documento sem dígito ('N/A') a tela mostra vazio: obrigatório cobra, não obrigatório sai do mover", async () => {
    withDocs();
    preAnswer = draft([row(30, "1"), row(33, "76"), row(90, "N/A"), row(92, "sem")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(String(dry?.validation.message)).toContain("CPF3 está gravado no cartão, mas a tela mostra o campo vazio");
    expect(dry?.calls[0].payload.values).toEqual({ h_horas: 1, h_resp: 76 });
    expect(dry?.warning).toContain("WhatsApp do Executor (");
  });

  it("--set: CPF repetido, CNPJ em campo de CPF e telefone fora de 10/11 dígitos não servem; os válidos passam", async () => {
    withDocs();
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const cases: Array<[string, string]> = [
      ["CPF3=111.111.111-11", "CPF inválido"],
      ["CPF3=11.222.333/0001-81", "CPF inválido"],
      ["WhatsApp do Executor=+55 21 98765-4321", "Telefone inválido"],
      ["WhatsApp do Executor=98765432", "Telefone inválido"]
    ];
    for (const [set, reason] of cases) {
      process.exitCode = undefined;
      const dry = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento", "--set", set]);
      expect(process.exitCode).toBe(EXIT_CODES.USAGE);
      expect(String(dry?.validation.message)).toContain(reason);
    }
    process.exitCode = undefined;
    const ok = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "CPF3=111.444.777-35", "--set", "CPF ou CNPJ=12.ABC.345/01DE-35", "--set", "WhatsApp do Executor=(21) 98765-4321"
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(ok?.calls[0].payload.values).toMatchObject({ h_cpf: "111.444.777-35", h_doc: "12.ABC.345/01DE-35", h_zap: "(21) 98765-4321" });
  });
});
