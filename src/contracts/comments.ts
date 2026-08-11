import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  createCardCommentPayloadSchema,
  listCommentsByCardParamsSchema
} from "../schemas/comments.js";
import { toNumber } from "../schemas/common.js";

import { extractArray } from "./raw-adapters.js";

export interface CommentSummary {
  id: number | null;
  cardId: number | null;
  userId: number | null;
  userName: string | null;
  description: string;
  dtCreated: string | null;
  dtCreatedFormatted: string | null;
  fixed: boolean;
  attachmentsCount: number;
}

export interface CommentsContracts {
  createCardComment: (input: {
    flowId?: number;
    cardId: number;
    description: string;
    mentions?: number[];
  }) => Promise<{ raw: unknown }>;
  listCommentsByCard: (input: {
    flowId?: number | string;
    cardId: number | string;
  }) => Promise<{ raw: unknown; summaries: CommentSummary[]; total: number }>;
}

/**
 * flow_id do card, resolvido de `CANGE_CARD_FLOW_ID` (o runner injeta o fluxo REAL do card
 * no ambiente do agente). Retorna undefined se a env estiver ausente/inválida. Usado como
 * fallback quando o chamador não passa flowId — assim o agente comenta sabendo só o cardId.
 */
function readEnvFlowId(): number | undefined {
  const raw = process.env.CANGE_CARD_FLOW_ID;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const FLOW_ID_MISSING_MSG =
  "flow_id ausente: passe --flow-id, inclua flowId no payload, ou rode com CANGE_CARD_FLOW_ID no ambiente (o runner injeta o flow do card automaticamente).";

export function createCommentsContracts(client: CangeClient): CommentsContracts {
  return {
    async createCardComment(input) {
      const parsed = createCardCommentPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para createCardComment.", {
          details: parsed.error.format()
        });
      }

      const flowId = parsed.data.flowId ?? readEnvFlowId();
      if (flowId === undefined) {
        throw new CangeValidationError(FLOW_ID_MISSING_MSG);
      }

      const raw = await client.post<unknown>("/card-comment", {
        body: {
          card_id: parsed.data.cardId,
          flow_id: flowId,
          description: parsed.data.description,
          mentions: parsed.data.mentions
        }
      });
      return { raw };
    },

    async listCommentsByCard(input) {
      const parsed = listCommentsByCardParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para listCommentsByCard.", {
          details: parsed.error.format()
        });
      }

      const flowId = parsed.data.flowId ?? readEnvFlowId();
      if (flowId === undefined) {
        throw new CangeValidationError(FLOW_ID_MISSING_MSG);
      }

      const raw = await client.get<unknown>("/card-comment/by-card", {
        query: {
          flow_id: toNumber(flowId),
          card_id: toNumber(parsed.data.cardId)
        }
      });

      const items = extractArray(raw);
      const summaries = items.map((item) => summarizeComment(item));
      return {
        raw,
        summaries,
        total: summaries.length
      };
    }
  };
}

function summarizeComment(raw: unknown): CommentSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const user = (r.user ?? {}) as Record<string, unknown>;
  const attachments = Array.isArray(r.attachments) ? (r.attachments as unknown[]) : [];

  return {
    id: numberOrNull(r.id_card_comment),
    cardId: numberOrNull(r.card_id),
    userId: numberOrNull(user.id_user ?? r.user_id),
    userName: stringOrNull(user.name),
    description: typeof r.description === "string" ? r.description : "",
    dtCreated: stringOrNull(r.dt_created),
    dtCreatedFormatted: stringOrNull(r.dt_created_string),
    fixed: r.fixed === 1 || r.fixed === "1" || r.fixed === true,
    attachmentsCount: attachments.length
  };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}
