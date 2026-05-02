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
    flowId: number;
    cardId: number;
    description: string;
    mentions: number[];
  }) => Promise<{ raw: unknown }>;
  listCommentsByCard: (input: {
    flowId: number | string;
    cardId: number | string;
  }) => Promise<{ raw: unknown; summaries: CommentSummary[]; total: number }>;
}

export function createCommentsContracts(client: CangeClient): CommentsContracts {
  return {
    async createCardComment(input) {
      const parsed = createCardCommentPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para createCardComment.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/card-comment", {
        body: {
          card_id: parsed.data.cardId,
          flow_id: parsed.data.flowId,
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

      const raw = await client.get<unknown>("/card-comment/by-card", {
        query: {
          flow_id: toNumber(parsed.data.flowId),
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
