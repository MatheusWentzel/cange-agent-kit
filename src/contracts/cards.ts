import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  addCardLabelPayloadSchema,
  addChildCardPayloadSchema,
  cardRelationshipParamsSchema,
  createCardPayloadSchema,
  getCardParamsSchema,
  listCardsByFlowParamsSchema,
  moveCardStepPayloadSchema,
  moveCardStepWithValuesPayloadSchema,
  updateCardPayloadSchema,
  updateCardValuesPayloadSchema
} from "../schemas/cards.js";
import { toNumber } from "../schemas/common.js";

import { extractArray, summarizeCard } from "./raw-adapters.js";
import type { CardSummary } from "./types.js";

export interface CardsContracts {
  getCard: (input: { cardId: number | string; flowId: number | string; companyId?: number | string }) => Promise<{
    raw: unknown;
    summary: CardSummary;
  }>;
  listCardsByFlow: (input: {
    flowId: number | string;
    isTestModel?: boolean;
    isArchived?: boolean;
    isWithPreAnswer?: boolean;
    isWithTimeTracking?: boolean;
  }) => Promise<{ raw: unknown; summaries: CardSummary[] }>;
  createCard: (input: {
    idForm: number;
    flowId: number;
    origin: string;
    values: Record<string, unknown>;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  updateCard: (input: {
    flowId: number;
    cardId: number;
    userId?: number;
    dtDue?: string;
    flowTagId?: number;
    complete?: "S" | "N";
    archived?: "S" | "N";
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  updateCardValues: (input: {
    idForm: number;
    flowId: number;
    cardId: number;
    values: Record<string, unknown>;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  moveCardStep: (input: {
    flowId: number;
    cardId: number;
    fromStepId: number;
    toStepId: number;
    /** Opcional: se omitido, resolve o form da etapa de origem (flow_step.form_id). */
    idForm?: number;
    values: Record<string, unknown>;
    complete?: "S" | "N";
    isFromCurrentStep?: boolean;
    isTestMode?: boolean;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  moveCardStepWithValues: (input: {
    flowId: number;
    cardId: number;
    fromStepId: number;
    toStepId: number;
    /** Opcional: se omitido, resolve o form da etapa de origem (flow_step.form_id). */
    idForm?: number;
    values: Record<string, unknown>;
    complete?: "S" | "N";
    isFromCurrentStep?: boolean;
    isTestMode?: boolean;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  addCardLabel: (input: {
    flowId: number;
    cardId: number;
    flowTagId: number;
  }) => Promise<{ raw: unknown }>;
  getCardRelationship: (input: {
    flowId: number | string;
    cardId: number | string;
    withCards?: boolean;
  }) => Promise<{ raw: unknown; cards: CardSummary[] }>;
  addChildCard: (input: {
    child: { flowId: number; idForm: number; origin: string; values: Record<string, unknown> };
    parent: {
      flowId: number;
      cardId: number;
      idForm: number;
      linkField: string;
      existingChildIds?: number[];
    };
  }) => Promise<{
    raw: unknown;
    childCardId: number | undefined;
    linkedChildIds: number[];
    childRaw: unknown;
    linkRaw: unknown;
  }>;
}

export function createCardsContracts(client: CangeClient): CardsContracts {
  // Cache por-fluxo do mapa etapa->form_id (e do form_init) para o guard de move.
  // Vive na instância do kit; um batch de moves no mesmo fluxo lê o /flow uma vez só.
  const flowStepFormCache = new Map<
    number,
    { stepFormMap: Map<number, number>; formInitId: number | null }
  >();

  async function resolveStepForms(flowId: number) {
    const cached = flowStepFormCache.get(flowId);
    if (cached) return cached;
    const res = await client.get<Record<string, unknown>>("/flow", {
      query: { id_flow: flowId }
    });
    const flow = ((res as Record<string, unknown>)?.raw ?? res) as Record<string, unknown>;
    const steps = (flow?.flow_steps ?? flow?.steps ?? []) as Array<Record<string, unknown>>;
    const stepFormMap = new Map<number, number>();
    for (const s of steps) {
      const sid = Number(s?.id_step ?? s?.id_flow_step);
      const fid = Number(s?.form_id);
      if (Number.isFinite(sid) && Number.isFinite(fid)) stepFormMap.set(sid, fid);
    }
    const formInitId = flow?.form_init_id != null ? Number(flow.form_init_id) : null;
    const out = { stepFormMap, formInitId };
    flowStepFormCache.set(flowId, out);
    return out;
  }

  // Resolve/valida o id_form de um move. Um move cria form_answer(id_form, from_step);
  // se o id_form não for o form da etapa de ORIGEM, cria um form_answer duplicado (e, no
  // caso do form de criação, VAZIO) que vence o "winning form_answer" (max id_form_answer)
  // do FlowQuery V2 e zera os campos do card no V2/Kanban. Se omitido, auto-resolve.
  async function resolveMoveForm(data: {
    flowId: number;
    fromStepId: number;
    idForm?: number;
  }): Promise<number> {
    let stepForms: { stepFormMap: Map<number, number>; formInitId: number | null } | null = null;
    try {
      stepForms = await resolveStepForms(data.flowId);
    } catch {
      stepForms = null; // leitura do fluxo falhou: não bloquear callers explícitos
    }
    const expected = stepForms?.stepFormMap.get(data.fromStepId) ?? null;
    if (expected == null) {
      if (data.idForm == null) {
        throw new CangeValidationError(
          "Não foi possível resolver o form da etapa de origem do move (leitura do fluxo falhou ou etapa desconhecida). Informe idForm = form da etapa de ORIGEM (flow_step.form_id).",
          { details: { flowId: data.flowId, fromStepId: data.fromStepId } }
        );
      }
      return data.idForm;
    }
    if (data.idForm == null) return expected; // auto-resolve (recomendado)
    if (data.idForm !== expected) {
      const isInit = stepForms?.formInitId != null && data.idForm === stepForms.formInitId;
      throw new CangeValidationError(
        isInit
          ? `id_form do move (${data.idForm}) é o form de CRIAÇÃO do fluxo (form_init). Um move deve usar o form da etapa de ORIGEM (fromStepId=${data.fromStepId} → form ${expected}). Usar o form de criação cria um form_answer VAZIO duplicado que vence o FlowQuery V2 (winning = max id_form_answer) e zera os campos do card no V2/Kanban. Passe idForm=${expected} ou omita para resolução automática.`
          : `id_form do move (${data.idForm}) não corresponde ao form da etapa de origem (fromStepId=${data.fromStepId} → form ${expected}). Passe idForm=${expected} ou omita para resolução automática.`,
        {
          details: {
            flowId: data.flowId,
            fromStepId: data.fromStepId,
            idFormRecebido: data.idForm,
            idFormEsperado: expected,
            formInit: stepForms?.formInitId ?? null
          }
        }
      );
    }
    return data.idForm;
  }

  return {
    async getCard(input) {
      const parsed = getCardParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getCard.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/card/", {
        query: {
          id_card: toNumber(parsed.data.cardId),
          flow_id: toNumber(parsed.data.flowId),
          company_id: parsed.data.companyId !== undefined ? toNumber(parsed.data.companyId) : undefined
        }
      });

      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async listCardsByFlow(input) {
      const parsed = listCardsByFlowParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para listCardsByFlow.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/card/by-flow/", {
        query: {
          flow_id: toNumber(parsed.data.flowId),
          isTestModel: parsed.data.isTestModel,
          isArchived: parsed.data.isArchived,
          isWithPreAnswer: parsed.data.isWithPreAnswer,
          isWithTimeTracking: parsed.data.isWithTimeTracking
        }
      });
      return {
        raw,
        summaries: extractArray(raw).map((item) => summarizeCard(item))
      };
    },

    async createCard(input) {
      const parsed = createCardPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para createCard.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/form/new-answer", {
        body: {
          id_form: parsed.data.idForm,
          origin: parsed.data.origin,
          values: parsed.data.values,
          flow_id: parsed.data.flowId
        }
      });

      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async updateCard(input) {
      const parsed = updateCardPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para updateCard.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.put<unknown>("/card", {
        body: {
          flow_id: parsed.data.flowId,
          id_card: parsed.data.cardId,
          user_id: parsed.data.userId,
          dt_due: parsed.data.dtDue,
          flow_tag_id: parsed.data.flowTagId,
          complete: parsed.data.complete,
          archived: parsed.data.archived
        }
      });
      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async updateCardValues(input) {
      const parsed = updateCardValuesPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para updateCardValues.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.put<unknown>("/form/answer", {
        body: {
          id_form: parsed.data.idForm,
          flow_id: parsed.data.flowId,
          card_id: parsed.data.cardId,
          values: parsed.data.values
        }
      });

      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async moveCardStep(input) {
      const parsed = moveCardStepPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para moveCardStep.", {
          details: parsed.error.format()
        });
      }

      const idForm = await resolveMoveForm(parsed.data);
      const raw = await client.post<unknown>("/card/v2/move-step", {
        body: {
          flow_id: parsed.data.flowId,
          id_card: parsed.data.cardId,
          from_step_id: parsed.data.fromStepId,
          to_step_id: parsed.data.toStepId,
          id_form: idForm,
          values: parsed.data.values,
          complete: parsed.data.complete,
          isFromCurrentStep: parsed.data.isFromCurrentStep,
          isTestMode: parsed.data.isTestMode
        }
      });

      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async moveCardStepWithValues(input) {
      const parsed = moveCardStepWithValuesPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para moveCardStepWithValues.", {
          details: parsed.error.format()
        });
      }

      const idForm = await resolveMoveForm(parsed.data);
      const raw = await client.post<unknown>("/card/v2/move-step", {
        body: {
          flow_id: parsed.data.flowId,
          id_card: parsed.data.cardId,
          from_step_id: parsed.data.fromStepId,
          to_step_id: parsed.data.toStepId,
          id_form: idForm,
          values: parsed.data.values,
          complete: parsed.data.complete,
          isFromCurrentStep: parsed.data.isFromCurrentStep,
          isTestMode: parsed.data.isTestMode
        }
      });

      return {
        raw,
        summary: summarizeCard(raw)
      };
    },

    async addCardLabel(input) {
      const parsed = addCardLabelPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para addCardLabel.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/flow-tag/card", {
        body: {
          flow_id: parsed.data.flowId,
          card_id: parsed.data.cardId,
          flow_tag_id: parsed.data.flowTagId
        }
      });
      return { raw };
    },

    async getCardRelationship(input) {
      const parsed = cardRelationshipParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getCardRelationship.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/card/relationship", {
        query: {
          flow_id: toNumber(parsed.data.flowId),
          id_card: toNumber(parsed.data.cardId),
          withCards: parsed.data.withCards === false ? "N" : "S"
        }
      });

      return {
        raw,
        cards: extractArray(raw).map((item) => summarizeCard(item))
      };
    },

    async addChildCard(input) {
      const parsed = addChildCardPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para addChildCard.", {
          details: parsed.error.format()
        });
      }
      const { child, parent } = parsed.data;

      // 1) cria o card filho no fluxo alvo
      const childRaw = await client.post<unknown>("/form/new-answer", {
        body: {
          id_form: child.idForm,
          origin: child.origin,
          values: child.values,
          flow_id: child.flowId
        }
      });
      const childCardId = extractChildCardId(childRaw);
      if (childCardId === undefined) {
        throw new CangeValidationError(
          "Card filho criado mas não foi possível extrair o id_card da resposta.",
          { details: { childRaw } }
        );
      }

      // 2) read-modify-write: campo de fluxo é MULTI-VALOR e REPLACE.
      // Envia a lista completa (existentes + novo, sem duplicar).
      const linkedChildIds = Array.from(
        new Set([...(parent.existingChildIds ?? []), childCardId])
      );

      const linkRaw = await client.put<unknown>("/form/answer", {
        body: {
          id_form: parent.idForm,
          flow_id: parent.flowId,
          card_id: parent.cardId,
          values: { [parent.linkField]: linkedChildIds }
        }
      });

      return {
        raw: { childCardId, linkedChildIds },
        childCardId,
        linkedChildIds,
        childRaw,
        linkRaw
      };
    }
  };
}

function extractChildCardId(raw: unknown): number | undefined {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const inner = (root.raw && typeof root.raw === "object" ? (root.raw as Record<string, unknown>) : root) as Record<
    string,
    unknown
  >;
  const card = (inner.card && typeof inner.card === "object" ? (inner.card as Record<string, unknown>) : undefined) as
    | Record<string, unknown>
    | undefined;
  const candidate = inner.card_id ?? inner.id_card ?? card?.id_card ?? card?.card_id;
  const n = Number(candidate);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
