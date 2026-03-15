import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { createCardCommentPayloadSchema } from "../schemas/comments.js";

export interface CommentsContracts {
  createCardComment: (input: {
    flowId: number;
    cardId: number;
    description: string;
    mentions: number[];
  }) => Promise<{ raw: unknown }>;
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
    }
  };
}
