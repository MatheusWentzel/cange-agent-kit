import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";
import { createFlowV2BuildContracts } from "../src/contracts/flowV2Build.js";
import type { CangeClient } from "../src/client/http.js";
import {
  FIELD_TYPES_FOR_API,
  NO_ANSWER_FIELD_TYPES,
  createFieldPayloadSchema,
  createFlowPayloadSchema,
  createStepPayloadSchema,
  patchFieldPayloadSchema,
  reorderStepPayloadSchema,
  stepRelationshipBodySchema,
  updateFlowPayloadSchema,
  updateStepPayloadSchema
} from "../src/schemas/flowV2Build.js";

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.restoreAllMocks();
});

describe("flow-v2-build schemas", () => {
  it("rejects unknown keys on createFlow body (strict)", () => {
    const result = createFlowPayloadSchema.safeParse({
      name: "Fluxo",
      flow_id: 123
    });
    expect(result.success).toBe(false);
  });

  it("accepts a minimal createFlow body", () => {
    const result = createFlowPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects empty updateFlow body", () => {
    const result = updateFlowPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts company_email_config_id null on updateFlow", () => {
    const result = updateFlowPayloadSchema.safeParse({ company_email_config_id: null });
    expect(result.success).toBe(true);
  });

  it("requires name on createStep", () => {
    const result = createStepPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty updateStep body", () => {
    const result = updateStepPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("validates reorderStep payload", () => {
    expect(reorderStepPayloadSchema.safeParse({ id_step: 5, upDown: "up" }).success).toBe(true);
    expect(reorderStepPayloadSchema.safeParse({ id_step: 5, upDown: "sideways" }).success).toBe(
      false
    );
  });

  it("requires options[] for COMBO_BOX_FIELD", () => {
    const result = createFieldPayloadSchema.safeParse({
      name: "segmento",
      type: "COMBO_BOX_FIELD",
      title: "Segmento",
      index: 0
    });
    expect(result.success).toBe(false);
  });

  it("rejects '[' or ']' in FORMULA_FIELD formula", () => {
    const result = createFieldPayloadSchema.safeParse({
      name: "valor",
      type: "FORMULA_FIELD",
      title: "Valor",
      index: 0,
      formula: "soma[a, b]"
    });
    expect(result.success).toBe(false);
  });

  it("rejects required='1' on TITLE_FIELD", () => {
    const result = createFieldPayloadSchema.safeParse({
      name: "secao",
      type: "TITLE_FIELD",
      title: "Seção",
      index: 0,
      required: "1"
    });
    expect(result.success).toBe(false);
  });

  it("accepts required='0' on layout-only fields", () => {
    for (const type of NO_ANSWER_FIELD_TYPES) {
      const result = createFieldPayloadSchema.safeParse({
        name: `layout_${type.toLowerCase()}`,
        type,
        title: "rotulo",
        index: 0,
        required: "0"
      });
      expect(result.success, `falhou para ${type}`).toBe(true);
    }
  });

  it("rejects validations type=required on layout-only fields", () => {
    const result = createFieldPayloadSchema.safeParse({
      name: "divider",
      type: "DIVIDER_FIELD",
      title: "div",
      index: 0,
      required: "0",
      validations: [{ type: "required", params: "" }]
    });
    expect(result.success).toBe(false);
  });

  it("accepts patch with single key but rejects type change", () => {
    const ok = patchFieldPayloadSchema.safeParse({ title: "novo" });
    expect(ok.success).toBe(true);

    // strict object rejects unknown 'type' key (mirrors API: tipo imutavel)
    const change = patchFieldPayloadSchema.safeParse({ type: "TEXT_LONG_FIELD" });
    expect(change.success).toBe(false);

    const empty = patchFieldPayloadSchema.safeParse({});
    expect(empty.success).toBe(false);
  });

  it("validates step-relationship body", () => {
    const ok = stepRelationshipBodySchema.safeParse({
      flow_step_id: 1,
      step_available_id: 2,
      isActive: "1"
    });
    expect(ok.success).toBe(true);

    const wrong = stepRelationshipBodySchema.safeParse({
      flow_step_id: 1,
      step_available_id: 2,
      isActive: "S"
    });
    expect(wrong.success).toBe(false);

    const extra = stepRelationshipBodySchema.safeParse({
      flow_id: 9,
      flow_step_id: 1,
      step_available_id: 2,
      isActive: "1"
    });
    expect(extra.success).toBe(false);
  });

  it("exposes FIELD_TYPES_FOR_API catalog", () => {
    expect(FIELD_TYPES_FOR_API).toContain("TEXT_SHORT_FIELD");
    expect(FIELD_TYPES_FOR_API).toContain("DIVIDER_FIELD");
    expect(FIELD_TYPES_FOR_API as readonly string[]).not.toContain("PASSWORD_FIELD");
    expect(FIELD_TYPES_FOR_API as readonly string[]).not.toContain("COMBO_BOX_REGISTER_FIELD");
    expect(FIELD_TYPES_FOR_API as readonly string[]).not.toContain("COMBO_BOX_FLOW_FIELD");
  });
});

describe("flow-build CLI registration", () => {
  it("registers flow-build subcommands", () => {
    const program = createProgram();
    const flowBuild = program.commands.find((command) => command.name() === "flow-build");
    expect(flowBuild).toBeDefined();

    const subnames = flowBuild?.commands.map((command) => command.name()) ?? [];
    expect(subnames).toEqual(
      expect.arrayContaining([
        "ping",
        "field-types",
        "flow",
        "step",
        "field",
        "step-relationship"
      ])
    );

    const flow = flowBuild?.commands.find((command) => command.name() === "flow");
    expect(flow?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["create", "update"])
    );

    const step = flowBuild?.commands.find((command) => command.name() === "step");
    expect(step?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["create", "update", "reorder"])
    );

    const field = flowBuild?.commands.find((command) => command.name() === "field");
    expect(field?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["create", "update", "delete", "list"])
    );

    const rel = flowBuild?.commands.find((command) => command.name() === "step-relationship");
    expect(rel?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["list", "from", "set"])
    );
  });
});

describe("flow-build contracts URL paths", () => {
  function mockClient(): {
    client: CangeClient;
    calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }>;
  } {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];
    const record = (method: string) => async (path: string, options?: { body?: unknown; query?: unknown }) => {
      calls.push({ method, path, body: options?.body, query: options?.query });
      return {};
    };
    const client = {
      get: record("GET"),
      post: record("POST"),
      put: record("PUT"),
      patch: record("PATCH"),
      delete: record("DELETE"),
      request: record("REQUEST"),
      setAccessToken: () => {},
      clearAccessToken: () => {},
      getAccessToken: () => undefined
    } as unknown as CangeClient;
    return { client, calls };
  }

  it("builds the correct paths for every endpoint", async () => {
    const { client, calls } = mockClient();
    const contracts = createFlowV2BuildContracts(client);

    await contracts.ping();
    await contracts.listFieldTypes();
    await contracts.getFieldTypeDescriptor({ type: "TEXT_SHORT_FIELD" });
    await contracts.createFlow({ name: "F" });
    await contracts.updateFlow({ idFlow: "11", payload: { name: "G" } });
    await contracts.createStep({ idFlow: 11, payload: { name: "S" } });
    await contracts.updateStep({ idFlow: 11, idStep: 22, payload: { name: "S2" } });
    await contracts.reorderStep({ idFlow: 11, payload: { id_step: 22, upDown: "up" } });
    await contracts.createFieldByStep({
      idFlow: 11,
      idStep: 22,
      payload: { name: "n", type: "TEXT_SHORT_FIELD", title: "T", index: 0 }
    });
    await contracts.createFieldByForm({
      idFlow: 11,
      formId: 33,
      payload: { name: "n", type: "TEXT_SHORT_FIELD", title: "T", index: 0 }
    });
    await contracts.patchFieldByFlow({ idFlow: 11, idField: 44, payload: { title: "x" } });
    await contracts.patchFieldByStep({ idFlow: 11, idStep: 22, idField: 44, payload: { title: "x" } });
    await contracts.patchFieldByForm({ idFlow: 11, formId: 33, idField: 44, payload: { title: "x" } });
    await contracts.deleteFieldByFlow({ idFlow: 11, idField: 44 });
    await contracts.deleteFieldByStep({ idFlow: 11, idStep: 22, idField: 44 });
    await contracts.listStepRelationshipsByFlow({ idFlow: 11 });
    await contracts.listStepRelationshipsFromStep({ idFlow: 11, idStep: 22 });
    await contracts.upsertStepRelationship({
      idFlow: 11,
      payload: { flow_step_id: 1, step_available_id: 2, isActive: "1" }
    });

    const paths = calls.map((c) => `${c.method} ${c.path}`);

    expect(paths).toEqual([
      "GET /flow/v2/build/__ping",
      "GET /flow/v2/build/field-types",
      "GET /flow/v2/build/field-types/TEXT_SHORT_FIELD",
      "POST /flow/v2/build/flows",
      "PATCH /flow/v2/build/flows/11",
      "POST /flow/v2/build/flows/11/steps",
      "PATCH /flow/v2/build/flows/11/steps/22",
      "POST /flow/v2/build/flows/11/steps/reorder",
      "POST /flow/v2/build/flows/11/steps/22/fields",
      "POST /flow/v2/build/flows/11/forms/33/fields",
      "PATCH /flow/v2/build/flows/11/fields/44",
      "PATCH /flow/v2/build/flows/11/steps/22/fields/44",
      "PATCH /flow/v2/build/flows/11/forms/33/fields/44",
      "DELETE /flow/v2/build/flows/11/fields/44",
      "DELETE /flow/v2/build/flows/11/steps/22/fields/44",
      "GET /flow/v2/build/flows/11/step-relationships/by-flow",
      "GET /flow/v2/build/flows/11/step-relationships",
      "POST /flow/v2/build/flows/11/step-relationships"
    ]);

    const fromStepCall = calls.find(
      (c) => c.method === "GET" && c.path === "/flow/v2/build/flows/11/step-relationships"
    );
    expect(fromStepCall?.query).toEqual({ id_step: 22 });

    const relCall = calls.find((c) => c.path === "/flow/v2/build/flows/11/step-relationships" && c.method === "POST");
    expect(relCall?.body).toEqual({ flow_step_id: 1, step_available_id: 2, isActive: "1" });

    const reorderCall = calls.find((c) => c.path === "/flow/v2/build/flows/11/steps/reorder");
    expect(reorderCall?.body).toEqual({ id_step: 22, upDown: "up" });
  });
});

describe("flow-build CR-1 options[].order serialization", () => {
  function mockClient(): {
    client: CangeClient;
    calls: Array<{ method: string; path: string; body?: unknown }>;
  } {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const record = (method: string) => async (path: string, options?: { body?: unknown }) => {
      calls.push({ method, path, body: options?.body });
      return {};
    };
    const client = {
      get: record("GET"),
      post: record("POST"),
      put: record("PUT"),
      patch: record("PATCH"),
      delete: record("DELETE"),
      request: record("REQUEST"),
      setAccessToken: () => {},
      clearAccessToken: () => {},
      getAccessToken: () => undefined
    } as unknown as CangeClient;
    return { client, calls };
  }

  const comboPayload = (order: number | string) => ({
    name: "status",
    type: "COMBO_BOX_FIELD" as const,
    title: "Status",
    index: 0,
    options: [{ value: "1", label: "Aberto", order }]
  });

  it("accepts options[].order as numeric value", () => {
    expect(createFieldPayloadSchema.safeParse(comboPayload(0)).success).toBe(true);
  });

  it("accepts options[].order as numeric string", () => {
    expect(createFieldPayloadSchema.safeParse(comboPayload("0")).success).toBe(true);
  });

  it("rejects options[].order as non-numeric string", () => {
    const parsed = createFieldPayloadSchema.safeParse({
      name: "status",
      type: "COMBO_BOX_FIELD",
      title: "Status",
      index: 0,
      options: [{ value: "1", label: "Aberto", order: "first" }]
    });
    expect(parsed.success).toBe(false);
  });

  it("serializes numeric order to string in the body sent to the server (createFieldByStep)", async () => {
    const { client, calls } = mockClient();
    const contracts = createFlowV2BuildContracts(client);

    await contracts.createFieldByStep({
      idFlow: 11,
      idStep: 22,
      payload: comboPayload(0)
    });

    const call = calls.find((c) => c.method === "POST");
    const body = call?.body as { options?: Array<{ order?: unknown }> };
    expect(body?.options?.[0]?.order).toBe("0");
    expect(typeof body?.options?.[0]?.order).toBe("string");
  });

  it("serializes numeric order to string in the body sent to the server (createFieldByForm)", async () => {
    const { client, calls } = mockClient();
    const contracts = createFlowV2BuildContracts(client);

    await contracts.createFieldByForm({
      idFlow: 11,
      formId: 33,
      payload: {
        name: "prioridade",
        type: "RADIO_BOX_FIELD",
        title: "Prioridade",
        index: 1,
        options: [
          { value: "1", label: "Alta", order: 0 },
          { value: "2", label: "Baixa", order: 1 }
        ]
      }
    });

    const call = calls.find((c) => c.method === "POST");
    const body = call?.body as { options?: Array<{ order?: unknown }> };
    expect(body?.options?.map((o) => o.order)).toEqual(["0", "1"]);
  });

  it("serializes numeric order to string on patch (update of combo options)", async () => {
    const { client, calls } = mockClient();
    const contracts = createFlowV2BuildContracts(client);

    await contracts.patchFieldByFlow({
      idFlow: 11,
      idField: 44,
      payload: {
        options: [{ value: "1", label: "Aberto", order: 2 }]
      }
    });

    const call = calls.find((c) => c.method === "PATCH");
    const body = call?.body as { options?: Array<{ order?: unknown }> };
    expect(body?.options?.[0]?.order).toBe("2");
  });

  it("keeps options without order untouched (server fills by position)", async () => {
    const { client, calls } = mockClient();
    const contracts = createFlowV2BuildContracts(client);

    await contracts.createFieldByStep({
      idFlow: 11,
      idStep: 22,
      payload: {
        name: "status",
        type: "COMBO_BOX_FIELD",
        title: "Status",
        index: 0,
        options: [{ value: "1", label: "Aberto" }]
      }
    });

    const call = calls.find((c) => c.method === "POST");
    const body = call?.body as { options?: Array<{ order?: unknown }> };
    expect(body?.options?.[0]).not.toHaveProperty("order");
  });
});

describe("flow-build CLI dry-run", () => {
  it("runs flow create in dry-run without auth", async () => {
    delete process.env.CANGE_ACCESS_TOKEN;

    const payloadPath = join(tmpdir(), `cange-flow-build-flow-create-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          workspace_id: 1234,
          name: "Onboarding",
          isPrivate: "1",
          isAllowedArchive: "S",
          isAllowedDelete: "S"
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
        "flow-build",
        "flow",
        "create",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain('"dryRun": true');
    expect(output).toContain('"executed": false');
    expect(output).toContain('"name": "Onboarding"');
  });

  it("runs step-relationship set in dry-run", async () => {
    delete process.env.CANGE_ACCESS_TOKEN;

    const payloadPath = join(tmpdir(), `cange-flow-build-rel-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        { flow_step_id: 1, step_available_id: 2, isActive: "0" },
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
        "flow-build",
        "step-relationship",
        "set",
        "--id-flow",
        "999",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain('"dryRun": true');
    expect(output).toContain('"executed": false');
    expect(output).toContain('"idFlow": "999"');
    expect(output).toContain('"isActive": "0"');
  });

  it("rejects field create when both --id-step and --form-id are provided", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-flow-build-field-conflict-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          name: "x",
          type: "TEXT_SHORT_FIELD",
          title: "x",
          index: 0
        },
        null,
        2
      ),
      "utf8"
    );

    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevExitCode = process.exitCode;

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "flow-build",
        "field",
        "create",
        "--id-flow",
        "100",
        "--id-step",
        "200",
        "--form-id",
        "300",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("apenas um");
    process.exitCode = prevExitCode;
  });

  it("rejects field create when neither --id-step nor --form-id is provided", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-flow-build-field-missing-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        { name: "x", type: "TEXT_SHORT_FIELD", title: "x", index: 0 },
        null,
        2
      ),
      "utf8"
    );

    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevExitCode = process.exitCode;

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "flow-build",
        "field",
        "create",
        "--id-flow",
        "100",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("--id-step ou --form-id");
    process.exitCode = prevExitCode;
  });

  it("runs field create with --form-id in dry-run", async () => {
    delete process.env.CANGE_ACCESS_TOKEN;

    const payloadPath = join(tmpdir(), `cange-flow-build-field-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          name: "customer_name",
          type: "TEXT_SHORT_FIELD",
          title: "Nome do cliente",
          index: 0,
          required: "1"
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
        "flow-build",
        "field",
        "create",
        "--id-flow",
        "100",
        "--form-id",
        "200",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain('"dryRun": true');
    expect(output).toContain('"formId": "200"');
    expect(output).toContain('"type": "TEXT_SHORT_FIELD"');
  });
});
