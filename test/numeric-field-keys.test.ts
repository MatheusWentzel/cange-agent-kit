import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";

/**
 * R5-KR-03 (01/10): o `map` e o `card read` enxutos mostram o id numérico do
 * campo, sem o hash. O `card create`, o `update-values` e o `move` já traduziam
 * id → hash; o `card add-child` e o `register create/update` não. O add-child cria
 * o filho e só depois vincula (sem transação): um linkField numérico falhava no
 * PUT e deixava o filho órfão no fluxo do cliente. Agora a tradução acontece
 * ANTES de qualquer escrita, e id inexistente falha sem POST.
 */

const envBackup = { ...process.env };
const HASH = (c: string) => c.repeat(40);
const stdout: string[] = [];
const stderr: string[] = [];
const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown }> = [];
let dir = "";

const FIELDS_BY_FLOW: Record<string, unknown[]> = {
  // fluxo pai: campo de vínculo "Meus Fluxos" (id 11)
  "316": [{ id_field: 11, name: HASH("k"), title: "Marcos", type: "COMBO_BOX_FLOW_FIELD", form_id: 900, flow_id: 317 }],
  // fluxo filho: campo de texto (id 20)
  "317": [{ id_field: 20, name: HASH("t"), title: "Nome do marco", type: "TEXT_SHORT_FIELD", form_id: 901 }]
};

const FIELDS_BY_REGISTER: Record<string, unknown[]> = {
  "175": [{ id_field: 30, name: HASH("r"), title: "Fornecedor", type: "TEXT_SHORT_FIELD", form_id: 2881 }]
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  stdout.length = 0;
  stderr.length = 0;
  requests.length = 0;
  dir = await mkdtemp(join(tmpdir(), "kit-numeric-keys-"));
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
    if (method === "GET" && url.pathname === "/field/by-flow") {
      return json(FIELDS_BY_FLOW[url.searchParams.get("flow_id") ?? ""] ?? []);
    }
    if (method === "GET" && url.pathname === "/field/by-register") {
      return json(FIELDS_BY_REGISTER[url.searchParams.get("register_id") ?? ""] ?? []);
    }
    if (method === "POST" && url.pathname === "/form/new-answer") return json({ id_card: 5005 });
    if (method === "PUT" && url.pathname === "/form/answer") return json({ ok: true });
    return json({ message: `rota não mockada: ${method} ${url.pathname}` }, 404);
  });
});

afterEach(async () => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function payloadFile(name: string, content: unknown): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

async function run(args: string[]): Promise<string> {
  await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  return stdout.join("");
}

function writes(): typeof requests {
  return requests.filter((r) => r.method !== "GET");
}

function addChildPayload(linkField: string, childValues: Record<string, unknown>) {
  return {
    child: { flowId: 317, idForm: 901, origin: "/cange-agent-kit", values: childValues },
    parent: { flowId: 316, cardId: 900, idForm: 900, linkField, existingChildIds: [4001] }
  };
}

describe("card add-child: id numérico do campo vira hash antes de criar o filho", () => {
  it("child.values pelo fluxo filho e linkField pelo fluxo pai", async () => {
    const file = await payloadFile("child.json", addChildPayload("11", { "20": "Marco 1", [HASH("x")]: "mantido" }));
    await run(["card", "add-child", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    const [post, put] = writes();
    expect(post?.path).toBe("/form/new-answer");
    expect((post?.body as { values: unknown }).values).toEqual({ [HASH("t")]: "Marco 1", [HASH("x")]: "mantido" });
    expect(put?.path).toBe("/form/answer");
    expect((put?.body as { values: unknown }).values).toEqual({ [HASH("k")]: [4001, 5005] });
    // cada fluxo foi consultado pelo próprio id
    const flowsQueried = requests.filter((r) => r.path === "/field/by-flow").map((r) => r.query.get("flow_id"));
    expect(flowsQueried.sort()).toEqual(["316", "317"]);
  });

  it("linkField numérico que não existe no fluxo pai falha ANTES do POST (nenhum filho órfão)", async () => {
    const file = await payloadFile("child.json", addChildPayload("99", { "20": "Marco 1" }));
    await run(["card", "add-child", "--payload", file]);

    expect(process.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(process.exitCode).toBeDefined();
    expect(writes()).toEqual([]);
    expect(stderr.join("")).toContain('Chave numérica \\"99\\"');
  });

  it("values do filho com id inexistente também falha antes do POST", async () => {
    const file = await payloadFile("child.json", addChildPayload("11", { "77": "x" }));
    await run(["card", "add-child", "--payload", file]);

    expect(process.exitCode).toBeDefined();
    expect(writes()).toEqual([]);
  });

  it("hash já no payload: 1 leitura dos campos do filho para converter (N-3), nenhuma do pai", async () => {
    const file = await payloadFile("child.json", addChildPayload(HASH("k"), { [HASH("t")]: "Marco 1" }));
    await run(["card", "add-child", "--payload", file]);

    // N-3 (2ª rodada do Alex): o payload só de hash também é convertido (K-01), ao custo de 1 GET.
    expect(requests.filter((r) => r.path === "/field/by-flow")).toHaveLength(1);
    expect((writes()[0]?.body as { values: unknown }).values).toEqual({ [HASH("t")]: "Marco 1" });
    expect((writes()[1]?.body as { values: unknown }).values).toEqual({ [HASH("k")]: [4001, 5005] });
  });

  it("--dry-run mostra o linkField já traduzido e não grava", async () => {
    const file = await payloadFile("child.json", addChildPayload("11", { "20": "Marco 1" }));
    const out = JSON.parse(await run(["card", "add-child", "--payload", file, "--dry-run"]));

    expect(writes()).toEqual([]);
    expect(out.payload.parent.linkField).toBe(HASH("k"));
    expect(out.payload.child.values).toEqual({ [HASH("t")]: "Marco 1" });
    expect(out.payload.preview.willLinkOnParentField).toBe(HASH("k"));
  });
});

describe("register create/update: id numérico do campo vira hash pelos fields do cadastro", () => {
  it("register create traduz pelo registerId do payload", async () => {
    const file = await payloadFile("reg.json", {
      idForm: 2881,
      origin: "/cange-agent-kit",
      registerId: 175,
      values: { "30": "ACME LTDA" }
    });
    await run(["register", "create", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(requests.find((r) => r.path === "/field/by-register")?.query.get("register_id")).toBe("175");
    expect((writes()[0]?.body as { values: unknown }).values).toEqual({ [HASH("r")]: "ACME LTDA" });
  });

  it("register create com id inexistente falha antes do POST", async () => {
    const file = await payloadFile("reg.json", {
      idForm: 2881,
      origin: "/cange-agent-kit",
      registerId: 175,
      values: { "31": "x" }
    });
    await run(["register", "create", "--payload", file]);

    expect(process.exitCode).toBeDefined();
    expect(writes()).toEqual([]);
  });

  it("register update traduz pelo registerId", async () => {
    const file = await payloadFile("upd.json", { idForm: 2881, registerId: 175, formAnswerId: 8, values: { "30": "Nova" } });
    await run(["register", "update", "--payload", file]);

    expect(process.exitCode ?? 0).toBe(0);
    expect((writes()[0]?.body as { values: unknown }).values).toEqual({ [HASH("r")]: "Nova" });
  });

  it("register update só com formAnswerId e chave numérica: erro de uso, sem PUT", async () => {
    const file = await payloadFile("upd.json", { idForm: 2881, formAnswerId: 8, values: { "30": "Nova" } });
    await run(["register", "update", "--payload", file]);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(writes()).toEqual([]);
    expect(stderr.join("")).toContain("registerId");
  });
});
