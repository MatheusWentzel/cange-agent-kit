import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { pickResponsible, resolveTag } from "../src/cli/commands/card-update.js";
import { cardStateOf, dueForAgent, dueWallClock, parseDueInput } from "../src/utils/cardState.js";

/**
 * v9 (g, decisão de 08/10): vencimento, responsável e etiqueta com 1 comando curto.
 * Conversa 857 (run 1119): o vencimento custou 18 passos e bateu o teto porque o
 * `card update` exigia arquivo e flowId. Runs 1125/1126: o agente disse que o
 * "Vencimento" não existia (o card read não mostrava). Fetch mockado, nada real.
 */

const envBackup = { ...process.env };
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];

const FLOW = { id_flow: 316, name: "CNG CRM", form_init_id: 900, flow_steps: [{ id_step: 1, name: "Triagem", form_id: 901 }] };

/** Cartão 55: vence 27/10/2026 00:00 (03:00 Z), responsável Ana Souza, etiqueta Frio. */
const CARD = {
  id_card: 55,
  flow_id: 316,
  flow_step_id: 1,
  title: "Pedido ACME",
  dt_due: "2026-10-27T03:00:00.000Z",
  user_id: 7,
  user: { id_user: 7, name: "Ana Souza", email: "ana@acme.com" },
  card_flow_tags: [{ id_card_flow_tag: 1, card_id: 55, flow_tag_id: 12, flow_tag: { id_flow_tag: 12, description: "Frio" } }],
  form_answers: []
};

const USERS = [
  { id_user: 7, name: "Ana Souza", email: "ana@acme.com", flow_user_type: "M" },
  { id_user: 8, name: "Ana Lima", email: "lima@acme.com", flow_user_type: "A" },
  { id_user: 9, name: "Bruno Reis", email: "bruno@acme.com", flow_user_type: "M" },
  { id_user: 10, name: "Carla Leitora", email: "carla@acme.com", flow_user_type: "V" }
];

const TAGS = [
  { id_flow_tag: 12, flow_id: 316, description: "Frio", color: "#00f" },
  { id_flow_tag: 13, flow_id: 316, description: "Quente", color: "#f00" }
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let cardBody: Record<string, unknown> = CARD;
let tagsBody: unknown[] = TAGS;

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  for (const name of [
    "CANGE_OUTPUT_PROFILE",
    "RUNNER_FLOW_ID",
    "CANGE_CARD_FLOW_ID",
    "CANGE_FLOW_ID",
    "RUNNER_CARD_ID",
    "CANGE_CARD_ID",
    "RUNNER_SPEAKER_USER_ID",
    "CANGE_FORCE_DRY_RUN"
  ]) {
    delete process.env[name];
  }
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  cardBody = CARD;
  tagsBody = TAGS;
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
    if (method === "GET" && url.pathname === "/card/locate") return json({ id_card: 55, flow_id: 316, flow_name: "CNG CRM" });
    if (method === "GET" && url.pathname === "/card/") return json(cardBody);
    if (method === "GET" && url.pathname === "/flow") return json(FLOW);
    if (method === "GET" && url.pathname === "/user/by-flow") return json(USERS);
    if (method === "GET" && url.pathname === "/flow-tag/by-flow") return json(tagsBody);
    if (method === "PUT" && url.pathname === "/card") return json({ id_card: 55, flow_id: 316 });
    if (method === "POST" && url.pathname === "/flow-tag/card") return json({ id_card_flow_tag: 99 });
    if (method === "DELETE" && url.pathname === "/flow-tag/card") return json({ affected: 1 });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<Record<string, any> | undefined> {
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

const BASE = ["card", "update", "--card-id", "55", "--flow-id", "316"];

describe("--due (régua da data)", () => {
  // 08/10/2026 15:00 em Brasília (18:00 Z).
  const now = new Date("2026-10-08T18:00:00.000Z");

  it.each([
    ["27/10/2026", "2026-10-27 00:00"],
    ["27/10/2026 18:30", "2026-10-27 18:30"],
    ["7/1/2027 9:05", "2027-01-07 09:05"],
    ["2026-10-27", "2026-10-27 00:00"],
    ["2026-10-27 18:30", "2026-10-27 18:30"],
    ["2026-10-27T18:30", "2026-10-27 18:30"],
    ["hoje", "2026-10-08 00:00"],
    ["amanhã", "2026-10-09 00:00"],
    ["amanha", "2026-10-09 00:00"],
    ["Amanhã 18:00", "2026-10-09 18:00"],
    // dd/mm: a próxima ocorrência a partir de hoje (hoje conta).
    ["08/10", "2026-10-08 00:00"],
    ["27/10", "2026-10-27 00:00"],
    ["05/03", "2027-03-05 00:00"],
    ["29/02", "2028-02-29 00:00"]
  ])("%s vira %s (hora de parede de Brasília)", (raw, wall) => {
    expect(parseDueInput(raw, now)).toEqual({ kind: "set", wall });
  });

  it("hoje em Brasília, não em UTC: 23:30 de 08/10 em Brasília já é 09/10 em UTC", () => {
    expect(parseDueInput("hoje", new Date("2026-10-09T02:30:00.000Z"))).toEqual({ kind: "set", wall: "2026-10-08 00:00" });
  });

  it.each(["limpar", "sem", "", "  LIMPAR "])("%j tira o vencimento", (raw) => {
    expect(parseDueInput(raw, now)).toEqual({ kind: "clear" });
  });

  it.each(["31/02/2026", "27/13/2026", "27/10/2026 24:00", "27/10/2026 18:60", "2026-02-30", "semana que vem", "27-10-2026"])(
    "%s é inválida",
    (raw) => {
      expect(parseDueInput(raw, now)).toBeUndefined();
    }
  );
});

describe("vencimento gravado → o que o agente lê", () => {
  it("ISO com Z vira hora de Brasília; sem fuso sai como está; vazio é null", () => {
    expect(dueWallClock("2026-10-27T03:00:00.000Z")).toBe("2026-10-27 00:00");
    expect(dueWallClock("2026-10-27T21:30:00.000Z")).toBe("2026-10-27 18:30");
    expect(dueWallClock("2026-10-27 18:30:00")).toBe("2026-10-27 18:30");
    expect(dueForAgent("2026-10-27T03:00:00.000Z")).toBe("27/10/2026 00:00");
    expect(dueForAgent(null)).toBeNull();
    expect(dueForAgent("")).toBeNull();
  });

  it("cardStateOf: responsável e etiquetas do GET /card; sem nada = null e []", () => {
    expect(cardStateOf(CARD)).toEqual({
      due: "2026-10-27 00:00",
      responsible: { id: 7, name: "Ana Souza" },
      tags: [{ id: 12, name: "Frio" }]
    });
    expect(cardStateOf({ id_card: 1, flow_id: 2, dt_due: null, user_id: null })).toEqual({ due: null, responsible: null, tags: [] });
  });
});

describe("card update --due/--responsible (1 PUT /card)", () => {
  it("--due dd/mm/aaaa: só dt_due no PUT, sem hora = 00:00, e a saída diz o que mudou", async () => {
    const out = await run([...BASE, "--due", "30/10/2026"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "PUT", path: "/card" });
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, dt_due: "2026-10-30 00:00" });
    expect(out).toMatchObject({
      ok: true,
      cardId: 55,
      flowId: 316,
      changed: { due: "30/10/2026 00:00" },
      summary: "Cartão 55: vencimento 30/10/2026 00:00."
    });
  });

  it("--due com hora grava a hora de parede", async () => {
    await run([...BASE, "--due", "30/10/2026 18:00"]);
    expect(writes()[0]!.body).toMatchObject({ dt_due: "2026-10-30 18:00" });
  });

  it("--due limpar manda dt_due null (tira o vencimento)", async () => {
    const out = await run([...BASE, "--due", "limpar"]);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, dt_due: null });
    expect(out).toMatchObject({ changed: { due: null }, summary: "Cartão 55: vencimento removido." });
  });

  it("data inválida: exit 2 com a régua, nada gravado", async () => {
    await run([...BASE, "--due", "31/02/2026"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain(
      'Data de vencimento inválida: "31/02/2026". Use dd/mm/aaaa, com hora opcional (27/10/2026 18:00), ou limpar.'
    );
    expect(errorMessage()).toContain("Nada foi gravado.");
  });

  it("vencimento igual ao gravado: nada a gravar (noop), exit 0", async () => {
    const out = await run([...BASE, "--due", "27/10/2026"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out).toEqual({
      ok: true,
      cardId: 55,
      flowId: 316,
      noop: true,
      unchanged: ["O vencimento já era 27/10/2026 00:00."],
      summary: "Nada mudou: o vencimento já era 27/10/2026 00:00."
    });
  });

  it("--responsible eu = RUNNER_SPEAKER_USER_ID (quem conversa), na lista do fluxo", async () => {
    process.env.RUNNER_SPEAKER_USER_ID = "9";
    const out = await run([...BASE, "--responsible", "eu"]);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, user_id: 9 });
    expect(out).toMatchObject({ changed: { responsible: { id: 9, name: "Bruno Reis" } }, summary: "Cartão 55: responsável Bruno Reis." });
    const byFlow = requests.find((request) => request.path === "/user/by-flow");
    expect(byFlow?.query.get("id_flow")).toBe("316");
  });

  it("--responsible eu fora de conversa: exit 2, nada gravado", async () => {
    await run([...BASE, "--responsible", "eu"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain('"eu" só vale numa conversa: informe o nome, o e-mail ou o id da pessoa.');
  });

  it("nome ambíguo: lista os candidatos, nada gravado", async () => {
    await run([...BASE, "--responsible", "Ana"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain(
      'Responsável: "Ana" é ambíguo: Ana Souza (id 7, ana@acme.com), Ana Lima (id 8, lima@acme.com).'
    );
  });

  it("leitor do fluxo não aparece no seletor da tela: não serve de responsável", async () => {
    await run([...BASE, "--responsible", "carla@acme.com"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain('nenhum usuário "carla@acme.com" entre os que a tela deixa escolher neste fluxo');
  });

  it("--responsible ninguém manda user_id null", async () => {
    const out = await run([...BASE, "--responsible", "ninguém"]);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, user_id: null });
    expect(out).toMatchObject({ changed: { responsible: null }, summary: "Cartão 55: sem responsável." });
  });

  it("--due e --responsible juntos: UM PUT (uma aprovação); o que já era igual sai em unchanged", async () => {
    const out = await run([...BASE, "--due", "30/10/2026", "--responsible", "bruno reis"]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, dt_due: "2026-10-30 00:00", user_id: 9 });
    expect(out!.summary).toBe("Cartão 55: vencimento 30/10/2026 00:00, responsável Bruno Reis.");

    stdout.length = 0;
    requests.length = 0;
    const second = await run([...BASE, "--due", "30/10/2026", "--responsible", "7"]);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, dt_due: "2026-10-30 00:00" });
    expect(second).toMatchObject({ unchanged: ["O responsável já era Ana Souza."] });
  });

  it("sem --flow-id: o fluxo vem do número do cartão (GET /card/locate) e a saída diz de onde veio", async () => {
    const out = await run(["card", "update", "--card-id", "55", "--due", "30/10/2026"]);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/card/locate" });
    expect(writes()[0]!.body).toMatchObject({ flow_id: 316, id_card: 55 });
    expect(out).toMatchObject({ resolved: { flow_id: 316, via: "card-locate" } });
  });
});

describe("card update --add-tag/--remove-tag (card_link)", () => {
  it("--add-tag pelo nome: POST /flow-tag/card com o id da etiqueta", async () => {
    const out = await run([...BASE, "--add-tag", "quente"]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/flow-tag/card", body: { flow_id: 316, card_id: 55, flow_tag_id: 13 } });
    expect(out).toMatchObject({ changed: { tagAdded: { id: 13, name: "Quente" } }, summary: "Cartão 55: etiqueta Quente adicionada." });
  });

  it("--remove-tag pelo id: DELETE /flow-tag/card com a query que a rota do back lê", async () => {
    const out = await run([...BASE, "--remove-tag", "12"]);
    expect(writes()).toHaveLength(1);
    const call = writes()[0]!;
    expect(call).toMatchObject({ method: "DELETE", path: "/flow-tag/card" });
    expect(Object.fromEntries(call.query)).toEqual({ flow_id: "316", card_id: "55", flow_tag_id: "12" });
    expect(out).toMatchObject({ changed: { tagRemoved: { id: 12, name: "Frio" } } });
  });

  it("etiqueta que o cartão já tem: nada a gravar", async () => {
    const out = await run([...BASE, "--add-tag", "Frio"]);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({ noop: true, unchanged: ["A etiqueta Frio já estava no cartão."] });
  });

  it("etiqueta inexistente: lista as do fluxo, nunca cria, nada gravado", async () => {
    await run([...BASE, "--add-tag", "Morno"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toBe(
      'Etiqueta "Morno" não existe no fluxo CNG CRM. Etiquetas do fluxo: Frio, Quente. O kit não cria etiqueta; nada foi gravado.'
    );
  });

  it("fluxo sem etiquetas: diz quem cria", async () => {
    tagsBody = [];
    await run([...BASE, "--add-tag", "Quente"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage()).toBe(
      "O fluxo CNG CRM não tem etiquetas. Quem administra o fluxo cria na tela do fluxo; nada foi gravado."
    );
  });

  it("duas etiquetas no mesmo comando: exit 2 com um comando pronto por etiqueta, sem ler nada", async () => {
    await run([...BASE, "--add-tag", "Quente", "--remove-tag", "Frio"]);
    expect(process.exitCode).toBe(2);
    expect(requests).toEqual([]);
    expect(errorMessage()).toBe(
      [
        "Uma etiqueta por comando: rode um comando para cada.",
        'cange card update --card-id 55 --add-tag "Quente"',
        'cange card update --card-id 55 --remove-tag "Frio"'
      ].join("\n")
    );
  });

  it("a mesma flag repetida também é recusada", async () => {
    await run([...BASE, "--add-tag", "Quente", "--add-tag", "Frio"]);
    expect(process.exitCode).toBe(2);
    expect(errorMessage().split("\n")[0]).toBe("Uma etiqueta por comando: rode um comando para cada.");
  });

  it("etiqueta junto com vencimento: outra permissão, dois comandos prontos", async () => {
    await run([...BASE, "--due", "30/10/2026", "--add-tag", "Quente"]);
    expect(process.exitCode).toBe(2);
    expect(requests).toEqual([]);
    expect(errorMessage()).toBe(
      [
        "Etiqueta usa outra permissão (Vincular/rotular): rode em dois comandos.",
        'cange card update --card-id 55 --due "30/10/2026"',
        'cange card update --card-id 55 --add-tag "Quente"'
      ].join("\n")
    );
  });

  it("sem nada para mudar: exit 2 com o exemplo", async () => {
    await run([...BASE]);
    expect(process.exitCode).toBe(2);
    expect(requests).toEqual([]);
    expect(errorMessage()).toBe(
      "Informe o que mudar: --due, --responsible, --add-tag ou --remove-tag (ex.: cange card update --card-id 123 --due 27/10/2026)."
    );
  });
});

describe("card update --dry-run (contrato C3 com o gate)", () => {
  it("vencimento + responsável: 1 call PUT /card, action card_update, só as chaves que mudam", async () => {
    const out = await run([...BASE, "--due", "30/10/2026", "--responsible", "Bruno", "--dry-run"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({
      dryRun: true,
      executed: false,
      cardId: 55,
      flowId: 316,
      unchanged: [],
      validation: { valid: true },
      calls: [
        {
          call: "PUT /card",
          action: "card_update",
          payload: {
            flowId: 316,
            cardId: 55,
            dtDue: "2026-10-30 00:00",
            dueLabel: "30/10/2026 00:00",
            userId: 9,
            responsibleName: "Bruno Reis"
          }
        }
      ]
    });
    expect(Object.keys(out!.calls[0].payload).sort()).toEqual(
      ["cardId", "dtDue", "dueLabel", "flowId", "responsibleName", "userId"].sort()
    );
  });

  it("etiqueta: 1 call card_link (POST ou DELETE)", async () => {
    const add = await run([...BASE, "--add-tag", "Quente", "--dry-run"]);
    expect(add!.calls).toEqual([
      { call: "POST /flow-tag/card", action: "card_link", payload: { flowId: 316, cardId: 55, flowTagId: 13, tagName: "Quente" } }
    ]);
    stdout.length = 0;
    const remove = await run([...BASE, "--remove-tag", "Frio", "--dry-run"]);
    expect(remove!.calls).toEqual([
      { call: "DELETE /flow-tag/card", action: "card_link", payload: { flowId: 316, cardId: 55, flowTagId: 12, tagName: "Frio" } }
    ]);
    expect(writes()).toEqual([]);
  });

  it("limpar vencimento: dtDue e dueLabel null", async () => {
    const out = await run([...BASE, "--due", "limpar", "--dry-run"]);
    expect(out!.calls[0].payload).toEqual({ flowId: 316, cardId: 55, dtDue: null, dueLabel: null });
  });

  it("nada muda: calls [] e noop", async () => {
    const out = await run([...BASE, "--due", "27/10/2026", "--dry-run"]);
    expect(out).toMatchObject({ dryRun: true, executed: false, calls: [], noop: true, unchanged: ["O vencimento já era 27/10/2026 00:00."] });
  });

  it("inválido: exit 2 com validation.message e calls []", async () => {
    const out = await run([...BASE, "--add-tag", "Morno", "--dry-run"]);
    expect(process.exitCode).toBe(2);
    expect(out).toMatchObject({ dryRun: true, executed: false, calls: [], validation: { valid: false } });
    expect(out!.validation.message).toContain('Etiqueta "Morno" não existe no fluxo CNG CRM.');
  });

  it("CANGE_FORCE_DRY_RUN sem --dry-run: o mesmo plano, nada gravado", async () => {
    process.env.CANGE_FORCE_DRY_RUN = "1";
    const out = await run([...BASE, "--due", "30/10/2026", "--validate-fields"]);
    expect(writes()).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, executed: false, calls: [{ call: "PUT /card", action: "card_update" }] });
  });
});

describe("card update --payload (avançado)", () => {
  async function payloadFile(content: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-v9-"));
    const file = path.join(dir, "payload.json");
    await fs.writeFile(file, JSON.stringify(content));
    return file;
  }

  it("flowTagId no arquivo: exit 2 apontando o --add-tag (acabou o falso sucesso)", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, flowTagId: 13 });
    await run(["card", "update", "--payload", file]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toBe(
      'card update não grava etiqueta pelo flowTagId (o Cange ignora esse campo). Use cange card update --card-id 55 --add-tag "<etiqueta>".'
    );
  });

  it("flowTagId junto com outro campo também é recusado (nada gravado)", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, complete: "S", flowTagId: 13 });
    await run(["card", "update", "--payload", file]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
  });

  it("o resto do modo --payload segue igual (complete, userId null)", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, complete: "S", userId: null });
    await run(["card", "update", "--payload", file]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(writes()[0]!.body).toEqual({ flow_id: 316, id_card: 55, user_id: null, complete: "S" });
  });

  it("--payload com as opções inline: erro de uso", async () => {
    const file = await payloadFile({ flowId: 316, cardId: 55, complete: "S" });
    await run(["card", "update", "--payload", file, "--due", "hoje"]);
    expect(process.exitCode).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe("régua de responsável e etiqueta (unidade)", () => {
  const users = USERS.map((user) => ({ id: user.id_user, name: user.name, email: user.email, flowUserType: user.flow_user_type }));

  it("id, e-mail, nome exato sem acento e trecho único", () => {
    expect(pickResponsible("#9", users)).toEqual({ ok: true, user: { id: 9, name: "Bruno Reis" } });
    expect(pickResponsible("LIMA@acme.com", users)).toEqual({ ok: true, user: { id: 8, name: "Ana Lima" } });
    expect(pickResponsible("ana souza", users)).toEqual({ ok: true, user: { id: 7, name: "Ana Souza" } });
    expect(pickResponsible("brun", users)).toEqual({ ok: true, user: { id: 9, name: "Bruno Reis" } });
    expect(pickResponsible("x", users, 99)).toMatchObject({ ok: false });
  });

  it("etiqueta pelo nome sem acento/caixa, pelo id ou trecho único; ambígua diz quais", () => {
    const tags = [
      { id: 1, name: "Prioridade alta" },
      { id: 2, name: "Prioridade média" },
      { id: 3, name: "Urgente" }
    ];
    expect(resolveTag("URGENTE", tags, "F")).toEqual({ ok: true, tag: tags[2] });
    expect(resolveTag("2", tags, "F")).toEqual({ ok: true, tag: tags[1] });
    expect(resolveTag("prioridade media", tags, "F")).toEqual({ ok: true, tag: tags[1] });
    expect(resolveTag("prioridade", tags, "F")).toMatchObject({
      ok: false,
      error: 'Etiqueta "prioridade" é ambígua no fluxo F: Prioridade alta (id 1), Prioridade média (id 2). Use o nome inteiro ou o id; nada foi gravado.'
    });
  });
});

describe("card read enxuto: due, responsible e tags sempre presentes", () => {
  it("cartão com vencimento, responsável e etiqueta", async () => {
    const out = await run(["card", "read", "--card-id", "55", "--flow-id", "316"]);
    expect(out).toMatchObject({
      due: "27/10/2026 00:00",
      responsible: { id: 7, name: "Ana Souza" },
      tags: [{ id: 12, name: "Frio" }]
    });
    expect(out).not.toHaveProperty("dueDate");
    expect(out).not.toHaveProperty("responsibleUserId");
    expect(out).not.toHaveProperty("responsibleName");
  });

  it("cartão sem nada: null, null e [] (vazio não some da saída)", async () => {
    cardBody = { id_card: 56, flow_id: 316, flow_step_id: 1, title: "Vazio", dt_due: null, user_id: null, card_flow_tags: [] };
    const out = await run(["card", "read", "--card-id", "56", "--flow-id", "316"]);
    expect(out).toMatchObject({ due: null, responsible: null, tags: [] });
    expect(out).toHaveProperty("due", null);
    expect(out).toHaveProperty("responsible", null);
  });

  it("no lote também", async () => {
    const out = await run(["card", "read", "--flow-id", "316", "--card-ids", "55"]);
    expect(out!.cards[0]).toMatchObject({ due: "27/10/2026 00:00", responsible: { id: 7 }, tags: [{ id: 12, name: "Frio" }] });
  });
});

describe("comment create --mention eu", () => {
  it("eu = quem conversa (RUNNER_SPEAKER_USER_ID)", async () => {
    process.env.RUNNER_SPEAKER_USER_ID = "9";
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, query: url.searchParams, body });
      if (url.pathname === "/user/by-company") return json(USERS);
      if (url.pathname === "/card-comment") return json({ id_card_comment: 1 });
      return json({}, 404);
    });
    const out = await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "Feito", "--mention", "eu"]);
    expect(out).toMatchObject({ ok: true, mentions: [9] });
    expect(writes()[0]!.body).toMatchObject({ mentions: [9] });
  });

  it("fora de conversa: exit 2, nada gravado", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ method, path: url.pathname, query: url.searchParams });
      if (url.pathname === "/user/by-company") return json(USERS);
      return json({}, 404);
    });
    await run(["comment", "create", "--card-id", "55", "--flow-id", "316", "--text", "Feito", "--mention", "eu"]);
    expect(process.exitCode).toBe(2);
    expect(writes()).toEqual([]);
    expect(errorMessage()).toContain('"eu" só vale numa conversa');
  });
});
