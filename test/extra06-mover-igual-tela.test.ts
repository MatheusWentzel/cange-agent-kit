import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { validateValuesAgainstFields } from "../src/contracts/payload-builder.js";
import { normalizeFieldsFromApiResponse } from "../src/schemas/fields.js";
import { readStepCarryOver } from "../src/utils/carryOver.js";
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
      if (preAnswer === undefined && preFields === undefined) return json({ message: "rota não mockada" }, 404);
      const formId = Number(url.searchParams.get("id_form"));
      return json({ fields: preFields ?? [], formsAnswers: preAnswer && preAnswer.form_id === formId ? preAnswer : null });
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

function writes() {
  return requests.filter((request) => request.method !== "GET");
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

  it("anexo no rascunho que o kit não remonta: avisa que não vai (Não reenviados)", async () => {
    preAnswer = draft([row(30, "1"), row(33, "76"), row(36, "9911")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.warning).toContain("Não reenviados (ficam vazios na etapa Triagem): Proposta.");
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
    expect(out?.autocompleted).toEqual(["Cópia do título", "Quando", "Dono"]);
    // O autocompletar não entra no `kept` (é valor novo, não o que o cartão tinha).
    expect(out).toMatchObject({ kept: 2, keptFrom: "rascunho" });
  });

  it("dinâmico de data copia em ISO (dd/MM/yyyy também); origem no rascunho da etapa", () => {
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
    expect(carry.values.h_prazo).toBe("2026-10-08T00:00:00.000Z");
    expect(carry.autoFilled).toEqual([{ name: "h_prazo", title: "Prazo", rule: "campo-do-cartao" }]);
  });

  it("autocompletar que o kit não calcula (usuário atual, vínculo, opção por rótulo): obrigatório vazio vira aviso", async () => {
    const extra = [
      { id_field: 48, name: "h_atual", title: "Quem atende", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: -2 },
      { id_field: 49, name: "h_cliente", title: "Cidade do cliente", type: "TEXT_SHORT_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20, ac_child_field_id: 99 },
      { id_field: 50, name: "h_canal", title: "Canal", type: "RADIO_BOX_FIELD", form_id: 901, required: "1", validation_type: "string", validations: REQUIRED, ac_type: 0, ac_parent_field_id: 20, options: [{ value: "1", label: "Telefone" }] }
    ];
    fields = [...baseFields(), ...extra];
    preFields = extra;
    preAnswer = draft([row(30, "1"), row(33, "76")]);
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_horas: 1, h_resp: 76 });
    expect(out?.warning).toContain(
      "Obrigatórios vazios com autocompletar que o kit não calcula na etapa Triagem (atual): " +
        "Quem atende (usuário atual), Cidade do cliente (campo de vínculo), Canal (opção pelo rótulo)"
    );
    expect(out?.warning).not.toContain("—");
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

    // Sem mandar o campo: segue aviso (a tela poria o anexo do autocompletar).
    process.exitCode = undefined;
    stderr.length = 0;
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out?.warning).toContain("Contrato (tipo que o kit não remonta)");
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

describe("EXTRA-06 D1: mover por --payload", () => {
  it("payload que grava a etapa atual: reenvia o rascunho com o values por cima e conta o rascunho", async () => {
    preAnswer = draft([row(33, "76"), row(31, "rascunho")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 3, h_obs: "do payload" } });
    const out = await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(moveBody()?.values).toEqual({ h_resp: 76, h_obs: "do payload", h_horas: 3 });
    expect(out).toMatchObject({ kept: 1, keptFrom: "rascunho" });
  });

  it("--dry-run do payload mostra o values já com o rascunho e o dataLossCheck pela mesma fonte", async () => {
    preAnswer = draft([row(33, "76"), row(36, "9911")]);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 3 } });
    const out = await run(["card", "move-step-with-values", "--payload", file, "--dry-run"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out?.payload.values).toEqual({ h_resp: 76, h_horas: 3 });
    // Só o anexo (que o kit não remonta) fica de fora.
    expect(out?.dataLossCheck.orphans).toEqual([{ fieldName: "h_anexo", fieldTitle: "Proposta", currentValue: "9911" }]);
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
