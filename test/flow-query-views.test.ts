import { describe, expect, it, vi } from "vitest";

import type { CangeClient } from "../src/client/http.js";
import type { CardsContracts } from "../src/contracts/cards.js";
import { createFlowCardsContracts } from "../src/contracts/flowCards.js";
import { createFlowQueryContracts } from "../src/contracts/flowQuery.js";
import { createFlowViewsContracts } from "../src/contracts/flowViews.js";
import type { FlowsContracts } from "../src/contracts/flows.js";

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

const V2_ITEM = (id: number) => ({
  card: { id_card: id, flow_id: 192, title: `card ${id}`, flow_step_id: 485, user_id: 76 },
  fields: {}
});

describe("flowQuery contracts", () => {
  it("monta o body do POST /flow/v2/query e normaliza items → CardSummary", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      items: [V2_ITEM(1), V2_ITEM(2)],
      page_info: { has_more: false },
      execution_stats: { plan: "large", total_count: 2, duration_ms: 10 }
    });

    const contracts = createFlowQueryContracts(client);
    const result = await contracts.queryFlowV2({
      flowId: 192,
      flowViewId: 7,
      search: "abc",
      isArchived: true
    });

    expect(client.post).toHaveBeenCalledWith("/flow/v2/query", {
      body: expect.objectContaining({
        flow_id: 192,
        flow_view_id: 7,
        search: "abc",
        flags: { isArchived: true, search_field_scope: undefined }
      })
    });
    expect(result.summaries.map((c) => c.cardId)).toEqual([1, 2]);
    expect(result.summaries[0]!.currentStepId).toBe(485);
    expect(result.executionStats?.totalCount).toBe(2);
  });

  it("queryFlowV2All percorre cursores até esgotar e respeita limit", async () => {
    const client = createMockClient();
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        items: [V2_ITEM(1), V2_ITEM(2)],
        page_info: { has_more: true, next_cursor: "c1" }
      })
      .mockResolvedValueOnce({
        items: [V2_ITEM(3), V2_ITEM(4)],
        page_info: { has_more: true, next_cursor: "c2" }
      });

    const contracts = createFlowQueryContracts(client);
    const result = await contracts.queryFlowV2All({ flowId: 192, pageSize: 2, limit: 3 });

    expect(result.summaries.map((c) => c.cardId)).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
    // 2ª chamada deve ter mandado o cursor da 1ª página
    expect(vi.mocked(client.post).mock.calls[1]![1]).toMatchObject({
      body: expect.objectContaining({ cursor: "c1" })
    });
  });

  it("sem page_size explícito, dimensiona a página pelo limit (evita over-fetch)", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      items: [V2_ITEM(1)],
      page_info: { has_more: false }
    });

    const contracts = createFlowQueryContracts(client);
    await contracts.queryFlowV2All({ flowId: 192, limit: 5 });

    expect(vi.mocked(client.post).mock.calls[0]![1]).toMatchObject({
      body: expect.objectContaining({ page_size: 5 })
    });
  });
});

describe("flowViews contracts", () => {
  it("resume o schema JSON da view (colunas/filtros/ordenação)", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue([
      {
        id_flow_view: 1,
        name: "Bugs",
        icon: "FaFire",
        isPublic: "S",
        isFavorited: false,
        schema: JSON.stringify({
          fieldView: [{ active: true }, { active: true }, { active: false }],
          conditions: [{ index: 0 }, { index: 1 }],
          orderBy: [{ selectedField: { title: "Data de Criação" }, selectedOrder: "9 → 1" }],
          searchText: "x"
        })
      }
    ]);

    const contracts = createFlowViewsContracts(client);
    const { views, total } = await contracts.listFlowViews({ flowId: 192 });

    expect(total).toBe(1);
    expect(views[0]).toMatchObject({
      id: 1,
      name: "Bugs",
      isPublic: true,
      filter: {
        columnsCount: 2,
        filtersCount: 2,
        searchText: "x",
        sort: [{ field: "Data de Criação", order: "9 → 1" }]
      }
    });
    // sem includeSchema, não anexa o schema bruto
    expect(views[0]!.schema).toBeUndefined();
  });
});

describe("flowCards switch (V1/V2)", () => {
  function deps(client: CangeClient) {
    const flowQuery = createFlowQueryContracts(client);
    const cards = {
      listCardsByFlow: vi.fn(async () => ({
        raw: {},
        summaries: [
          { cardId: 10, currentStepId: 485 },
          { cardId: 11, currentStepId: 486 }
        ]
      }))
    } as unknown as CardsContracts;
    const flows = {
      getFlow: vi.fn(async () => ({ raw: { use_flow_query_v2: "N" }, summary: {} }))
    } as unknown as FlowsContracts;
    return { flowQuery, cards, flows };
  }

  it("engine=auto usa V2 quando o motor está habilitado globalmente", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ enabled: true }); // query-engine-status
    vi.mocked(client.post).mockResolvedValue({ items: [V2_ITEM(1)], page_info: { has_more: false } });

    const { flowQuery, cards, flows } = deps(client);
    const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });

    const res = await flowCards.fetchFlowCards({ flowId: 192, engine: "auto" });
    expect(res.engine).toBe("v2");
    expect(res.summaries.map((c) => c.cardId)).toEqual([1]);
    expect(cards.listCardsByFlow).not.toHaveBeenCalled();
  });

  it("engine=auto cai para V1 quando motor desabilitado e flow sem flag", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ enabled: false });

    const { flowQuery, cards, flows } = deps(client);
    const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });

    const res = await flowCards.fetchFlowCards({ flowId: 192, engine: "auto" });
    expect(res.engine).toBe("v1");
    expect(res.summaries.map((c) => c.cardId)).toEqual([10, 11]);
  });

  it("view-id força V2 mesmo com engine auto e motor desabilitado", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ enabled: false });
    vi.mocked(client.post).mockResolvedValue({ items: [V2_ITEM(99)], page_info: { has_more: false } });

    const { flowQuery, cards, flows } = deps(client);
    const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });

    const res = await flowCards.fetchFlowCards({ flowId: 192, flowViewId: 5 });
    expect(res.engine).toBe("v2");
    expect(cards.listCardsByFlow).not.toHaveBeenCalled();
  });

  it("fallback: V2 falha (sem params exclusivos) → cai para V1 marcando fellBackToV1", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ enabled: true });
    vi.mocked(client.post).mockRejectedValue(new Error("boom"));

    const { flowQuery, cards, flows } = deps(client);
    const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });

    const res = await flowCards.fetchFlowCards({ flowId: 192, engine: "auto" });
    expect(res.engine).toBe("v1");
    expect(res.fellBackToV1).toBe(true);
  });

  it("engine=v1 filtra por etapa client-side", async () => {
    const client = createMockClient();
    const { flowQuery, cards, flows } = deps(client);
    const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });

    const res = await flowCards.fetchFlowCards({ flowId: 192, engine: "v1", flowStepId: 486 });
    expect(res.engine).toBe("v1");
    expect(res.summaries.map((c) => c.cardId)).toEqual([11]);
  });
});
