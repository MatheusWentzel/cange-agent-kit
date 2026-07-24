import { describe, expect, it, vi } from "vitest";

import type { CangeClient } from "../src/client/http.js";
import type { FieldsContracts } from "../src/contracts/fields.js";
import { createRegisterQueryContracts } from "../src/contracts/registerQuery.js";

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

/** fields.getFieldsByRegister mockado (id/title para o mapa de rótulos; formId habilita o fieldView). */
function fieldsWith(
  fields: Array<{ id: number; title?: string; name: string; formId?: number; type?: string }>
): FieldsContracts {
  return {
    getFieldsByFlow: vi.fn(),
    getFieldsByRegister: vi.fn().mockResolvedValue({
      raw: {},
      fields: fields.map((f) => ({ type: "TEXT_SHORT_FIELD", ...f })),
      summary: { total: fields.length, requiredCount: 0, groupedByFormId: {}, items: [] }
    })
  } as unknown as FieldsContracts;
}

/** Extrai o filterSchema (JSON) do body da 1ª chamada mockada de client.post. */
function postedFilterSchema(client: CangeClient): Record<string, unknown> | undefined {
  const call = vi.mocked(client.post).mock.calls[0];
  const body = (call?.[1] as { body?: { filterSchema?: string } } | undefined)?.body;
  return body?.filterSchema ? JSON.parse(body.filterSchema) : undefined;
}

describe("getRegisterEngineStatus", () => {
  it("marca useV2 quando use_query_v2 === 'S'", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({
      id_register: 8,
      use_query_v2: "S",
      isLargeData: "N"
    });
    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const status = await rq.getRegisterEngineStatus({ registerId: 8 });

    expect(client.get).toHaveBeenCalledWith("/register/v2/query-engine-status", {
      query: { id_register: "8" }
    });
    expect(status.useV2).toBe(true);
  });

  it("marca useV2 quando isLargeData === 'S' (mesmo com use_query_v2 'N')", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "N", isLargeData: "S" });
    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const status = await rq.getRegisterEngineStatus({ registerId: 8 });
    expect(status.useV2).toBe(true);
  });

  it("fica em v1 quando ambas as flags são 'N'", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "N", isLargeData: "N" });
    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const status = await rq.getRegisterEngineStatus({ registerId: 8 });
    expect(status.useV2).toBe(false);
  });
});

describe("getRegisterEntries — engine v1 (rota legada)", () => {
  it("roteia para GET /register?withAnswers=true e normaliza as entradas", async () => {
    const client = createMockClient();
    // 1ª get: engine-status (v1). 2ª get: /register com answers.
    vi.mocked(client.get)
      .mockResolvedValueOnce({ use_query_v2: "N", isLargeData: "N" })
      .mockResolvedValueOnce({
        id_register: 8,
        form_answers: [
          {
            id_form_answer: 746,
            title: "Financeiro",
            deleted: null,
            form_answer_fields: [
              {
                field_id: 1853,
                valueString: "Financeiro",
                value: "Financeiro",
                deleted: null,
                field: { id_field: 1853, title: "Descrição", name: "hash1" }
              }
            ]
          },
          {
            // entrada deletada — deve ser ignorada
            id_form_answer: 999,
            deleted: "S",
            form_answer_fields: []
          }
        ]
      });

    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const result = await rq.getRegisterEntries({ registerId: 8 });

    expect(result.engine).toBe("v1");
    expect(result.pageInfo).toEqual({ hasMore: false });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      id: 746,
      title: "Financeiro",
      fields: { Descrição: "Financeiro" }
    });
    // v1 NÃO consulta o motor v2
    expect(client.post).not.toHaveBeenCalled();
  });

  it("agrega multi-valor (mesmo field_id repetido) e ignora field deletado", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce({ use_query_v2: "N", isLargeData: "N" })
      .mockResolvedValueOnce({
        id_register: 8,
        form_answers: [
          {
            id_form_answer: 10,
            form_answer_fields: [
              { field_id: 2000, valueString: "Atheon", field: { id_field: 2000, title: "Cliente" } },
              { field_id: 2000, valueString: "Mileto", field: { id_field: 2000, title: "Cliente" } },
              {
                field_id: 3000,
                valueString: "ignorado",
                deleted: "S",
                field: { id_field: 3000, title: "Obsoleto" }
              }
            ]
          }
        ]
      });

    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const result = await rq.getRegisterEntries({ registerId: 8 });

    expect(result.entries[0]!.fields).toEqual({ Cliente: ["Atheon", "Mileto"] });
  });

  it("passa search como likeSearch na v1", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce({ use_query_v2: "N", isLargeData: "N" })
      .mockResolvedValueOnce({ form_answers: [] });

    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    await rq.getRegisterEntries({ registerId: 8, search: "financeiro" });

    expect(client.get).toHaveBeenNthCalledWith(2, "/register", {
      query: { id_register: "8", withAnswers: "true", likeSearch: "financeiro" }
    });
  });
});

describe("getRegisterEntries — engine v2 (paginada)", () => {
  it("roteia para POST /register/v2/query, resolve rótulos e normaliza single/multi-valor", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "S", isLargeData: "N" });
    vi.mocked(client.post).mockResolvedValueOnce({
      items: [
        {
          "form_answer.id_form_answer": 746,
          "form_answer.title": "Cliente X",
          "field:1853": { display_value: "Financeiro", value: "Financeiro" },
          "field:2000": {
            items: [{ display_value: "Atheon" }, { display_value: "Mileto" }],
            mv_count: 2,
            mv_display_value: "Atheon, Mileto"
          },
          "field:9999": null // campo vazio → omitido
        }
      ],
      page_info: { has_more: true, next_cursor: "CURSOR2" },
      execution_stats: { page_size: 50, total_count: 812 }
    });

    const rq = createRegisterQueryContracts({
      client,
      fields: fieldsWith([
        { id: 1853, title: "Descrição", name: "h1", formId: 700 },
        { id: 2000, title: "Cliente", name: "h2", formId: 700 }
      ])
    });
    const result = await rq.getRegisterEntries({ registerId: 8, pageSize: 50 });

    expect(result.engine).toBe("v2");
    // O fieldView É obrigatório na v2 para projetar os valores (senão volta só metadados).
    const fs = postedFilterSchema(client) as { fieldView?: Array<Record<string, unknown>> };
    expect(fs?.fieldView).toHaveLength(2);
    expect(fs?.fieldView?.[0]).toMatchObject({ id_field: 1853, form_id: 700, type: "TEXT_SHORT_FIELD" });
    const postBody = (vi.mocked(client.post).mock.calls[0]?.[1] as { body?: Record<string, unknown> })
      ?.body;
    expect(postBody).toMatchObject({ id_register: 8, page_size: 50, cursor: undefined });
    expect(result.entries[0]).toEqual({
      id: 746,
      title: "Cliente X",
      fields: { Descrição: "Financeiro", Cliente: ["Atheon", "Mileto"] }
    });
    expect(result.pageInfo).toEqual({ hasMore: true, nextCursor: "CURSOR2" });
    expect(result.executionStats?.totalCount).toBe(812);
  });

  it("omite do fieldView campos sem form_id (não projetáveis) mas mantém o rótulo", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "S" });
    vi.mocked(client.post).mockResolvedValueOnce({ items: [], page_info: { has_more: false } });

    const rq = createRegisterQueryContracts({
      client,
      fields: fieldsWith([
        { id: 10, title: "Com form", name: "a", formId: 700 },
        { id: 11, title: "Sem form", name: "b" } // sem formId → fora do fieldView
      ])
    });
    await rq.getRegisterEntries({ registerId: 8 });

    const fs = postedFilterSchema(client) as { fieldView?: Array<Record<string, unknown>> };
    expect(fs?.fieldView).toHaveLength(1);
    expect(fs?.fieldView?.[0]).toMatchObject({ id_field: 10, form_id: 700 });
  });

  it("cai para a chave `field:<id>` quando não há título no mapa", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "S" });
    vi.mocked(client.post).mockResolvedValueOnce({
      items: [{ "form_answer.id_form_answer": 1, "field:1853": { display_value: "X" } }],
      page_info: { has_more: false }
    });

    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    const result = await rq.getRegisterEntries({ registerId: 8 });

    expect(result.entries[0]!.fields).toEqual({ "field:1853": "X" });
  });

  it("passa search como filterSchema JSON (searchText) na v2", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "S" });
    vi.mocked(client.post).mockResolvedValueOnce({ items: [], page_info: { has_more: false } });

    const rq = createRegisterQueryContracts({ client, fields: fieldsWith([]) });
    await rq.getRegisterEntries({ registerId: 8, search: "acme" });

    expect(client.post).toHaveBeenCalledWith("/register/v2/query", {
      body: {
        id_register: 8,
        filterSchema: JSON.stringify({ searchText: "acme" }),
        page_size: undefined,
        cursor: undefined
      }
    });
  });

  it("degrada sem quebrar quando getFieldsByRegister falha (sem mapa de títulos)", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({ use_query_v2: "S" });
    vi.mocked(client.post).mockResolvedValueOnce({
      items: [{ "form_answer.id_form_answer": 1, "field:1853": { display_value: "X" } }],
      page_info: { has_more: false }
    });
    const fields = {
      getFieldsByFlow: vi.fn(),
      getFieldsByRegister: vi.fn().mockRejectedValue(new Error("boom"))
    } as unknown as FieldsContracts;

    const rq = createRegisterQueryContracts({ client, fields });
    const result = await rq.getRegisterEntries({ registerId: 8 });

    expect(result.entries[0]!.fields).toEqual({ "field:1853": "X" });
  });
});
