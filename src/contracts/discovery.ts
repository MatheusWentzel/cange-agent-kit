import type { CangeResolvedConfig } from "../client/config.js";
import { authenticate as authenticateWithClient } from "../client/auth.js";
import type { CangeClient } from "../client/http.js";
import { getNotificationsByUserParamsSchema } from "../schemas/discovery.js";
import { CangeValidationError } from "../client/errors.js";

import { extractArray, summarizeCard, summarizeFlow, summarizeNotification, summarizeRegister } from "./raw-adapters.js";
import type { CardSummary, FlowSummary, NotificationSummary, RegisterSummary } from "./types.js";

export interface DiscoveryContracts {
  authenticate: () => Promise<{ token: string; source: "access-token-env" | "session-login"; raw?: unknown }>;
  getMyFlows: () => Promise<{ raw: unknown; summaries: FlowSummary[] }>;
  getMyRegisters: () => Promise<{ raw: unknown; summaries: RegisterSummary[] }>;
  getMyTasks: () => Promise<{ raw: unknown; summaries: CardSummary[] }>;
  getNotificationsByUser: (input?: { isArchived?: "S" | "N" }) => Promise<{
    raw: unknown;
    summaries: NotificationSummary[];
  }>;
}

export function createDiscoveryContracts(params: {
  client: CangeClient;
  config: CangeResolvedConfig;
}): DiscoveryContracts {
  const { client, config } = params;

  return {
    authenticate: () => authenticateWithClient(client, config),
    async getMyFlows() {
      const raw = await client.get<unknown>("/flow/my-flows");
      const summaries = extractArray(raw).map((item) => summarizeFlow(item));
      return { raw, summaries };
    },
    async getMyRegisters() {
      const raw = await client.get<unknown>("/register/my-registers");
      const summaries = extractArray(raw).map((item) => summarizeRegister(item));
      return { raw, summaries };
    },
    async getMyTasks() {
      const raw = await client.get<unknown>("/card/my-tasks");
      const summaries = extractArray(raw).map((item) => summarizeCard(item));
      return { raw, summaries };
    },
    async getNotificationsByUser(input = {}) {
      const parsed = getNotificationsByUserParamsSchema.safeParse({
        isArchived: input.isArchived ?? "N"
      });

      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getNotificationsByUser.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/notification/by-user", {
        query: {
          isArchived: parsed.data.isArchived
        }
      });
      const summaries = extractArray(raw).map((item) => summarizeNotification(item));
      return { raw, summaries };
    }
  };
}
