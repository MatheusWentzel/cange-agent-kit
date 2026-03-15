import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { getFlowParamsSchema } from "../schemas/flows.js";

import { summarizeFlow } from "./raw-adapters.js";
import type { FlowSummary } from "./types.js";

export interface GetFlowInput {
  idFlow?: string;
  hash?: string;
}

export interface FlowsContracts {
  getFlow: (input: GetFlowInput) => Promise<{ raw: unknown; summary: FlowSummary }>;
}

export function createFlowsContracts(client: CangeClient): FlowsContracts {
  return {
    async getFlow(input) {
      const parsed = getFlowParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getFlow.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/flow", {
        query: {
          id_flow: parsed.data.idFlow,
          hash: parsed.data.hash
        }
      });
      return {
        raw,
        summary: summarizeFlow(raw)
      };
    }
  };
}
