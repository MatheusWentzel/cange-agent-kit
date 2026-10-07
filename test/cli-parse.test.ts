import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.restoreAllMocks();
});

describe("cli parsing", () => {
  it("registers required top-level commands", () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain("my-flows");
    expect(commandNames).toContain("my-registers");
    expect(commandNames).toContain("my-tasks");
    expect(commandNames).toContain("step-form");
    expect(commandNames).toContain("notifications");
    expect(commandNames).toContain("notification");
    expect(commandNames).toContain("card");
    expect(commandNames).toContain("register");
    expect(commandNames).toContain("template");
  });

  it("registers card get field filter and template step-move command", () => {
    const program = createProgram();

    const cardCommand = program.commands.find((command) => command.name() === "card");
    expect(cardCommand).toBeDefined();

    const cardGet = cardCommand?.commands.find((command) => command.name() === "get");
    expect(cardGet).toBeDefined();
    const hasFieldIdsOption = cardGet?.options.some((option) => option.long === "--field-ids");
    expect(hasFieldIdsOption).toBe(true);
    const hasSummaryOnly = cardGet?.options.some((option) => option.long === "--summary-only");
    expect(hasSummaryOnly).toBe(true);

    const templateCommand = program.commands.find((command) => command.name() === "template");
    expect(templateCommand).toBeDefined();
    const templateStepMove = templateCommand?.commands.find((command) => command.name() === "step-move");
    expect(templateStepMove).toBeDefined();

    const moveStepWithValues = cardCommand?.commands.find(
      (command) => command.name() === "move-step-with-values"
    );
    expect(moveStepWithValues).toBeDefined();
    const hasDiscoverRequired = moveStepWithValues?.options.some(
      (option) => option.long === "--discover-required"
    );
    expect(hasDiscoverRequired).toBe(true);
  });

  it("registers my-tasks filters for flow and step", () => {
    const program = createProgram();
    const myTasks = program.commands.find((command) => command.name() === "my-tasks");
    expect(myTasks).toBeDefined();

    const hasFlowId = myTasks?.options.some((option) => option.long === "--flow-id");
    const hasStepId = myTasks?.options.some((option) => option.long === "--step-id");

    expect(hasFlowId).toBe(true);
    expect(hasStepId).toBe(true);
  });

  it("runs card create in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-card-create-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          idForm: 662,
          flowId: 192,
          origin: "/cange-agent-kit",
          values: {
            customer_name: "ACME LTDA"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "card",
        "create",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\":true");
    expect(output).toContain("\"executed\":false");
  });

  it("runs card move-step-with-values in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    // O dry-run do mover LÊ o fluxo e o cartão (tradução de campos e checagem de
    // perda de dados). Sem mock, o teste batia em api.cange.me (produção) e
    // estourava os 5 s quando a rede demorava. Rotas fixas; qualquer outra URL falha.
    const MOCKED_ROUTES: Record<string, unknown> = {
      // Decisão 1 (06/10): o mover confere os obrigatórios da etapa atual (lê o fluxo).
      "GET /flow": {
        id_flow: 192,
        form_init_id: 600,
        flow_steps: [
          { id_step: 11, name: "Origem", form_id: 662, index: 1 },
          { id_step: 12, name: "Destino", form_id: 663, index: 2, isEndStep: "1" }
        ]
      },
      "GET /field/by-flow": [
        { id_field: 501, name: "customer_name", title: "Cliente", type: "TEXT_SHORT_FIELD", form_id: 662, required: "0" }
      ],
      "GET /card": {
        id_card: 7,
        flow_id: 192,
        flow_step_id: 11,
        title: "Cartão de teste",
        form_answers: []
      },
      // EXTRA-06 D1: o que o cartão tem na etapa atual vem da pré-resposta (a fonte da tela).
      "GET /form/pre-answer": { fields: [], formsAnswers: null }
    };
    const calledUrls: string[] = [];
    const unmocked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/\/+$/, "")}`;
      calledUrls.push(`${key}${url.search}`);
      if (!(key in MOCKED_ROUTES)) {
        unmocked.push(`${key}${url.search}`);
        return new Response(JSON.stringify({ message: `rota não mockada: ${key}` }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(MOCKED_ROUTES[key]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const payloadPath = join(tmpdir(), `cange-card-move-step-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          flowId: 192,
          cardId: 7,
          fromStepId: 11,
          toStepId: 12,
          idForm: 662,
          values: {
            customer_name: "ACME LTDA"
          },
          complete: "S",
          isFromCurrentStep: true,
          isTestMode: false
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "card",
        "move-step-with-values",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\":true");
    expect(output).toContain("\"executed\":false");
    expect(output).toContain("\"flowId\":192");
    // Nada fora do mock (nem produção) e nenhuma escrita.
    expect(unmocked).toEqual([]);
    expect(calledUrls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  it("runs deprecated card move-step alias with idForm and values", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    // O alias também confere os obrigatórios da etapa atual (decisão 1): lê fluxo, campos e cartão.
    const routes: Record<string, unknown> = {
      "/flow": { id_flow: 192, flow_steps: [{ id_step: 11, name: "Origem", form_id: 662, index: 1 }, { id_step: 12, name: "Destino", form_id: 663, index: 2 }] },
      "/field/by-flow": [{ id_field: 501, name: "customer_name", title: "Cliente", type: "TEXT_SHORT_FIELD", form_id: 662 }],
      "/card": { id_card: 7, flow_id: 192, flow_step_id: 11, form_answers: [] }
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/\/+$/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = method === "GET" ? routes[path] : undefined;
      return new Response(JSON.stringify(body ?? { message: `rota não mockada: ${method} ${path}` }), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/json" }
      });
    });

    const payloadPath = join(tmpdir(), `cange-card-move-step-alias-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          flowId: 192,
          cardId: 7,
          fromStepId: 11,
          toStepId: 12,
          idForm: 662,
          values: {},
          complete: "S",
          isFromCurrentStep: true,
          isTestMode: false
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "card",
        "move-step",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\":true");
    expect(output).toContain("deprecated");
  });

  it("runs card add-label in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-card-add-label-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          flowId: 9000,
          cardId: 210721,
          flowTagId: 15543
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "card",
        "add-label",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\":true");
    expect(output).toContain("\"executed\":false");
    expect(output).toContain("\"flowTagId\":15543");
    expect(output).toContain("\"cardId\":210721");
  });

  it("runs notification read in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-notification-read-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          id_notification: 48107,
          archived: "S"
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "notification",
        "read",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\":true");
    expect(output).toContain("\"executed\":false");
    expect(output).toContain("\"notificationId\":48107");
  });
});
