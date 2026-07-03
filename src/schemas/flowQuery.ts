import { z } from "zod";

import { idLikeSchema } from "./common.js";

/**
 * Motor de query V2 (`POST /flow/v2/query`).
 *
 * Paginação é SEMPRE por cursor (`page_info.next_cursor`) — o back ignora `page`.
 * `page_size` tem teto de 500 no back.
 */
export const queryFlowV2ParamsSchema = z.object({
  flowId: idLikeSchema,
  flowViewId: idLikeSchema.optional(),
  filters: z.array(z.unknown()).optional(),
  sort: z.array(z.unknown()).optional(),
  fields: z.array(z.unknown()).optional(),
  search: z.string().optional(),
  pageSize: z.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
  flowStepId: idLikeSchema.optional(),
  isArchived: z.boolean().optional(),
  searchFieldScope: z.enum(["view", "flow"]).optional()
});

export type QueryFlowV2Params = z.infer<typeof queryFlowV2ParamsSchema>;

/**
 * Variante que percorre todos os cursores até esgotar (ou até `limit`).
 * `maxPages` é um guard contra loop infinito.
 */
export const queryFlowV2AllParamsSchema = queryFlowV2ParamsSchema
  .omit({ cursor: true })
  .extend({
    limit: z.number().int().positive().optional(),
    maxPages: z.number().int().positive().max(200).optional()
  });

export type QueryFlowV2AllParams = z.infer<typeof queryFlowV2AllParamsSchema>;
