import type { CangeResolvedConfig } from "../client/config.js";
import { authenticate as authenticateWithClient } from "../client/auth.js";
import type { CangeClient } from "../client/http.js";
import { getMyTasksParamsSchema, getNotificationsByUserParamsSchema } from "../schemas/discovery.js";
import { CangeValidationError } from "../client/errors.js";
import { toNumber } from "../schemas/common.js";

import { extractArray, summarizeCard, summarizeFlow, summarizeNotification, summarizeRegister } from "./raw-adapters.js";
import type { CardSummary, FlowSummary, NotificationSummary, RegisterSummary } from "./types.js";

export interface DiscoveryContracts {
  authenticate: () => Promise<{ token: string; source: "access-token-env" | "session-login"; raw?: unknown }>;
  getMyFlows: () => Promise<{ raw: unknown; summaries: FlowSummary[] }>;
  getMyRegisters: () => Promise<{ raw: unknown; summaries: RegisterSummary[] }>;
  getMyTasks: (input?: { flowId?: number | string; stepId?: number | string }) => Promise<{
    raw: unknown;
    summaries: CardSummary[];
  }>;
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
    async getMyTasks(input = {}) {
      const parsed = getMyTasksParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getMyTasks.", {
          details: parsed.error.format()
        });
      }

      const query: Record<string, number> = {};
      if (parsed.data.flowId !== undefined) {
        query.flow_id = toNumber(parsed.data.flowId);
      }
      if (parsed.data.stepId !== undefined) {
        query.step_id = toNumber(parsed.data.stepId);
      }

      const raw =
        Object.keys(query).length > 0
          ? await client.get<unknown>("/card/my-tasks", { query })
          : await client.get<unknown>("/card/my-tasks");

      let summaries = extractArray(raw).map((item) => summarizeCard(item));
      if (parsed.data.flowId !== undefined) {
        summaries = summaries.filter(
          (item) => item.flowId !== undefined && String(item.flowId) === String(parsed.data.flowId)
        );
      }
      if (parsed.data.stepId !== undefined) {
        summaries = summaries.filter(
          (item) => item.currentStepId !== undefined && String(item.currentStepId) === String(parsed.data.stepId)
        );
      }

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
