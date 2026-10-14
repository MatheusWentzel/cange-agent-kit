import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { resetReadWindow } from "../src/client/readWindow.js";
import { FORCE_DRY_RUN_ENV } from "../src/utils/forceDryRun.js";

/**
 * REG-F1 (revisão final do lote F2-F6, 07/10/2026): cartão 921055 (fluxo 19106, 43 anexos no
 * formulário da etapa). Com o ritmo fixo de 2 leituras por segundo, `card move --dry-run` levava
 * 22,7 s, a conferência do gate (prazo de 15 s) morria sem resposta e o agente nunca conseguia pedir
 * aprovação. Aqui, com o ritmo REAL (sem `CANGE_SCREEN_REFS_RPS`) e o relógio falso do vitest:
 *  - nenhuma janela de 1 s do back (`apiRateLimiter`, janela fixa, a 11ª leitura bloqueia) passa do
 *    teto, contando os GETs que o mover faz antes dos anexos;
 *  - o dry-run responde em bem menos de 15 s e confere os 43;
 *  - com o prazo da conferência curto, o mover responde assim mesmo: o que não deu tempo vai como
 *    está gravado e sai no aviso.
 * Fetch mockado (a suíte bloqueia rede real).
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const requests: Array<{ method: string; path: string; at: number }> = [];

const REQUIRED = [{ id_field_validation: 1, type: "required", params: "obrigatório" }];
const ATTACHMENTS = Array.from({ length: 43 }, (_, index) => 859_787 + index);

let fields: Array<Record<string, unknown>>;
let draftRows: Array<Record<string, unknown>>;
/** A janela fixa do back: início e contagem; acima de 10 o mock responde 429, como o back. */
let backWindow: { start: number; count: number };
let backPeak = 0;
let blocked = 0;

function row(fieldId: number, value: string, index = 0): Record<string, unknown> {
  const field = fields.find((item) => item.id_field === fieldId);
  return { field_id: fieldId, index, value, deleted: "N", field: { id_field: fieldId, name: field?.name, type: field?.type } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.parse("2026-10-07T12:00:00.000Z") });
  resetReadWindow();
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.RUNNER_FLOW_ID;
  delete process.env.CANGE_CARD_FLOW_ID;
  delete process.env.CANGE_FLOW_ID;
  // O ritmo e o prazo de verdade (o default do kit).
  delete process.env.CANGE_SCREEN_REFS_RPS;
  delete process.env.CANGE_SCREEN_REFS_BUDGET_MS;
  process.env[FORCE_DRY_RUN_ENV] = "1";
  stdout.length = 0;
  requests.length = 0;
  backWindow = { start: Number.NEGATIVE_INFINITY, count: 0 };
  backPeak = 0;
  blocked = 0;
  fields = [
    { id_field: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", form_id: 900, required: "1", validation_type: "string", validations: REQUIRED },
    { id_field: 30, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", form_id: 901, required: "1", validation_type: "number", validations: REQUIRED },
    { id_field: 33, name: "h_resp", title: "Responsável", type: "COMBO_BOX_USER_FIELD", form_id: 901, required: "0", validation_type: null, validations: [] },
    { id_field: 36, name: "h_docs", title: "Documentos IRPF", type: "INPUT_ATTACH_FIELD", form_id: 901, required: "1", validation_type: "mixed", validations: REQUIRED }
  ];
  draftRows = [row(30, "2"), row(33, "76"), ...ATTACHMENTS.map((id, index) => row(36, String(id), index))];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const at = Date.now();
    requests.push({ method, path: url.pathname, at });
    if (method === "GET") {
      if (at - backWindow.start >= 1000) backWindow = { start: at, count: 0 };
      backWindow.count += 1;
      backPeak = Math.max(backPeak, backWindow.count);
      if (backWindow.count > 10) {
        blocked += 1;
        return json({ message: "Rate limit exceeded for read operations." }, 429);
      }
    }
    if (method === "GET" && url.pathname === "/flow") {
      return json({
        id_flow: 19106,
        name: "IRPF",
        form_init_id: 900,
        flow_steps: [
          { id_step: 1, name: "Envio de Documentos IRPF", form_id: 901, index: 1 },
          { id_step: 2, name: "Validação Dados e Arquivo", form_id: 902, index: 2 }
        ]
      });
    }
    if (method === "GET" && url.pathname === "/field/by-flow") return json(fields);
    if (method === "GET" && url.pathname === "/card/") {
      return json({
        id_card: 921055,
        flow_id: 19106,
        flow_step_id: 1,
        form_answers: [{ id_form_answer: 700, form_id: 900, flow_step_id: 1, dt_created: "2026-09-30T10:00:00.000Z", form_answer_fields: [row(20, "IRPF 2026")] }]
      });
    }
    if (method === "GET" && url.pathname === "/form/pre-answer") {
      return json({
        fields: [],
        formsAnswers: { id_form_answer: 800, form_id: 901, flow_step_id: null, dt_created: "2026-10-02T10:00:00.000Z", deleted: "N", form_answer_fields: draftRows }
      });
    }
    if (method === "GET" && url.pathname === "/card/moviment") {
      return json([{ id_card_movement: 1, card_id: 921055, flow_step_id: 1, dt_entry: "2026-09-30T09:00:00.000Z", dt_exit: null }]);
    }
    if (method === "GET" && url.pathname === "/user/by-flow") return json([{ id_user: 76, flow_user_type: "A" }]);
    if (method === "GET" && url.pathname === "/attachment") {
      return json({ id_attachment: Number(url.searchParams.get("id_attachment")), uploaded: true });
    }
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Roda o comando com o relógio falso andando de 5 em 5 ms; devolve a saída e o tempo (falso) gasto. */
async function runTimed(args: string[]): Promise<{ out: Record<string, any> | undefined; elapsedMs: number }> {
  stdout.length = 0;
  const startedAt = Date.now();
  let done = false;
  const running = createProgram()
    .parseAsync(["node", "cange", "--output", "json", ...args])
    .finally(() => {
      done = true;
    });
  while (!done && Date.now() - startedAt < 60_000) await vi.advanceTimersByTimeAsync(5);
  await running;
  const text = stdout.join("");
  return { out: text ? (JSON.parse(text) as Record<string, any>) : undefined, elapsedMs: Date.now() - startedAt };
}

const MOVE = ["card", "move", "--card-id", "921055", "--flow-id", "19106", "--to", "Validação Dados e Arquivo"];

describe("REG-F1: o mover cabe no prazo da conferência do gate e no teto de leitura do back", () => {
  it("921055 (43 anexos): confere todos sem passar de 10 GETs por janela e responde em bem menos de 15 s", async () => {
    const { out, elapsedMs } = await runTimed(MOVE);

    expect(process.exitCode ?? 0).toBe(0);
    expect(blocked).toBe(0);
    expect(backPeak).toBeLessThanOrEqual(10);
    expect(requests.filter((request) => request.path === "/attachment")).toHaveLength(43);
    // 43 anexos, a lista do campo de usuário e os GETs do mover a 8 por janela de 1 s: uns 5 s.
    // O ritmo fixo de 2/s dava 22 s (a conferência do gate morria em 15 s sem resposta).
    expect(elapsedMs).toBeLessThan(8000);
    expect(out?.calls[0].payload.values).toEqual({ h_horas: 2, h_resp: 76, h_docs: ATTACHMENTS });
    expect(String(out?.warning ?? "")).not.toContain("Não conferidos no prazo");
  });

  it("prazo curto (1 s): confere o que cabe, o resto vai como está gravado e sai no aviso; o mover responde", async () => {
    process.env.CANGE_SCREEN_REFS_BUDGET_MS = "1000";
    const { out, elapsedMs } = await runTimed(MOVE);

    expect(process.exitCode ?? 0).toBe(0);
    expect(blocked).toBe(0);
    const read = requests.filter((request) => request.path === "/attachment").length;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(43);
    expect(elapsedMs).toBeLessThan(2000);
    // O obrigatório não conferido não bloqueia: o kit não afirma o que não leu (como a falha de leitura).
    expect(out?.calls[0].payload.values).toEqual({ h_horas: 2, h_resp: 76, h_docs: ATTACHMENTS });
    const warning = String(out?.warning);
    expect(warning).toContain("Não conferidos no prazo na etapa Envio de Documentos IRPF (atual)");
    expect(warning).toContain(`Documentos IRPF (${43 - read} de 43 anexos)`);
    expect(warning).toContain("o mover leva esses valores como estão gravados");
  });

  it("prazo zerado: nenhuma leitura do que a tela resolve; usuário e anexos saem no aviso", async () => {
    process.env.CANGE_SCREEN_REFS_BUDGET_MS = "0";
    const { out } = await runTimed(MOVE);

    expect(process.exitCode ?? 0).toBe(0);
    expect(requests.some((request) => request.path === "/attachment" || request.path === "/user/by-flow")).toBe(false);
    expect(out?.calls[0].payload.values).toEqual({ h_horas: 2, h_resp: 76, h_docs: ATTACHMENTS });
    const warning = String(out?.warning);
    expect(warning).toContain("Responsável (usuário 76)");
    expect(warning).toContain("Documentos IRPF (43 de 43 anexos)");
  });

  it("anexo que não existe dentro do prazo segue bloqueando o obrigatório, como a tela", async () => {
    draftRows = [row(30, "2"), row(33, "76"), row(36, "1166868"), row(36, "1166869", 1)];
    const fetchMock = vi.mocked(globalThis.fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/attachment" && url.searchParams.get("id_attachment") === "1166868") {
        requests.push({ method: "GET", path: url.pathname, at: Date.now() });
        return json({ message: "Parâmetros inválidos! Não foi possivel encontrar o registro!" }, 404);
      }
      return base(input, init);
    });
    const { out } = await runTimed(MOVE);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(String(out?.validation.message)).toContain("Documentos IRPF está gravado no cartão, mas a tela mostra o campo vazio (anexo 1166868");
  });
});
