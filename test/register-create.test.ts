import { describe, expect, it, vi } from "vitest";

import { createPayloadBuilderContracts } from "../src/contracts/payload-builder.js";
import { createRegistersContracts } from "../src/contracts/registers.js";
import { createRegisterPayloadSchema } from "../src/schemas/registers.js";
import type { CangeClient } from "../src/client/http.js";
import type { FieldsContracts } from "../src/contracts/fields.js";
import type { FlowsContracts } from "../src/contracts/flows.js";
import type { RegistersContracts } from "../src/contracts/registers.js";
import type { NormalizedField } from "../src/schemas/fields.js";

// Regressão do bug de 2026-09-15: o createRegister mandava o id do cadastro
// aninhado em `registerContext`, chave que o backend não lê. Toda criação de
// registro morria em 404 "Parâmetros inválidos, não foi possível encontrar a
// referência do formulário!" — o mesmo erro de um id_form inexistente, porque
// POST /form/new-answer decide por `register_id`/`flow_id` na RAIZ do body
// antes de resolver o formulário.

function createMockClient(): CangeClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    getAccessToken: vi.fn()
  };
}

describe("register create", () => {
  it("manda register_id ACHATADO na raiz do body (nunca registerContext)", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({});

    await createRegistersContracts(client).createRegister({
      idForm: 2881,
      origin: "/cange-agent-kit",
      values: { supplier_name: "ACME LTDA" },
      registerId: 175
    });

    expect(client.post).toHaveBeenCalledWith("/form/new-answer", {
      body: {
        id_form: 2881,
        origin: "/cange-agent-kit",
        values: { supplier_name: "ACME LTDA" },
        register_id: 175
      }
    });

    const firstCall = vi.mocked(client.post).mock.calls[0];
    expect(firstCall?.[1]?.body).not.toHaveProperty("registerContext");
  });

  it("aceita registerId como string numérica e envia number", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({});

    await createRegistersContracts(client).createRegister({
      idForm: 3500,
      origin: "/cange-agent-kit",
      values: { group_name: "ABM" },
      registerId: "238"
    });

    expect(client.post).toHaveBeenCalledWith("/form/new-answer", {
      body: {
        id_form: 3500,
        origin: "/cange-agent-kit",
        values: { group_name: "ABM" },
        register_id: 238
      }
    });
  });

  it("rejeita payload sem registerId no schema, antes de chamar a API", async () => {
    const client = createMockClient();
    const registers = createRegistersContracts(client);

    const parsed = createRegisterPayloadSchema.safeParse({
      idForm: 2881,
      origin: "/cange-agent-kit",
      values: { supplier_name: "ACME LTDA" }
    });
    expect(parsed.success).toBe(false);

    await expect(
      registers.createRegister({
        idForm: 2881,
        origin: "/cange-agent-kit",
        values: { supplier_name: "ACME LTDA" }
      } as unknown as Parameters<RegistersContracts["createRegister"]>[0])
    ).rejects.toThrow(/Payload inválido para createRegister/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("gera o payloadSkeleton do template com o registerId preenchido", async () => {
    const registerFields: NormalizedField[] = [
      {
        id: 1,
        name: "supplier_name",
        title: "Nome",
        type: "TEXT_SHORT_FIELD",
        required: true,
        formId: 2881,
        raw: {}
      }
    ];

    const flows: FlowsContracts = {
      getFlow: async () => ({ raw: {}, summary: { id: 192, formInitId: 662 } })
    };

    const fields: FieldsContracts = {
      getFieldsByFlow: async () => ({
        raw: {},
        fields: [],
        summary: { total: 0, requiredCount: 0, groupedByFormId: {}, items: [] }
      }),
      getFieldsByRegister: async () => ({
        raw: {},
        fields: registerFields,
        summary: { total: 1, requiredCount: 1, groupedByFormId: {}, items: [] }
      })
    };

    const registers: RegistersContracts = {
      getRegister: async () => ({ raw: {}, summary: { formId: 2881 } }),
      getRegisterFormAnswer: async () => ({ raw: {} }),
      createRegister: async () => ({ raw: {}, summary: {} }),
      updateRegister: async () => ({ raw: {}, summary: {} })
    };

    const template = await createPayloadBuilderContracts({
      flows,
      fields,
      registers
    }).buildRegisterCreationTemplate({ registerId: "175" });

    expect(template.payloadSkeleton).toMatchObject({
      idForm: 2881,
      registerId: 175,
      origin: "/cange-agent-kit",
      values: { supplier_name: "<TEXT_SHORT_FIELD>" }
    });

    // O skeleton tem que ser copiável sem retoque: o que sai dele precisa passar
    // no schema de criação.
    expect(
      createRegisterPayloadSchema.safeParse({
        ...template.payloadSkeleton,
        values: { supplier_name: "ACME LTDA" }
      }).success
    ).toBe(true);
  });
});
