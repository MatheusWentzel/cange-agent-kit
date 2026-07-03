import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { toNumber } from "../schemas/common.js";
import { getFlowViewParamsSchema, listFlowViewsParamsSchema } from "../schemas/flowViews.js";

import { extractArray, summarizeFlowView } from "./raw-adapters.js";
import type { FlowViewSummary } from "./types.js";

export interface FlowViewsContracts {
  listFlowViews: (input: {
    flowId: number | string;
    includeSchema?: boolean;
  }) => Promise<{ raw: unknown; views: FlowViewSummary[]; total: number }>;
  getFlowView: (input: {
    idFlowView: number | string;
    flowId: number | string;
  }) => Promise<{ raw: unknown; view: FlowViewSummary }>;
}

export function createFlowViewsContracts(client: CangeClient): FlowViewsContracts {
  return {
    async listFlowViews(input) {
      const parsed = listFlowViewsParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para listFlowViews.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/flow-view/by-flow", {
        query: { flow_id: toNumber(parsed.data.flowId) }
      });

      const views = extractArray(raw).map((item) =>
        summarizeFlowView(item, { includeSchema: input.includeSchema === true })
      );

      return { raw, views, total: views.length };
    },

    async getFlowView(input) {
      const parsed = getFlowViewParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getFlowView.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/flow-view", {
        query: {
          id_flow_view: toNumber(parsed.data.idFlowView),
          flow_id: toNumber(parsed.data.flowId)
        }
      });

      return { raw, view: summarizeFlowView(raw, { includeSchema: true }) };
    }
  };
}
