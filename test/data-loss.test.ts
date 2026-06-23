import { describe, expect, it, vi } from "vitest";

import { detectDataLoss } from "../src/utils/dataLoss.js";
import type { CangeAgentKit } from "../src/index.js";
import type { NormalizedField } from "../src/schemas/fields.js";

const IDFORM = 142510;

const targetFields: NormalizedField[] = [
  {
    id: 10,
    name: "hash_centro_custo",
    title: "Centro de custo",
    type: "TEXT_SHORT_FIELD",
    required: false,
    formId: IDFORM,
    raw: {}
  },
  {
    id: 11,
    name: "hash_competencia",
    title: "Competência FAT",
    type: "TEXT_SHORT_FIELD",
    required: false,
    formId: IDFORM,
    raw: {}
  }
];

function makeKit(
  cardRaw: unknown,
  opts: { fieldsThrow?: boolean; cardThrow?: boolean } = {}
): CangeAgentKit {
  return {
    contracts: {
      getCard: opts.cardThrow
        ? vi.fn().mockRejectedValue(new Error("boom"))
        : vi.fn().mockResolvedValue({ raw: cardRaw, summary: {} }),
      getFieldsByFlow: opts.fieldsThrow
        ? vi.fn().mockRejectedValue(new Error("JWT token is missing"))
        : vi.fn().mockResolvedValue({ raw: {}, fields: targetFields, summary: {} })
    }
  } as unknown as CangeAgentKit;
}

function answerField(id: number, name: string, value: string, deleted = "N") {
  return { field_id: id, field: { id_field: id, name }, valueString: value, deleted };
}

describe("detectDataLoss (M2 — campos órfãos)", () => {
  it("aponta campos preenchidos ausentes do values e ignora os incluídos", async () => {
    const cardRaw = {
      id_card: 1,
      form_answers: [
        {
          id_form_answer: 100,
          form_id: IDFORM,
          deleted: "N",
          dt_created: "2026-01-01 10:00:00",
          form_answer_fields: [
            answerField(10, "hash_centro_custo", "CC-001"),
            answerField(11, "hash_competencia", "2026-01")
          ]
        }
      ]
    };

    const result = await detectDataLoss({
      kit: makeKit(cardRaw),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: { hash_competencia: "2026-01" } }
    });

    expect(result.checked).toBe(true);
    expect(result.orphans.map((o) => o.fieldName)).toEqual(["hash_centro_custo"]);
    expect(result.orphans[0]).toMatchObject({
      fieldTitle: "Centro de custo",
      currentValue: "CC-001"
    });
  });

  it("não acusa órfãos quando o values cobre todos os campos preenchidos", async () => {
    const cardRaw = {
      form_answers: [
        {
          form_id: IDFORM,
          deleted: "N",
          form_answer_fields: [answerField(10, "hash_centro_custo", "CC-001")]
        }
      ]
    };

    const result = await detectDataLoss({
      kit: makeKit(cardRaw),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: { hash_centro_custo: "novo" } }
    });

    expect(result.orphans).toHaveLength(0);
  });

  it("ignora campos de outro form e form_answers deletados", async () => {
    const cardRaw = {
      form_answers: [
        {
          form_id: 999,
          deleted: "N",
          form_answer_fields: [answerField(50, "hash_outro_form", "X")]
        },
        {
          form_id: IDFORM,
          deleted: "S",
          form_answer_fields: [answerField(10, "hash_centro_custo", "CC-DELETADO")]
        }
      ]
    };

    const result = await detectDataLoss({
      kit: makeKit(cardRaw),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: {} }
    });

    expect(result.orphans).toHaveLength(0);
  });

  it("respeita 'mais recente vence': campo esvaziado no snapshot novo não é órfão", async () => {
    const cardRaw = {
      form_answers: [
        {
          id_form_answer: 1,
          form_id: IDFORM,
          deleted: "N",
          dt_created: "2026-01-01 10:00:00",
          form_answer_fields: [
            answerField(10, "hash_centro_custo", "CC-001"),
            answerField(11, "hash_competencia", "2026-01")
          ]
        },
        {
          id_form_answer: 2,
          form_id: IDFORM,
          deleted: "N",
          dt_created: "2026-02-01 10:00:00",
          form_answer_fields: [answerField(11, "hash_competencia", "")]
        }
      ]
    };

    const result = await detectDataLoss({
      kit: makeKit(cardRaw),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: {} }
    });

    // hash_competencia foi esvaziado no snapshot mais recente → não conta.
    // hash_centro_custo segue preenchido → único órfão.
    expect(result.orphans.map((o) => o.fieldName)).toEqual(["hash_centro_custo"]);
  });

  it("detecta órfãos mesmo quando getFieldsByFlow falha (401/JWT) — usa o name do card raw", async () => {
    const cardRaw = {
      form_answers: [
        {
          form_id: IDFORM,
          deleted: "N",
          form_answer_fields: [answerField(10, "hash_centro_custo", "CC-001")]
        }
      ]
    };

    const result = await detectDataLoss({
      kit: makeKit(cardRaw, { fieldsThrow: true }),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: {} }
    });

    expect(result.checked).toBe(true);
    expect(result.orphans.map((o) => o.fieldName)).toEqual(["hash_centro_custo"]);
  });

  it("degrada sem bloquear quando a leitura do card falha", async () => {
    const result = await detectDataLoss({
      kit: makeKit(undefined, { cardThrow: true }),
      payload: { flowId: 1, cardId: 1, idForm: IDFORM, values: {} }
    });

    expect(result.checked).toBe(false);
    expect(result.orphans).toHaveLength(0);
  });
});
