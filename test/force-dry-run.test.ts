import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CangeCliUsageError } from "../src/client/errors.js";
import { createCangeClient } from "../src/client/http.js";
import { createProgram } from "../src/cli/index.js";
import { FORCE_DRY_RUN_ENV, isForceDryRun, isWriteRequest } from "../src/utils/forceDryRun.js";

// CANGE_FORCE_DRY_RUN=1: o gate do runner roda o MESMO comando do agente para
// conferir. Com o env, nenhuma escrita grava, nem com argv malformado
// (`--text --dry-run`, em que o `--dry-run` vira o valor do texto).

const envBackup = { ...process.env };

function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

const TOKEN = runToken({ id_user: 9995, company_id: 3955, agent_id: 206, run_id: 500, token_type: "agent_run" });

let dir = "";
const file = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cange-force-dry-run-"));
  const payloads: Record<string, unknown> = {
    "card-create.json": { flowId: 192, idForm: 662, origin: "teste", values: {} },
    "card-update.json": { flowId: 192, cardId: 5, complete: "S" },
    "card-update-values.json": { flowId: 192, cardId: 5, idForm: 662, values: { abc: "x" } },
    "card-move.json": { flowId: 192, cardId: 5, fromStepId: 484, toStepId: 485, idForm: 658, values: {} },
    "card-add-label.json": { flowId: 192, cardId: 5, flowTagId: 3 },
    "card-add-child.json": {
      child: { flowId: 193, idForm: 700, origin: "teste", values: {} },
      parent: { flowId: 192, cardId: 5, idForm: 662, linkField: "vinculo" }
    },
    "comment.json": { flowId: 192, cardId: 5, description: "oi", mentions: [] },
    "register-create.json": { registerId: 55, idForm: 700, origin: "teste", values: { abc: "x" } },
    "register-update.json": { registerId: 55, formAnswerId: 9, idForm: 700, values: { abc: "x" } },
    "attachment-link.json": { attachmentId: 1, cardId: 5, flowId: 192 },
    "time-tracking.json": {
      flowId: 192,
      cardId: 5,
      source: "agente",
      dtStart: "2026-10-06T10:00:00Z",
      dtEnd: "2026-10-06T11:00:00Z",
      duration: 3600,
      billable: "N"
    },
    "notification-read.json": { notificationId: 1, archived: "S" },
    "flow-create.json": { workspace_id: 1, name: "F", color: "#fff", icon: "FaBox", isPrivate: "1" },
    "step-create.json": { name: "Etapa", index: 0 },
    "field-create.json": { name: "campo", type: "TEXT_SHORT_FIELD", title: "Campo", index: 0, required: "0" },
    "step-rel.json": { flow_step_id: 1, step_available_id: 2, isActive: "1" },
    "tool-params.json": { q: "x" }
  };
  for (const [name, body] of Object.entries(payloads)) {
    await writeFile(file(name), JSON.stringify(body), "utf8");
  }
  await writeFile(file("artefato.html"), "<h1>Resumo</h1>", "utf8");
  await writeFile(file("anexo.txt"), "conteudo", "utf8");
  await writeFile(file("aprendizado.md"), "Conferir o cartão antes de mover.", "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CANGE_FORCE_DRY_RUN: toda escrita do kit vira dry-run", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; path: string }> = [];

  beforeEach(() => {
    process.env.CANGE_ACCESS_TOKEN = TOKEN;
    process.env[FORCE_DRY_RUN_ENV] = "1";
    process.env.RUNNER_CHAT_SESSION_ID = "113";
    delete process.env.CANGE_OUTPUT_PROFILE;
    stdout.length = 0;
    stderr.length = 0;
    calls.length = 0;
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
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
      // GET genérico com o que o dry-run inline precisa (form_init_id do fluxo). O mover
      // confere os obrigatórios da etapa atual (decisão 1): o fluxo traz as etapas e o
      // cartão está na 484, sem obrigatório no form 658.
      const body = url.pathname.replace(/\/+$/, "") === "/card"
        ? { id_card: 5, flow_id: 192, flow_step_id: 484, form_answers: [] }
        : {
            ok: true,
            warnings: [],
            id_flow: 192,
            form_init_id: 662,
            flow_steps: [
              { id_step: 484, name: "Backlog", form_id: 658, index: 1 },
              { id_step: 485, name: "Priorizados", form_id: 659, index: 2 }
            ]
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  const writes = () => calls.filter((call) => isWriteRequest(call.method, call.path));

  const CASES: Array<[string, () => string[]]> = [
    ["card create", () => ["card", "create", "--payload", file("card-create.json")]],
    ["card create (inline)", () => ["card", "create", "--flow-id", "192", "--values-json", "{}"]],
    ["card update", () => ["card", "update", "--payload", file("card-update.json")]],
    ["card update-values", () => ["card", "update-values", "--payload", file("card-update-values.json")]],
    ["card move-step-with-values", () => ["card", "move-step-with-values", "--payload", file("card-move.json"), "--allow-data-loss"]],
    ["card move-step", () => ["card", "move-step", "--payload", file("card-move.json")]],
    ["card add-label", () => ["card", "add-label", "--payload", file("card-add-label.json")]],
    ["card add-child", () => ["card", "add-child", "--payload", file("card-add-child.json")]],
    ["comment create", () => ["comment", "create", "--payload", file("comment.json")]],
    ["comment create (argv malformado)", () => ["comment", "create", "--flow-id", "192", "--card-id", "5", "--text", "--dry-run"]],
    ["register create", () => ["register", "create", "--payload", file("register-create.json")]],
    ["register update", () => ["register", "update", "--payload", file("register-update.json")]],
    ["attachment upload", () => ["attachment", "upload", "--file", file("anexo.txt")]],
    ["attachment link-card", () => ["attachment", "link-card", "--payload", file("attachment-link.json")]],
    ["time-tracking create", () => ["time-tracking", "create", "--payload", file("time-tracking.json")]],
    ["notification read", () => ["notification", "read", "--payload", file("notification-read.json")]],
    ["artifact publish", () => ["artifact", "publish", "--type", "resumo", "--title", "Resumo", "--file", file("artefato.html")]],
    ["access request", () => ["access", "request", "--flow", "12064", "--reason", "ler"]],
    ["agent head propose", () => ["agent", "head", "propose", "--kind", "aprendizado", "--file", file("aprendizado.md"), "--reason", "pediram"]],
    ["tool call", () => ["tool", "call", "7", "--params", file("tool-params.json")]],
    ["flow-build flow create", () => ["flow-build", "flow", "create", "--payload", file("flow-create.json")]],
    ["flow-build step create", () => ["flow-build", "step", "create", "--id-flow", "1", "--payload", file("step-create.json")]],
    ["flow-build field create", () => ["flow-build", "field", "create", "--id-flow", "1", "--id-step", "2", "--payload", file("field-create.json")]],
    ["flow-build field delete", () => ["flow-build", "field", "delete", "--id-flow", "1", "--id-field", "2", "--id-step", "3"]],
    ["flow-build step-relationship set", () => ["flow-build", "step-relationship", "set", "--id-flow", "1", "--payload", file("step-rel.json")]]
  ];

  it.each(CASES)("%s: sai em dry-run e não chama POST/PUT/PATCH/DELETE", async (_name, argv) => {
    await run(argv());
    // stderr só pode ter aviso (ex.: `card move-step` deprecado), nunca erro.
    expect(stderr.join(""), stderr.join("")).not.toContain('"name"');
    expect(process.exitCode).toBeUndefined();
    const out = stdout.join("");
    expect(out).toContain('"dryRun":true');
    expect(out).toContain('"executed":false');
    expect(writes()).toEqual([]);
  });

  it("toda escrita do kit está coberta (comando com --dry-run ou na lista do forçado)", () => {
    const covered = new Set(CASES.map(([name]) => name.replace(/ \(.*\)$/, "")));
    for (const required of [
      "card create", "card update", "card update-values", "card move-step-with-values", "card add-child",
      "card add-label", "comment create", "register create", "register update", "attachment upload",
      "time-tracking create", "artifact publish", "access request", "agent head propose"
    ]) {
      expect(covered.has(required), required).toBe(true);
    }
  });

  it("leitura segue normal com o env", async () => {
    await run(["my-flows"]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("GET /flow/my-flows");
    expect(stdout.join("")).not.toContain('"dryRun"');
  });

  it("sem o env: comportamento igual (o argv malformado grava, o --dry-run real não)", async () => {
    delete process.env[FORCE_DRY_RUN_ENV];
    await run(["comment", "create", "--flow-id", "192", "--card-id", "5", "--text", "--dry-run"]);
    expect(writes().map((call) => call.path)).toEqual(["/card-comment"]);

    calls.length = 0;
    stdout.length = 0;
    await run(["card", "update", "--payload", file("card-update.json"), "--dry-run"]);
    expect(writes()).toEqual([]);
    expect(stdout.join("")).toContain("--dry-run foi informado");

    calls.length = 0;
    await run(["access", "request", "--flow", "12064", "--reason", "ler"]);
    expect(writes().map((call) => call.path)).toEqual(["/agent-run/access-request"]);
  });
});

describe("rede de segurança no cliente HTTP", () => {
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("com o env, POST/PUT/PATCH/DELETE de escrita falham sem sair do processo; leitura por POST passa", async () => {
    process.env[FORCE_DRY_RUN_ENV] = "1";
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const client = createCangeClient({ baseUrl: "https://api.test", appOrigin: "https://app.test", fetchFn });

    for (const call of [
      () => client.post("/card-comment", { body: {} }),
      () => client.put("/form/answer", { body: {} }),
      () => client.patch("/flow/v2/build/flows/1", { body: {} }),
      () => client.delete("/flow/v2/build/flows/1/fields/2")
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CangeCliUsageError);
      expect((error as Error).message).toContain("CANGE_FORCE_DRY_RUN");
    }
    expect(fetchFn).not.toHaveBeenCalled();

    await client.post("/flow/v2/query", { body: {} });
    await client.get("/card");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("isForceDryRun: 1/true/sim ligam; vazio/0/false desligam", () => {
    for (const on of ["1", "true", "sim", "S"]) expect(isForceDryRun({ [FORCE_DRY_RUN_ENV]: on })).toBe(true);
    for (const off of ["", "0", "false", "no", "off"]) expect(isForceDryRun({ [FORCE_DRY_RUN_ENV]: off })).toBe(false);
    expect(isForceDryRun({})).toBe(false);
  });
});
