import type { CangeResolvedConfig } from "../client/config.js";
import { authenticate as authenticateWithClient } from "../client/auth.js";
import type { CangeClient } from "../client/http.js";

import { extractArray, summarizeFlow, summarizeRegister } from "./raw-adapters.js";
import type { FlowSummary, RegisterSummary } from "./types.js";

export interface DiscoveryContracts {
  authenticate: () => Promise<{ token: string; source: "access-token-env" | "session-login"; raw?: unknown }>;
  getMyFlows: () => Promise<{ raw: unknown; summaries: FlowSummary[] }>;
  getMyRegisters: () => Promise<{ raw: unknown; summaries: RegisterSummary[] }>;
}

export function createDiscoveryContracts(params: {
  client: CangeClient;
  config: CangeResolvedConfig;
}): DiscoveryContracts {
  const { client, config } = params;

  return {
    authenticate: () => authenticateWithClient(client, config),
    async getMyFlows() {
      const raw = await client.get<unknown>("/my-flows");
      const summaries = extractArray(raw).map((item) => summarizeFlow(item));
      return { raw, summaries };
    },
    async getMyRegisters() {
      const raw = await client.get<unknown>("/my-registers");
      const summaries = extractArray(raw).map((item) => summarizeRegister(item));
      return { raw, summaries };
    }
  };
}
