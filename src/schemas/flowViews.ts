import { z } from "zod";

import { idLikeSchema } from "./common.js";

/** Lista as visualizações salvas de um flow (`GET /flow-view/by-flow`). */
export const listFlowViewsParamsSchema = z.object({
  flowId: idLikeSchema
});

export type ListFlowViewsParams = z.infer<typeof listFlowViewsParamsSchema>;

/** Detalhe de uma visualização (`GET /flow-view`). */
export const getFlowViewParamsSchema = z.object({
  idFlowView: idLikeSchema,
  flowId: idLikeSchema
});

export type GetFlowViewParams = z.infer<typeof getFlowViewParamsSchema>;
