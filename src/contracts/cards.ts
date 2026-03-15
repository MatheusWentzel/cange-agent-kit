import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
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
    complete?: "S" | "N";
    isFromCurrentStep?: boolean;
    isTestMode?: boolean;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
  moveCardStepWithValues: (input: {
    flowId: number;
    cardId: number;
    fromStepId: number;
    toStepId: number;
    idForm: number;
    values: Record<string, unknown>;
    complete?: "S" | "N";
    isFromCurrentStep?: boolean;
    isTestMode?: boolean;
  }) => Promise<{ raw: unknown; summary: CardSummary }>;
}

export function createCardsContracts(client: CangeClient): CardsContracts {
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

      const raw = await client.post<unknown>("/card/v2/move-step", {
        body: {
          flow_id: parsed.data.flowId,
          id_card: parsed.data.cardId,
          from_step_id: parsed.data.fromStepId,
          to_step_id: parsed.data.toStepId,
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

      const raw = await client.post<unknown>("/card/v2/move-step", {
        body: {
          flow_id: parsed.data.flowId,
          id_card: parsed.data.cardId,
          from_step_id: parsed.data.fromStepId,
          to_step_id: parsed.data.toStepId,
          id_form: parsed.data.idForm,
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
    }
  };
}
