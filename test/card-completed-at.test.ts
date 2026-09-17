import { describe, expect, it } from "vitest";

import { summarizeCard } from "../src/contracts/raw-adapters.js";

/**
 * `completedAt` vem de `card.dt_complete`, gravado pelo backend quando o card entra
 * numa etapa final (`isEndStep === "1"`) e ZERADO quando ele volta para etapa não-final.
 * Card sem conclusão não deve criar a chave (o consumidor distingue "não concluído"
 * de "concluído sem data").
 */
describe("summarizeCard — completedAt", () => {
  it("mapeia dt_complete de um card concluído (shape do GET /card)", () => {
    const summary = summarizeCard({
      id: 1085239,
      flow_id: 21173,
      title: "Apresentação + handover para teste — Grupo 4",
      complete: "S",
      dt_complete: "2026-09-17T12:37:10.000Z",
      dt_created: "2026-06-25T03:35:52.000Z"
    });

    expect(summary.completedAt).toBe("2026-09-17T12:37:10.000Z");
    expect(summary.complete).toBe(true);
  });

  it("mapeia dt_complete no shape dos itens do FlowQuery V2", () => {
    const summary = summarizeCard({
      id_card: 2795,
      flow_id: 192,
      flow_step_id: 87743,
      complete: "S",
      dt_complete: "2025-12-24T10:14:56.000Z",
      dt_created: "2023-04-20T03:11:05.000Z"
    });

    expect(summary.completedAt).toBe("2025-12-24T10:14:56.000Z");
  });

  it("não cria a chave quando o card não está concluído (dt_complete null)", () => {
    const summary = summarizeCard({
      id: 999,
      flow_id: 192,
      title: "Em execução",
      complete: "N",
      dt_complete: null,
      dt_created: "2026-09-01T10:00:00.000Z"
    });

    expect(summary.completedAt).toBeUndefined();
    expect("completedAt" in summary).toBe(false);
  });

  it("não cria a chave quando dt_complete nem existe no payload", () => {
    const summary = summarizeCard({ id: 1000, flow_id: 192, title: "Sem a coluna" });

    expect("completedAt" in summary).toBe(false);
  });
});
