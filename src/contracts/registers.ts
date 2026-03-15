import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  createRegisterPayloadSchema,
  getRegisterFormAnswerParamsSchema,
  getRegisterParamsSchema,
  updateRegisterPayloadSchema
} from "../schemas/registers.js";
import { toNumber } from "../schemas/common.js";

import { summarizeRegister } from "./raw-adapters.js";
import type { RegisterSummary } from "./types.js";

export interface RegistersContracts {
  getRegister: (input: { idRegister?: string; hash?: string }) => Promise<{
    raw: unknown;
    summary: RegisterSummary;
  }>;
  getRegisterFormAnswer: (input: { formAnswerId: string | number }) => Promise<{ raw: unknown }>;
  createRegister: (input: {
    idForm: number;
    origin: string;
    values: Record<string, unknown>;
    registerContext?: Record<string, unknown>;
  }) => Promise<{ raw: unknown; summary: RegisterSummary }>;
  updateRegister: (input: {
    idForm: number;
    registerId?: string | number;
    formAnswerId?: string | number;
    values: Record<string, unknown>;
  }) => Promise<{ raw: unknown; summary: RegisterSummary }>;
}

export function createRegistersContracts(client: CangeClient): RegistersContracts {
  return {
    async getRegister(input) {
      const parsed = getRegisterParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getRegister.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/register", {
        query: {
          id_register: parsed.data.idRegister,
          hash: parsed.data.hash
        }
      });

      return {
        raw,
        summary: summarizeRegister(raw)
      };
    },

    async getRegisterFormAnswer(input) {
      const parsed = getRegisterFormAnswerParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getRegisterFormAnswer.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/form/answer/", {
        query: {
          form_answer_id: toNumber(parsed.data.formAnswerId)
        }
      });
      return { raw };
    },

    async createRegister(input) {
      const parsed = createRegisterPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para createRegister.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.post<unknown>("/form/new-answer", {
        body: {
          id_form: parsed.data.idForm,
          origin: parsed.data.origin,
          values: parsed.data.values,
          registerContext: parsed.data.registerContext
        }
      });

      return {
        raw,
        summary: summarizeRegister(raw)
      };
    },

    async updateRegister(input) {
      const parsed = updateRegisterPayloadSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para updateRegister.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.put<unknown>("/form/answer", {
        body: {
          id_form: parsed.data.idForm,
          register_id:
            parsed.data.registerId !== undefined ? toNumber(parsed.data.registerId) : undefined,
          form_answer_id:
            parsed.data.formAnswerId !== undefined ? toNumber(parsed.data.formAnswerId) : undefined,
          values: parsed.data.values
        }
      });

      return {
        raw,
        summary: summarizeRegister(raw)
      };
    }
  };
}
