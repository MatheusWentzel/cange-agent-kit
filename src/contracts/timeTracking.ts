import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { createTimeTrackingPayloadSchema } from "../schemas/timeTracking.js";

export interface TimeTrackingContracts {
  createTimeTracking: (input: {
    flowId?: number;
    cardId?: number;
    flowStepId?: number;
    source: string;
    dtStart: string;
    dtEnd: string;
    duration: number;
    billable: "S" | "N";
    title?: string;
    description?: string;
  }) => Promise<{ raw: unknown }>;
}

export function createTimeTrackingContracts(client: CangeClient): TimeTrackingContracts {
  return {
    async createTimeTracking(input) {
      const parsed = createTimeTrackingPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para createTimeTracking.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/time-tracking", {
        body: {
          flow_id: parsed.data.flowId,
          card_id: parsed.data.cardId,
          flow_step_id: parsed.data.flowStepId,
          source: parsed.data.source,
          dt_start: parsed.data.dtStart,
          dt_end: parsed.data.dtEnd,
          duration: parsed.data.duration,
          billable: parsed.data.billable,
          title: parsed.data.title,
          description: parsed.data.description
        }
      });

      return { raw };
    }
  };
}
