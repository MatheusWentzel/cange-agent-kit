import type { Command } from "commander";

import { CangeApiError, CangeAuthError, CangeCliUsageError } from "../client/errors.js";

import { envCardId, envFlowId } from "./env-defaults.js";

/**
 * P7 (05/10, card #1367450): ids flexíveis nas opções de fluxo, cadastro e cartão.
 *
 * A cabeça do cliente traz o cadastro (ou o fluxo) por LINK do Cange, e o agente
 * passava o hash da URL em `--register-id`: 4 falhas de padrão `^\d+$` em produção.
 * Parser ÚNICO usado por todos os comandos (aplicado em `createCommandAction`):
 *
 *  - número (`7946`, `#7946`) passa direto;
 *  - URL do Cange (`https://app.cange.me/register/<hash>`, `.../flow/<hash>/card/<id>`,
 *    `cange://card/<id>?flow=<id>`, `cange://register/<id>/entry/<id>`, ou só o
 *    caminho `/flow/<hash>`): extrai o id ou o hash do recurso pedido;
 *  - hash (fluxo e cadastro): resolvido para o id por `GET /flow?hash=` e
 *    `GET /register?hash=` (as mesmas rotas que a tela usa). Sem acesso ou hash
 *    inexistente: erro de uso em 1 linha dizendo onde achar o id numérico.
 */

export type ResourceKind = "flow" | "register" | "card";

export type ResourceRef = { kind: "id"; id: string } | { kind: "hash"; hash: string };

/** O que um link do Cange diz sobre fluxo, cadastro e cartão. */
export interface CangeLinkParts {
  flow?: ResourceRef;
  register?: ResourceRef;
  cardId?: string;
  /**
   * Entrada (form answer) de cadastro: a menção do chat `cange://register/<id>/entry/<id>`
   * e o link da tela `…/register/<hash>/register/<id>`.
   */
  entryId?: string;
}

const NOUN: Record<ResourceKind, string> = { flow: "fluxo", register: "cadastro", card: "cartão" };

const WHERE_TO_FIND_ID: Record<ResourceKind, string> = {
  flow: "cange my-flows / cange catalog",
  register: "cange my-registers / cange catalog",
  card: "cange card list / cange my-tasks"
};

/** Hash de fluxo e cadastro: `object-hash` (sha1, 40 hex) no back; aceita outros formatos alfanuméricos. */
const HASH_RE = /^[A-Za-z0-9_-]{6,128}$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

/** Builder do front: `/flow/<0-3>/<hash>/<origem>` e `/register/<1-2>/<hash>/<origem>`. */
const BUILDER_STEP_RE = /^[0-3]$/;

const QUERY_KEYS: Record<ResourceKind, readonly string[]> = {
  flow: ["flow", "flow_id", "flowId", "id_flow"],
  register: ["register", "register_id", "registerId", "id_register"],
  card: ["card", "card_id", "cardId", "id_card"]
};

function looksLikeLink(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("/") || /(^|\.)cange\.me(\/|$)/i.test(raw);
}

function toUrl(raw: string): URL | undefined {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw);
    if (raw.startsWith("/")) return new URL(raw, "https://app.cange.me");
    return new URL(`https://${raw}`);
  } catch {
    return undefined;
  }
}

function refFromSegment(segment: string | undefined): ResourceRef | undefined {
  if (!segment) return undefined;
  const value = decodeURIComponent(segment).trim();
  if (POSITIVE_INT_RE.test(value)) return { kind: "id", id: value };
  if (HASH_RE.test(value)) return { kind: "hash", hash: value };
  return undefined;
}

/** `/flow/<hash>[/<origem>/<id>]` ou `/flow/<0-3>/<hash>/<origem>[/<id>]`. */
function resourceInPath(
  segments: string[],
  marker: "flow" | "register"
): { ref?: ResourceRef; origin?: string; id?: string } {
  const index = segments.indexOf(marker);
  if (index < 0) return {};
  let cursor = index + 1;
  if (BUILDER_STEP_RE.test(segments[cursor] ?? "") && segments[cursor + 1] && !POSITIVE_INT_RE.test(segments[cursor + 1]!)) {
    cursor += 1;
  }
  return { ref: refFromSegment(segments[cursor]), origin: segments[cursor + 1], id: segments[cursor + 2] };
}

/** Lê fluxo, cadastro e cartão de um link do Cange. `undefined` = não é link. */
export function parseCangeLink(raw: string): CangeLinkParts | undefined {
  const text = raw.trim();
  if (!looksLikeLink(text)) return undefined;
  const url = toUrl(text);
  if (!url) return undefined;

  const parts: CangeLinkParts = {};
  const segments = url.pathname.split("/").filter(Boolean);

  // Menção do chat: cange://card/<id>?flow=<id> e cange://register/<id>/entry/<id>
  if (url.protocol === "cange:") {
    segments.unshift(url.hostname);
  }

  const flow = resourceInPath(segments, "flow");
  if (flow.ref) parts.flow = flow.ref;
  if (flow.origin === "card" && flow.id && POSITIVE_INT_RE.test(flow.id)) parts.cardId = flow.id;

  const register = resourceInPath(segments, "register");
  if (register.ref) parts.register = register.ref;
  if (
    register.ref &&
    (register.origin === "entry" || register.origin === "register") &&
    register.id &&
    POSITIVE_INT_RE.test(register.id)
  ) {
    parts.entryId = register.id;
  }

  if (!parts.cardId) {
    const cardIndex = segments.indexOf("card");
    const next = cardIndex >= 0 ? segments[cardIndex + 1] : undefined;
    if (next && POSITIVE_INT_RE.test(next)) parts.cardId = next;
  }

  for (const kind of ["flow", "register", "card"] as const) {
    for (const key of QUERY_KEYS[kind]) {
      const value = url.searchParams.get(key)?.trim();
      if (!value) continue;
      if (kind === "card") {
        if (!parts.cardId && POSITIVE_INT_RE.test(value)) parts.cardId = value;
      } else if (!parts[kind]) {
        const ref = refFromSegment(value);
        if (ref) parts[kind] = ref;
      }
    }
  }
  return parts;
}

function hashHint(kind: ResourceKind, hash: string): string {
  return `Isso parece o hash do link (${hash}); use o id numérico do ${NOUN[kind]} (aparece em ${WHERE_TO_FIND_ID[kind]}).`;
}

/**
 * Classifica o valor de uma opção de id (sem rede). Lança erro de uso quando não
 * dá para tirar um id (ou hash, para fluxo e cadastro) do valor.
 */
export function parseResourceRef(raw: string, kind: ResourceKind, flag = `--${kind}-id`): ResourceRef {
  const text = String(raw).trim();
  const plain = text.replace(/^#/, "");
  if (POSITIVE_INT_RE.test(plain)) return { kind: "id", id: plain };

  const link = parseCangeLink(text);
  if (link) {
    if (kind === "card") {
      if (link.cardId) return { kind: "id", id: link.cardId };
      throw new CangeCliUsageError(
        `${flag}: o link não traz um cartão (…/flow/<hash>/card/<id>). Use o id numérico do cartão (aparece em ${WHERE_TO_FIND_ID.card}).`
      );
    }
    const ref = link[kind];
    if (ref) return ref;
    throw new CangeCliUsageError(
      `${flag}: o link não traz um ${NOUN[kind]}. Use o id numérico do ${NOUN[kind]} (aparece em ${WHERE_TO_FIND_ID[kind]}).`
    );
  }

  if (kind !== "card" && HASH_RE.test(plain)) return { kind: "hash", hash: plain };
  throw new CangeCliUsageError(
    `${flag} precisa do id numérico do ${NOUN[kind]}, de um link do Cange ou do hash do link (recebido: ${text || "vazio"}). ` +
      `O id aparece em ${WHERE_TO_FIND_ID[kind]}.`
  );
}

/** Resolve hash → id. Implementação real: `GET /flow?hash=` e `GET /register?hash=`. */
export type HashResolver = (kind: "flow" | "register", hash: string) => Promise<string | number | undefined>;

/** Cartão → fluxo. Implementação real: `GET /card/locate?id_card=` (F6). */
export type CardLocator = (cardId: string) => Promise<{ flowId: string | number; flowName?: string | null } | undefined>;

/** Fluxo descoberto pelo kit; o comando devolve isso em `resolved` na saída. */
export interface FlowResolution {
  flow_id: number;
  flow_name?: string | null;
  via: "card-locate";
}

/**
 * Dica única para "falta o fluxo": vale para todos os comandos de cartão. Sem o
 * fluxo, o kit descobre pelo número do cartão; quando não dá (cartão sem acesso,
 * inexistente ou back sem a rota), o caminho é o link do cartão ou o --flow-id.
 */
export const FLOW_FROM_CARD_HINT =
  "Sem o fluxo, o kit descobre pelo número do cartão (--card-id). Não deu para descobrir: confira o número, ou passe o link do cartão em --card-id ou --flow-id.";

/**
 * Devolve o id numérico (string) do valor de uma opção: número, link ou hash.
 * Hash sem acesso, inexistente ou sem resolvedor: erro de uso acionável (exit 2).
 */
export async function resolveResourceId(
  raw: string,
  kind: ResourceKind,
  resolveHash: HashResolver | undefined,
  flag?: string,
  unresolvedHint?: string
): Promise<string> {
  const ref = parseResourceRef(raw, kind, flag);
  if (ref.kind === "id") return ref.id;
  return resolveHashToId(kind as "flow" | "register", ref.hash, resolveHash, unresolvedHint);
}

async function resolveHashToId(
  kind: "flow" | "register",
  hash: string,
  resolveHash: HashResolver | undefined,
  unresolvedHint?: string
): Promise<string> {
  const hint = unresolvedHint ?? hashHint(kind, hash);
  if (!resolveHash) throw new CangeCliUsageError(hint);
  let id: string | number | undefined;
  try {
    id = await resolveHash(kind, hash);
  } catch (error) {
    if (error instanceof CangeAuthError) throw error;
    // 4xx = sem acesso ou hash que não existe: o agente precisa do id numérico.
    // 5xx/rede: o erro real segue (não é o agente que errou).
    if (error instanceof CangeApiError && (error.status === undefined || error.status >= 500)) throw error;
    throw new CangeCliUsageError(hint);
  }
  const text = id === undefined || id === null ? "" : String(id);
  if (!POSITIVE_INT_RE.test(text)) throw new CangeCliUsageError(hint);
  return text;
}

/**
 * K1 (review kit#22): no `access request` o recurso é, por definição, um que o agente
 * NÃO acessa, e `GET /flow?hash=` / `GET /register?hash=` dão 404 justamente por
 * falta de acesso. Hash ou link ali quase nunca resolve: o caminho é o catálogo.
 */
export const NO_ACCESS_LINK_HINT =
  "Não consigo ler esse link sem acesso. Procure pelo nome com cange catalog --q <nome> e peça com o id que aparecer.";

const UNRESOLVED_HINTS = new WeakMap<Command, string>();

/** Troca a mensagem de hash/link que não resolve, só neste comando. */
export function setUnresolvedHashHint(command: Command, hint: string): Command {
  UNRESOLVED_HINTS.set(command, hint);
  return command;
}

/** Opção (atributo do commander) → recurso. Nomes reais do kit, incluindo aliases legados. */
export const ID_OPTION_KINDS: Readonly<Record<string, ResourceKind>> = Object.freeze({
  flowId: "flow",
  idFlow: "flow",
  flow: "flow",
  registerId: "register",
  idRegister: "register",
  register: "register",
  cardId: "card",
  idCard: "card",
  card: "card"
});

/** Opções com LISTA de cartões separada por vírgula (`card read --card-ids`). */
const ID_LIST_OPTION_KINDS: Readonly<Record<string, ResourceKind>> = Object.freeze({ cardIds: "card" });

function flagOf(command: Command | undefined, attribute: string): string {
  const option = command?.options.find((candidate) => candidate.attributeName() === attribute);
  return option?.long ?? `--${attribute.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/**
 * Normaliza, NO LUGAR, as opções de id de um comando: número, link ou hash viram o
 * id numérico (string, como o commander entrega). Link de cartão sem `--flow-id`
 * preenche o fluxo quando o comando tem essa opção. Só chama a rede para hash e,
 * com `locateCard`, para descobrir o fluxo de um cartão dado só pelo número.
 *
 * Retorna a resolução do fluxo quando ela veio do `GET /card/locate` (o chamador
 * mostra em `resolved` na saída).
 */
export async function normalizeIdOptions(
  options: Record<string, unknown>,
  resolveHash: HashResolver | undefined,
  command?: Command,
  locateCard?: CardLocator
): Promise<{ resolved?: FlowResolution }> {
  const linkFlows: string[] = [];
  const unresolvedHint = command ? UNRESOLVED_HINTS.get(command) : undefined;

  for (const [attribute, kind] of Object.entries(ID_OPTION_KINDS)) {
    const value = options[attribute];
    if (typeof value !== "string") continue;
    const flag = flagOf(command, attribute);
    if (kind === "card") {
      const link = parseCangeLink(value);
      if (link?.flow?.kind === "id") linkFlows.push(link.flow.id);
      else if (link?.flow?.kind === "hash") linkFlows.push(link.flow.hash);
    }
    options[attribute] = await resolveResourceId(value, kind, resolveHash, flag, unresolvedHint);
  }

  for (const [attribute, kind] of Object.entries(ID_LIST_OPTION_KINDS)) {
    const value = options[attribute];
    if (typeof value !== "string") continue;
    const flag = flagOf(command, attribute);
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    const ids: string[] = [];
    for (const item of items) {
      ids.push(await resolveResourceId(item, kind, resolveHash, flag, unresolvedHint));
    }
    options[attribute] = ids.join(",");
  }

  // Link do cartão traz o fluxo: preenche --flow-id ausente (só se o comando tem a opção).
  const declaresFlowId = command ? command.options.some((option) => option.attributeName() === "flowId") : false;
  if (declaresFlowId && options.flowId === undefined && linkFlows.length > 0) {
    options.flowId = await resolveResourceId(linkFlows[0]!, "flow", resolveHash, "--flow-id", unresolvedHint);
  }

  // F6 (runs 357 e 362): o pedido traz só o número do cartão ("comente no cartão
  // 1121343"). Sem --flow-id e sem --payload (que traz o próprio flowId), o kit
  // pergunta ao back de qual fluxo é o cartão quando o ambiente não responde:
  //  - não há fluxo no ambiente do run; ou
  //  - há, mas o --card-id é OUTRO cartão (não o do run): o fluxo do ambiente é do
  //    cartão do run e pode não ser o deste. Se o locate não achar (404), o comando
  //    segue com o fluxo do ambiente, como antes.
  if (declaresFlowId && options.flowId === undefined && options.payload === undefined && locateCard !== undefined) {
    const cardId = singleCardId(options);
    if (cardId !== undefined && shouldLocate(cardId)) {
      const located = await locateFlowOfCard(cardId, locateCard);
      if (located) {
        options.flowId = String(located.flow_id);
        return { resolved: located };
      }
    }
  }
  return {};
}

function shouldLocate(cardId: string): boolean {
  if (envFlowId() === undefined) return true;
  const runCard = envCardId();
  return runCard !== undefined && runCard !== cardId;
}

function singleCardId(options: Record<string, unknown>): string | undefined {
  for (const [attribute, kind] of Object.entries(ID_OPTION_KINDS)) {
    if (kind !== "card") continue;
    const value = options[attribute];
    if (typeof value === "string" && POSITIVE_INT_RE.test(value)) return value;
  }
  return undefined;
}

/**
 * `undefined` quando o back não acha (404: cartão inexistente, sem acesso ou back
 * antigo sem a rota): o comando segue e dá o erro de sempre, com a dica do link.
 * 401 e 5xx/rede sobem (não é o agente que errou).
 */
async function locateFlowOfCard(cardId: string, locateCard: CardLocator): Promise<FlowResolution | undefined> {
  let located: Awaited<ReturnType<CardLocator>>;
  try {
    located = await locateCard(cardId);
  } catch (error) {
    if (error instanceof CangeAuthError) throw error;
    if (error instanceof CangeApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 401) {
      return undefined;
    }
    throw error;
  }
  const flowId = Number(located?.flowId);
  if (!Number.isInteger(flowId) || flowId <= 0) return undefined;
  return { flow_id: flowId, flow_name: located?.flowName ?? null, via: "card-locate" };
}
