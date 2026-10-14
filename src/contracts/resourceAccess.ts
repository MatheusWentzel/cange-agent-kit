import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { continuationEchoFromApi, nextTaskIssue, normalizeNextTask, type ContinuationEcho } from "./continuation.js";

/**
 * Acesso do agente a fluxos e cadastros (rodada 6, 02/10, decisão 9 do Matheus).
 *
 *  - `getAgentCatalog`: GET /agent-run/catalog → fluxos e cadastros que o agente
 *    pode VER pelo nome (id, nome, se tem acesso, papel). Num run com conversa ou
 *    rotina, é o que o humano âncora vê somado ao que o bot vê; numa automação
 *    sem conversa, só o que o bot já vê. Nunca conteúdo.
 *  - `requestResourceAccess`: POST /agent-run/access-request → cria o PEDIDO de
 *    acesso no servidor. Não pausa o run; quem pode convidar para o recurso decide.
 *
 * As duas rotas são só do TOKEN DE RUN (humano = 403). O agente sai do token.
 */

export const RESOURCE_TYPES = ["flow", "register"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const CATALOG_TYPES = ["flow", "register", "all"] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];
/**
 * Decisão 11 do Matheus (02/10): a aprovação de pedido de acesso concede SEMPRE
 * Membro e o agente não pede Administrador (o back também rebaixa 'A' para 'M').
 * Administrador só pelo bloco Ferramentas > Cange, por quem tem autoridade.
 */
export const ACCESS_ROLES = ["M"] as const;
/** Mensagem de uso quando o agente tenta pedir Administrador. */
export const ACCESS_ROLE_ADMIN_REFUSED =
  "--role A não existe no pedido de acesso: a aprovação concede sempre Membro. Administrador só pelo bloco " +
  "Ferramentas > Cange, por quem tem autoridade sobre o recurso. Peça sem --role (Membro).";
export type AccessRole = (typeof ACCESS_ROLES)[number];

/** Teto do back para `limit` (CATALOG_MAX_LIMIT). */
export const CATALOG_MAX_LIMIT = 500;
/** Padrão do back para `limit` (CATALOG_DEFAULT_LIMIT). */
export const CATALOG_DEFAULT_LIMIT = 200;
/** Teto do back para o motivo (o servidor ainda corta em 500 e rotula). */
export const ACCESS_REASON_MAX = 4000;

export interface CatalogItem {
  id: number;
  name: string;
  type: ResourceType;
  hasAccess: boolean;
  role: string | null;
  requestable: boolean;
}

export interface AgentCatalog {
  anchor: { kind: string; name: string | null } | null;
  /** 'anchor_and_agent' (conversa ou rotina) | 'agent_only' (sem âncora). */
  scope: string | null;
  items: CatalogItem[];
  total: number;
  truncated: boolean;
}

export interface AccessRequestResult {
  approvalId: number | null;
  deduped: boolean;
  status: string | null;
  resourceType: ResourceType | null;
  resourceId: number | null;
  resourceName: string | null;
  role: string | null;
  whoCanApprove: string[];
  routedToUserId: number | null;
  /** Frase pronta do servidor para o agente repetir na resposta. */
  message: string | null;
  /** Rodada 8 (kit-2/kit-7): o back confirma se guardou a continuação e se é desta conversa. null = back sem o eco. */
  continuation: ContinuationEcho | null;
}

/**
 * Busca pelo NÚMERO no catálogo (bancada F2-F6, t06): o back só filtra pelo nome,
 * então o kit lê a lista do tipo (até o teto do back, sem filtro) e procura o id.
 * Mesma visibilidade do catálogo por nome (o que o agente ou quem conversa vê):
 * nada que a busca pelo nome não mostraria.
 */
export interface CatalogIdLookup {
  anchor: AgentCatalog["anchor"];
  scope: string | null;
  /** O recurso com esse id, por tipo (no máximo um fluxo e um cadastro). */
  items: CatalogItem[];
  /** Tipos em que o id não apareceu e a lista veio cortada no teto: o id pode estar fora dela. */
  incompleteTypes: ResourceType[];
  raw: unknown[];
}

export interface ResourceAccessContracts {
  getAgentCatalog: (input?: { type?: CatalogType; q?: string; limit?: number }) => Promise<AgentCatalog & { raw: unknown }>;
  findAgentCatalogById: (input: { type?: CatalogType; id: number }) => Promise<CatalogIdLookup>;
  requestResourceAccess: (input: {
    type: ResourceType;
    resourceId: number;
    role?: AccessRole;
    reason: string;
    /**
     * Rodada 8 (D5): tarefa que o agente faz depois da liberação (`--then`). O back
     * guarda em `action_payload.continuation.goal` só quando o run é de conversa.
     */
    then?: string;
  }) => Promise<AccessRequestResult & { raw: unknown }>;
}

export function createResourceAccessContracts(client: CangeClient): ResourceAccessContracts {
  return {
    async getAgentCatalog(input = {}) {
      const type = input.type ?? "all";
      if (!(CATALOG_TYPES as readonly string[]).includes(type)) {
        throw new CangeValidationError(`--type precisa ser flow, register ou all (recebido: ${String(type)}).`);
      }
      const q = input.q?.trim();
      if (q && q.length > 120) throw new CangeValidationError("--q aceita no máximo 120 caracteres.");
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > CATALOG_MAX_LIMIT)) {
        throw new CangeValidationError(`--limit precisa ser um inteiro entre 1 e ${CATALOG_MAX_LIMIT}.`);
      }
      const raw = await client.get<unknown>("/agent-run/catalog", {
        query: { type, ...(q ? { q } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }
      });
      const normalized = normalizeCatalog(raw);
      // O back aplica o limit a CADA tipo (com 'all' vinham até 2x). O kit garante o
      // teto TOTAL, dividindo as vagas entre fluxos e cadastros (saída relida a cada turno).
      const items = capCatalogItems(normalized.items, input.limit ?? CATALOG_DEFAULT_LIMIT);
      return {
        raw,
        ...normalized,
        items,
        truncated: normalized.truncated || normalized.total > items.length
      };
    },

    async findAgentCatalogById(input) {
      const type = input.type ?? "all";
      if (!(CATALOG_TYPES as readonly string[]).includes(type)) {
        throw new CangeValidationError(`--type precisa ser flow, register ou all (recebido: ${String(type)}).`);
      }
      if (!Number.isSafeInteger(input.id) || input.id <= 0) {
        throw new CangeValidationError("O id do fluxo ou do cadastro deve ser um inteiro positivo.");
      }
      const types: ResourceType[] = type === "all" ? [...RESOURCE_TYPES] : [type as ResourceType];
      const lookup: CatalogIdLookup = { anchor: null, scope: null, items: [], incompleteTypes: [], raw: [] };
      // Um tipo por vez e com o teto do back: com 'all' o back divide o limite entre os tipos.
      for (const current of types) {
        const raw = await client.get<unknown>("/agent-run/catalog", {
          query: { type: current, limit: CATALOG_MAX_LIMIT }
        });
        lookup.raw.push(raw);
        const normalized = normalizeCatalog(raw);
        lookup.anchor ??= normalized.anchor;
        lookup.scope ??= normalized.scope;
        const hit = normalized.items.find((item) => item.type === current && item.id === input.id);
        if (hit) {
          lookup.items.push(hit);
        } else if (normalized.truncated || normalized.total > normalized.items.length) {
          lookup.incompleteTypes.push(current);
        }
      }
      return lookup;
    },

    async requestResourceAccess(input) {
      if (!(RESOURCE_TYPES as readonly string[]).includes(input.type)) {
        throw new CangeValidationError("Informe --flow <id> ou --register <id>.");
      }
      if (!Number.isInteger(input.resourceId) || input.resourceId <= 0) {
        throw new CangeValidationError("O id do fluxo ou do cadastro deve ser um inteiro positivo.");
      }
      const role = input.role ?? "M";
      if (role === ("A" as string)) throw new CangeValidationError(ACCESS_ROLE_ADMIN_REFUSED);
      if (!(ACCESS_ROLES as readonly string[]).includes(role)) {
        throw new CangeValidationError("--role só aceita M (membro).");
      }
      const reason = input.reason.replace(/\s+/g, " ").trim();
      if (!reason) throw new CangeValidationError("--reason é obrigatório: diga para que você precisa do acesso.");
      if (reason.length > ACCESS_REASON_MAX) {
        throw new CangeValidationError(`--reason aceita no máximo ${ACCESS_REASON_MAX} caracteres.`);
      }
      const thenIssue = nextTaskIssue(input.then);
      if (thenIssue) throw new CangeValidationError(`${thenIssue}.`);
      const then = normalizeNextTask(input.then);
      // Sem retry: o back deduplica o pedido pendente, mas repetir gastaria o
      // limite de pedidos e poderia notificar de novo.
      const raw = await client.post<unknown>("/agent-run/access-request", {
        body: { type: input.type, resource_id: input.resourceId, role, reason, ...(then ? { then } : {}) },
        retry: false
      });
      return { raw, ...normalizeAccessRequest(raw) };
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resourceTypeOrNull(value: unknown): ResourceType | null {
  return value === "flow" || value === "register" ? value : null;
}

export function normalizeCatalog(raw: unknown): AgentCatalog {
  const r = record(raw);
  const anchorRaw = r.anchor && typeof r.anchor === "object" ? record(r.anchor) : null;
  const items: CatalogItem[] = (Array.isArray(r.items) ? r.items : [])
    .map(record)
    .map((item) => {
      const id = numberOrNull(item.id);
      const type = resourceTypeOrNull(item.type);
      if (id === null || id <= 0 || type === null) return null;
      return {
        id,
        name: typeof item.name === "string" ? item.name : "",
        type,
        hasAccess: item.has_access === true,
        role: stringOrNull(item.role),
        requestable: item.requestable === true
      };
    })
    .filter((item): item is CatalogItem => item !== null);
  return {
    anchor: anchorRaw && stringOrNull(anchorRaw.kind)
      ? { kind: anchorRaw.kind as string, name: stringOrNull(anchorRaw.name) }
      : null,
    scope: stringOrNull(r.scope),
    items,
    total: numberOrNull(r.total) ?? items.length,
    truncated: r.truncated === true
  };
}

/**
 * Corta a lista em `cap` itens no total, mantendo a ordem de cada tipo. Metade das
 * vagas para cada tipo; a sobra de um tipo vai para o outro.
 */
export function capCatalogItems(items: CatalogItem[], cap: number): CatalogItem[] {
  if (items.length <= cap) return items;
  const flows = items.filter((item) => item.type === "flow");
  const registers = items.filter((item) => item.type === "register");
  const takeFlows = Math.min(flows.length, Math.max(Math.ceil(cap / 2), cap - registers.length));
  const takeRegisters = Math.min(registers.length, cap - takeFlows);
  return [...flows.slice(0, takeFlows), ...registers.slice(0, takeRegisters)];
}

export function normalizeAccessRequest(raw: unknown): AccessRequestResult {
  const r = record(raw);
  return {
    approvalId: numberOrNull(r.approval_id),
    deduped: r.deduped === true,
    status: stringOrNull(r.status),
    resourceType: resourceTypeOrNull(r.resource_type),
    resourceId: numberOrNull(r.resource_id),
    resourceName: stringOrNull(r.resource_name),
    role: stringOrNull(r.role),
    whoCanApprove: (Array.isArray(r.who_can_approve) ? r.who_can_approve : [])
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      .slice(0, 5),
    routedToUserId: numberOrNull(r.routed_to_user_id),
    message: stringOrNull(r.message),
    continuation: continuationEchoFromApi(r.continuation)
  };
}

/** "fluxo" | "cadastro". */
export function resourceNoun(type: ResourceType | null): string {
  return type === "register" ? "cadastro" : "fluxo";
}

/** Rótulo do papel ("Membro" é o único que o agente pede; os outros vêm do catálogo). */
export function roleLabel(role: string | null): string | null {
  if (role === "A") return "Administrador";
  if (role === "M") return "Membro";
  if (role === "V") return "Visualizador";
  return role;
}
