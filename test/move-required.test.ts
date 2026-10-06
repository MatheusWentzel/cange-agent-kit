import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { moveRequiredHint, skipsRequiredOnBackwardMove } from "../src/cli/move-required.js";
import { FORCE_DRY_RUN_ENV } from "../src/utils/forceDryRun.js";

/**
 * Decisão 1 do Matheus (06/10/2026): mover exige os obrigatórios da etapa ATUAL, sempre.
 * Todos os caminhos de mover do kit (card move, move-step-with-values com e sem --payload,
 * move-step) cobram, com ou sem --validate-fields/--dry-run, e o erro traz o comando pronto
 * para gravar e mover no mesmo passo. Fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

const STEPS = [
  { id_step: 1, name: "Triagem", form_id: 901, index: 1 },
  { id_step: 2, name: "Agendamento", form_id: 902, index: 2 },
  { id_step: 3, name: "Ganho", form_id: 903, index: 3, isEndStep: "1" }
];

const FIELDS = [
  { id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900, required: "1" },
  { id_field: 30, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", form_id: 901, required: "1" },
  { id_field: 31, name: "h_obs", title: "Observação", type: "TEXT_LONG_FIELD", form_id: 901 },
  {
    id_field: 32,
    name: "h_qualif",
    title: "Qualificado",
    type: "RADIO_BOX_FIELD",
    form_id: 901,
    required: "1",
    options: [
      { value: "1", label: "Sim" },
      { value: "2", label: "Não" }
    ]
  },
  { id_field: 40, name: "h_data", title: "Data da ligação", type: "DATE_PICKER_FIELD", form_id: 902, required: "1" },
  { id_field: 50, name: "h_motivo", title: "Motivo do ganho", type: "TEXT_SHORT_FIELD", form_id: 903, required: "1" }
];

let flow: Record<string, unknown>;
let card: Record<string, unknown>;

/** Cartão 55 na Triagem, com Observação preenchida (Horas e Qualificado vazios). */
function cardIn(stepId: number, answers: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    id_card: 55,
    flow_id: 316,
    flow_step_id: stepId,
    form_answers: [
      { id_form_answer: 700, form_id: 900, form_answer_fields: [{ field_id: 20, value: "Pedido ACME" }] },
      { id_form_answer: 701, form_id: 901, form_answer_fields: [{ field_id: 31, value: "cliente quente" }] },
      ...answers
    ]
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let dir = "";
async function payloadFile(body: Record<string, unknown>): Promise<string> {
  const file = join(dir, `move-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(body), "utf8");
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kit-move-required-"));
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
  flow = { id_flow: 316, name: "CNG CRM", form_init_id: 900, flow_steps: STEPS };
  card = cardIn(1);
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
    requests.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/flow") return json(flow);
    if (method === "GET" && url.pathname === "/field/by-flow") return json(FIELDS);
    if (method === "GET" && url.pathname === "/card/") return json(card);
    if (method === "PUT" && url.pathname === "/form/answer") return json({ id_card: 55 });
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
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  const out = stdout.join("");
  return out ? (JSON.parse(out) as Record<string, any>) : undefined;
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

/** Mensagem do erro JSON do stderr (o `card move-step` escreve antes o aviso de deprecado). */
function errorMessage(): string {
  const text = stderr.join("");
  return String(JSON.parse(text.slice(text.indexOf("{"))).message);
}

describe("card move: obrigatórios da etapa atual sempre", () => {
  it("sem --validate-fields e sem --dry-run: faltou obrigatório = exit 2, nada gravado, comando pronto", async () => {
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("Nada foi gravado.");
    expect(message).toContain("Falta para a etapa Triagem (atual): Horas (número), Qualificado (Sim | Não)");
    expect(message).toContain("Mover exige os obrigatórios da etapa atual (regra da plataforma, igual à tela).");
    expect(message).toContain("pergunte ao usuário (não invente)");
    expect(message).toContain(
      'cange card move --card-id 55 --flow-id 316 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>"'
    );
    expect(message).not.toContain("repita os --set");
  });

  it("com --set de outra etapa e faltando a atual: pede só o que falta e manda repetir o que já veio", async () => {
    await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=2", "--set", "Data da ligação=06/10/2026"
    ]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("Falta para a etapa Triagem (atual): Qualificado (Sim | Não)");
    expect(message).not.toContain("Horas (número)");
    expect(message).toContain('--set "Qualificado=<Sim | Não>" (repita os --set que você já mandou)');
  });

  it("preencher a etapa atual e mover no MESMO passo: uma chamada, com os campos e o que o cartão já tem", async () => {
    const out = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=3,5", "--set", "Qualificado=Sim"
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      path: "/card/v2/move-step",
      body: { from_step_id: 1, to_step_id: 2, id_form: 901, values: { h_obs: "cliente quente", h_horas: 3.5, h_qualif: "1" } }
    });
    expect(out).toMatchObject({ ok: true, fromStepId: 1, toStepId: 2 });
  });

  it("obrigatório que o cartão já tem conta (o mover reenvia); destino não é cobrado ao entrar", async () => {
    card = cardIn(1, [
      { id_form_answer: 702, form_id: 901, form_answer_fields: [{ field_id: 30, value: "4" }, { field_id: 32, value: "2" }] }
    ]);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toHaveLength(1);
    // Data da ligação (obrigatório do DESTINO) vazio não impede entrar: vale ao sair de lá.
    expect(writes()[0]?.body?.values).toMatchObject({ h_horas: 4, h_qualif: "2" });
  });

  it("--validate-fields segue aceito e não muda nada (a cobrança já é sempre)", async () => {
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "2", "--validate-fields"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual)");
  });

  it("voltar etapa: cobra; com 'pular obrigatórios ao voltar' ligado no fluxo, não cobra (igual à tela)", async () => {
    card = cardIn(2);
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Triagem"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorMessage()).toContain("Falta para a etapa Agendamento (atual): Data da ligação (data)");
    expect(writes()).toEqual([]);

    process.exitCode = undefined;
    stderr.length = 0;
    flow = { ...flow, skipRequiredOnBackwardMove: "S" };
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Triagem"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((write) => write.path)).toEqual(["/card/v2/move-step"]);
  });

  it("a flag do fluxo não vale para AVANÇAR etapa", async () => {
    flow = { ...flow, skipRequiredOnBackwardMove: "S" };
    await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
  });

  it("move-step-with-values sem --payload: mesma cobrança e mesma mensagem", async () => {
    await run(["card", "move-step-with-values", "--card-id", "55", "--flow-id", "316", "--to", "Ganho"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain('cange card move --card-id 55 --flow-id 316 --to "Ganho" --set "Horas=<número>"');
  });
});

describe("CANGE_FORCE_DRY_RUN: a conferência do gate vê a mesma cobrança", () => {
  it("faltando obrigatório: dry-run com validation inválida (exit 2), nada gravado", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const out = await run(["card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, executed: false, validation: { valid: false } });
    expect(out?.validation.message).toContain("Falta para a etapa Triagem (atual)");
    expect(out?.validation.message).toContain("cange card move --card-id 55");
  });

  it("com os --set da etapa atual: dry-run válido (exit 0) com o mover resolvido, nada gravado", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const out = await run([
      "card", "move", "--card-id", "55", "--flow-id", "316", "--to", "Agendamento",
      "--set", "Horas=1", "--set", "Qualificado=Não"
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, executed: false, validation: { valid: true } });
    expect(out?.calls[0]).toMatchObject({ call: "POST /card/v2/move-step", payload: { values: { h_horas: 1, h_qualif: "2" } } });
  });

  it("--payload também: dry-run inválido sem gravar", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 2 } });
    const out = await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(out?.validation.message).toContain("Falta para a etapa Triagem (atual): Qualificado (Sim | Não)");
  });
});

describe("move-step-with-values --payload: obrigatórios da etapa atual do cartão, sempre", () => {
  it("sem --validate-fields: faltou = exit 2, nada gravado, dica com card move e o values do payload", async () => {
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_obs: "cliente quente" }
    });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("Falta para a etapa Triagem (atual): Horas (número), Qualificado (Sim | Não)");
    expect(message).toContain(
      'cange card move --card-id 55 --flow-id 316 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>" (ou inclua esses campos no values do payload)'
    );
  });

  it("values com os obrigatórios (e o que o cartão já tem): move em 1 chamada", async () => {
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901,
      values: { h_obs: "cliente quente", h_horas: 2, h_qualif: "1" }
    });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((write) => write.path)).toEqual(["/card/v2/move-step"]);
    // O cartão foi lido uma vez só (a conferência e o detector de perda dividem a leitura).
    expect(requests.filter((request) => request.path === "/card/")).toHaveLength(1);
  });

  it("título no --set junto do payload também conta para a etapa atual", async () => {
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_obs: "cliente quente", h_horas: 2 }
    });
    await run(["card", "move-step-with-values", "--payload", file, "--set", "Qualificado=Sim"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()[0]?.body?.values).toMatchObject({ h_horas: 2, h_qualif: "1" });
  });

  it("obrigatório preenchido no cartão mas fora do values: o mover esvaziaria, então bloqueia com o motivo", async () => {
    card = cardIn(1, [
      { id_form_answer: 702, form_id: 901, form_answer_fields: [{ field_id: 30, value: "4" }, { field_id: 32, value: "1" }] }
    ]);
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_qualif: "1" }
    });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("Horas está preenchido no cartão mas não veio no values");
    expect(message).toContain("`cange card move`, que reenvia o que o cartão já tem");
    expect(message).not.toContain("Falta para");
  });

  it("payload que grava outro formulário (destino) não toca a etapa atual: vale o que o cartão já tem", async () => {
    card = cardIn(1, [
      { id_form_answer: 702, form_id: 901, form_answer_fields: [{ field_id: 30, value: "4" }, { field_id: 32, value: "1" }] }
    ]);
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: { h_data: "2026-10-06T00:00:00.000Z" }
    });
    await run(["card", "move-step-with-values", "--payload", file, "--allow-data-loss"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((write) => write.path)).toEqual(["/card/v2/move-step"]);
  });

  it("fromStepId diferente da etapa real do cartão: bloqueia e cobra a etapa REAL", async () => {
    card = cardIn(2);
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 3, idForm: 901, values: { h_horas: 1, h_qualif: "1" }
    });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    const message = errorMessage();
    expect(message).toContain("o cartão 55 está na etapa Agendamento (id 2), não na etapa 1 do fromStepId");
    expect(message).toContain("Falta para a etapa Agendamento (atual): Data da ligação (data)");
  });

  it("etapa atual fora do fluxo: erro claro apontando o card move, nada gravado", async () => {
    card = cardIn(99);
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: {} });
    await run(["card", "move-step-with-values", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Não achei a etapa atual do cartão 55 no fluxo 316 (etapa 99)");
  });

  it("--validate-fields com o idForm do destino: cobra a etapa atual E o formulário do payload", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 902, values: {} });
    await run(["card", "move-step-with-values", "--payload", file, "--validate-fields", "--allow-data-loss"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const message = errorMessage();
    expect(message).toContain("Falta para a etapa Triagem (atual): Horas (número), Qualificado (Sim | Não)");
    expect(message).toContain("Falta para a etapa Agendamento (destino): Data da ligação (data)");
  });
});

describe("card move-step (deprecado): também cobra", () => {
  it("faltou obrigatório da etapa atual: exit 2, nada gravado", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: {} });
    await run(["card", "move-step", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain("Falta para a etapa Triagem (atual): Horas (número), Qualificado (Sim | Não)");
  });

  it("--dry-run mostra a validação inválida (exit 2)", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 1 } });
    const out = await run(["card", "move-step", "--payload", file, "--dry-run"]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(out?.validation.message).toContain("Falta para a etapa Triagem (atual): Qualificado (Sim | Não)");
  });

  it("com os obrigatórios no values: move", async () => {
    const file = await payloadFile({
      flowId: 316, cardId: 55, fromStepId: 1, toStepId: 2, idForm: 901, values: { h_horas: 1, h_qualif: "1", h_obs: "x" }
    });
    await run(["card", "move-step", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(writes().map((write) => write.path)).toEqual(["/card/v2/move-step"]);
  });
});

describe("dica do comando", () => {
  const origin = (fields: Array<Record<string, unknown>>) => ({
    formId: "901",
    label: "etapa Triagem (atual)",
    priority: 0,
    fields: fields as never
  });

  it("título com = ou repetido no formulário vira hash; destino com nome repetido vira id", () => {
    const fields = [
      { id: 1, name: "h_a", title: "Valor = total", type: "NUMBER_FIELD", formId: 901, required: true },
      { id: 2, name: "h_b", title: "Nome", type: "TEXT_SHORT_FIELD", formId: 901, required: true },
      { id: 3, name: "h_c", title: "nome", type: "TEXT_SHORT_FIELD", formId: 901, required: true },
      { id: 4, name: "h_d", title: "Contrato", type: "INPUT_ATTACH_FIELD", formId: 901, required: true }
    ];
    const steps = [
      { id: 1, name: "Triagem", raw: {} },
      { id: 7, name: "Revisão", raw: {} },
      { id: 8, name: "revisao", raw: {} }
    ];
    const hint = moveRequiredHint({
      missing: fields as never,
      origin: origin(fields),
      steps,
      toStep: steps[1],
      cardId: 55
    });
    expect(hint.kind).toBe("hint");
    expect(hint.blocking).toBe(false);
    expect(hint.text).toContain(
      'cange card move --card-id 55 --to 7 --set "h_a=<número>" --set "h_b=<texto>" --set "h_c=<texto>" --set "Contrato=<id do anexo>"'
    );
    expect(hint.text).not.toContain("—");
  });

  it("skipsRequiredOnBackwardMove: só voltando e só com a flag ligada", () => {
    const back = [{ index: 3 }, { index: 1 }] as const;
    expect(skipsRequiredOnBackwardMove({ skipRequiredOnBackwardMove: "S" }, ...back)).toBe(true);
    expect(skipsRequiredOnBackwardMove({ skipRequiredOnBackwardMove: "1" }, ...back)).toBe(true);
    expect(skipsRequiredOnBackwardMove({ skipRequiredOnBackwardMove: "N" }, ...back)).toBe(false);
    expect(skipsRequiredOnBackwardMove({}, ...back)).toBe(false);
    expect(skipsRequiredOnBackwardMove({ skipRequiredOnBackwardMove: "S" }, { index: 1 }, { index: 3 })).toBe(false);
  });
});
