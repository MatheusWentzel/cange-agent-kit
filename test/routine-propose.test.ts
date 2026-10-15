import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCommandMeta } from "../src/cli/command-metadata.js";
import { routineProposalSentence } from "../src/cli/commands/routine-propose.js";
import { createProgram } from "../src/cli/index.js";
import { buildScheduleProposalBody } from "../src/contracts/scheduleProposal.js";

// D3 (14/10/2026): o agente PROPÕE uma rotina (POST /agent-schedule-proposal). Só
// cria o pedido; a rotina nasce quando quem administra o agente aprova.

const envBackup = { ...process.env };

function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

const TOKEN = runToken({ id_user: 9995, company_id: 3955, agent_id: 206, run_id: 500, token_type: "agent_run" });

describe("buildScheduleProposalBody (flags → corpo da rota)", () => {
  it("diária: um horário, gatilho 5", () => {
    expect(buildScheduleProposalBody({ name: " Cobrança ", instruction: " Liste ", frequency: "diaria", time: "08:00" })).toEqual({
      name: "Cobrança",
      instruction: "Liste",
      trigger_id: 5,
      trigger_config_fields: { trigger_time_hour: ["08:00"], trigger_time_weekend: false }
    });
  });

  it("dias úteis, semanal por nome e mensal com primeiro/último", () => {
    expect(buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "dias úteis", time: "07:30" }).trigger_config_fields)
      .toEqual({ trigger_time_hour: ["07:30"], trigger_time_weekend: true });
    expect(buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "Semanal", weekdays: "qua, seg,seg" }))
      .toMatchObject({ trigger_id: 6, trigger_config_fields: { trigger_time_weekday: ["1", "3"] } });
    expect(buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "mensal", monthdays: "ultimo,1,primeiro" }))
      .toMatchObject({ trigger_id: 7, trigger_config_fields: { trigger_time_monthday: ["-2", "-1", "1"] } });
  });

  it("recusa o que a tela não aceita: sem horário, dois horários, de hora em hora, dia inválido", () => {
    expect(() => buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "diaria" })).toThrow(/--time/);
    expect(() => buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "diaria", time: "08:00,09:00" })).toThrow(/--time/);
    expect(() => buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "horaria", time: "08:00" })).toThrow(/Mais de uma vez por dia/);
    expect(() => buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "semanal", weekdays: "feriado" })).toThrow(/--weekdays/);
    expect(() => buildScheduleProposalBody({ name: "a", instruction: "b", frequency: "mensal", monthdays: "32" })).toThrow(/--monthdays/);
    expect(() => buildScheduleProposalBody({ name: "", instruction: "b", frequency: "diaria", time: "08:00" })).toThrow(/--name/);
  });

  it("frase da resposta deixa claro que depende de aprovação, sem travessão", () => {
    const sentence = routineProposalSentence({ summary: "", deduped: false }, "Cobrança");
    expect(sentence).toMatch(/só passa a valer quando quem administra o agente aprovar/);
    expect(sentence).not.toMatch(/—/);
  });
});

describe("cange routine propose (CLI)", () => {
  const stdout: string[] = [];

  beforeEach(() => {
    delete process.env.CANGE_OUTPUT_PROFILE;
    process.env.CANGE_ACCESS_TOKEN = TOKEN;
    stdout.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function mockFetch(body: unknown, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
  }

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  const ARGS = ["routine", "propose", "--name", "Cobrança do dia", "--frequency", "diaria", "--time", "08:00",
    "--instruction", "Liste os boletos vencidos", "--flow", "192", "--card", "55"];

  it("--dry-run mostra o corpo e não chama o Cange", async () => {
    const fetchMock = mockFetch({});
    await run([...ARGS, "--dry-run"]);
    expect(fetchMock).not.toHaveBeenCalled();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, executed: false, payload: { trigger_id: 5, flow_id: 192, card_id: 55 } });
  });

  it("envia para POST /agent-schedule-proposal e devolve a frase pronta", async () => {
    const fetchMock = mockFetch({ approval_id: 801, deduped: false, status: "pending", summary: "Criar a rotina \"Cobrança do dia\": todo dia às 08:00. Vai: Liste" }, 201);
    await run(ARGS);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-schedule-proposal$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      name: "Cobrança do dia",
      instruction: "Liste os boletos vencidos",
      trigger_id: 5,
      trigger_config_fields: { trigger_time_hour: ["08:00"], trigger_time_weekend: false },
      flow_id: 192,
      card_id: 55
    });
    const out = JSON.parse(stdout.join(""));
    expect(out.approvalId).toBe(801);
    expect(out.status).toBe("pending");
    expect(out.message).toMatch(/Propus a rotina "Cobrança do dia"/);
    expect(out.note).toMatch(/Não espere a decisão nem repita o comando/);
  });

  it("grant desligado: o erro traz o próximo passo", async () => {
    mockFetch({ status: "error", message: "Propor rotinas está desligado para este agente.", complement: { code: "SCHEDULE_PROPOSE_DISABLED" } }, 403);
    await run(ARGS);
    expect(process.exitCode).not.toBe(0);
  });

  it("anotado como mutação (o runner classifica pelo comando)", () => {
    const program = createProgram();
    const propose = program.commands.find((c) => c.name() === "routine")?.commands.find((c) => c.name() === "propose");
    expect(propose).toBeDefined();
    expect(getCommandMeta(propose!)?.mutates).toBe(true);
  });
});
