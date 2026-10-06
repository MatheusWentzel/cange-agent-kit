import type { CangeClient } from "../client/http.js";

import { extractArray } from "./raw-adapters.js";

export interface CompanyUserSummary {
  id: number;
  name?: string;
  email?: string;
}

export interface UsersContracts {
  /**
   * Usuários ativos da empresa (`GET /user/by-company`, a lista que a tela usa
   * para menção e campo de usuário). Uma leitura só; quem chama guarda em cache.
   */
  listCompanyUsers: () => Promise<{ raw: unknown; users: CompanyUserSummary[] }>;
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
    }
  };
}
