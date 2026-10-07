import type { CangeClient } from "../client/http.js";

import { extractArray } from "./raw-adapters.js";

export interface CompanyUserSummary {
  id: number;
  name?: string;
  email?: string;
}

/** Usuário da lista do campo de usuário da tela (`GET /user/by-flow?form_id`). */
export interface FormUserSummary {
  id: number;
  /** `flow_user.type` do usuário no fluxo ("A", "M", "V"...); a tela tira o leitor ("V"). */
  flowUserType?: string;
}

export interface UsersContracts {
  /**
   * Usuários ativos da empresa (`GET /user/by-company`, a lista que a tela usa
   * para menção e campo de usuário). Uma leitura só; quem chama guarda em cache.
   */
  listCompanyUsers: () => Promise<{ raw: unknown; users: CompanyUserSummary[] }>;
  /**
   * R4-P1 (revisão 4 do EXTRA-06): a lista que o campo de usuário da tela carrega
   * (`ComboBoxUser`: `GET /user/by-flow?form_id=<form>`). O back tira o bloqueado e, no fluxo
   * privado, quem não é membro; a tela tira o leitor (`flow_user_type = 'V'`). Leitura.
   */
  listUsersByForm: (input: { formId: number | string }) => Promise<{ raw: unknown; users: FormUserSummary[] }>;
}

export function createUsersContracts(client: CangeClient): UsersContracts {
  return {
    async listCompanyUsers() {
      const raw = await client.get<unknown>("/user/by-company");
      const users: CompanyUserSummary[] = [];
      for (const item of extractArray(raw)) {
        if (item === null || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = Number(record.id_user ?? record.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        users.push({
          id,
          ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
          ...(typeof record.email === "string" && record.email.trim() ? { email: record.email.trim() } : {})
        });
      }
      return { raw, users };
    },

    async listUsersByForm(input) {
      const raw = await client.get<unknown>("/user/by-flow", { query: { form_id: Number(input.formId) } });
      const users: FormUserSummary[] = [];
      for (const item of extractArray(raw)) {
        if (item === null || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = Number(record.id_user ?? record.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        users.push({ id, ...(typeof record.flow_user_type === "string" ? { flowUserType: record.flow_user_type } : {}) });
      }
      return { raw, users };
    }
  };
}
