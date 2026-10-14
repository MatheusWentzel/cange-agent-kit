import { CangeApiError, CangeAuthError, CangeValidationError } from "../client/errors.js";
import {
  CATALOG_MAX_LIMIT,
  RESOURCE_TYPES,
  resourceNoun,
  type CatalogIdLookup,
  type CatalogItem,
  type CatalogType,
  type ResourceType
} from "../contracts/resourceAccess.js";
import type { CangeAgentKit } from "../index.js";

import { ACCESS_REASON_FLAG } from "./no-access-hint.js";
import { parseCangeLink, type ResourceRef } from "./resource-ref.js";

/**
 * Bancada F2-F6 (t06, falhou no frio 5 min rep 3 e no quente rep 1): depois do "sem
 * acesso" no fluxo 316, o agente procurou `cange catalog --q 316`. O back busca só
 * pelo nome, não achou, e o agente perguntou ao usuário em vez de pedir acesso.
 *
 * Agora `--q`/`--search` com um inteiro positivo (`316`, `#316`) procura também pelo
 * id, e um link ou hash do Cange procura pelo id do fluxo ou cadastro dele. A busca
 * pelo id lê a MESMA lista do catálogo (o que o agente ou quem conversa vê) e filtra
 * pelo número: nada aparece que a busca pelo nome não mostraria. Fora do catálogo a
 * resposta é a de sempre ("não achei com o seu acesso"), sem dizer se existe; é a
 * mesma régua do `access request`, que recusa sem criar nada (404
 * `ACCESS_TARGET_NOT_FOUND`, ou 422 `ACCESS_NO_ANCHOR` numa execução sem conversa).
 *
 * Hash sem acesso não vira id: `GET /flow?hash=` e `GET /register?hash=` dão 404 por
 * falta de acesso (K1 do `access request`). O caminho continua sendo o nome.
 */

const ID_QUERY_RE = /^#?([1-9]\d*)$/;
/** Hash solto: só o formato do back (object-hash, hex). Texto comum segue como nome. */
const BARE_HASH_RE = /^[0-9a-f]{32,64}$/i;

export interface CatalogRef {
  type: ResourceType;
  ref: ResourceRef;
}

export type CatalogQuery =
  /** Busca só pelo nome (como antes). */
  | { kind: "name"; q?: string }
  /** Número: procura pelo id e também pelo nome (um fluxo pode ter o número no nome). */
  | { kind: "id"; id: number; q: string }
  /** Link ou hash do Cange: procura pelo id do fluxo ou cadastro dele (o nome não ajuda). */
  | { kind: "ref"; refs: CatalogRef[]; source: "link" | "hash"; cardOnly: boolean };

/** Classifica o `--q` do catálogo (sem rede). */
export function parseCatalogQuery(raw: string | undefined, type: CatalogType): CatalogQuery {
  const text = raw?.trim() ?? "";
  if (!text) return raw === undefined ? { kind: "name" } : { kind: "name", q: raw };

  const idMatch = ID_QUERY_RE.exec(text);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (Number.isSafeInteger(id)) return { kind: "id", id, q: idMatch[1]! };
    return { kind: "name", q: raw };
  }

  const link = parseCangeLink(text);
  if (link) {
    const refs: CatalogRef[] = [];
    if (link.flow) refs.push({ type: "flow", ref: link.flow });
    if (link.register) refs.push({ type: "register", ref: link.register });
    return { kind: "ref", refs, source: "link", cardOnly: refs.length === 0 && link.cardId !== undefined };
  }

  if (BARE_HASH_RE.test(text)) {
    const types: ResourceType[] = type === "all" ? [...RESOURCE_TYPES] : [type as ResourceType];
    return { kind: "ref", refs: types.map((current) => ({ type: current, ref: { kind: "hash", hash: text } })), source: "hash", cardOnly: false };
  }

  return { kind: "name", q: raw };
}

export interface CatalogIdTarget {
  /** Tipo procurado (com `all`, fluxo e cadastro). */
  type: CatalogType;
  id: number;
  lookup: CatalogIdLookup;
}

export interface CatalogIdResult {
  targets: CatalogIdTarget[];
  /** Hash do link que não abriu (sem acesso ou não existe): não deu para saber o id. */
  unresolved: CatalogRef[];
}

/** Hash → id pelas rotas da tela. 4xx (sem acesso ou não existe) = `undefined`; 401, 429, 5xx e rede sobem. */
async function idOfRef(kit: CangeAgentKit, ref: CatalogRef): Promise<number | undefined> {
  if (ref.ref.kind === "id") {
    const id = Number(ref.ref.id);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  try {
    const result =
      ref.type === "flow"
        ? await kit.contracts.getFlow({ hash: ref.ref.hash })
        : await kit.contracts.getRegister({ hash: ref.ref.hash });
    const id = Number(result.summary.id);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch (error) {
    if (error instanceof CangeAuthError) throw error;
    if (error instanceof CangeValidationError) return undefined;
    if (
      error instanceof CangeApiError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 429
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Procura no catálogo pelo id (número, ou o id do link/hash). Leituras uma por vez. */
export async function lookupCatalogIds(
  kit: CangeAgentKit,
  query: Exclude<CatalogQuery, { kind: "name" }>,
  type: CatalogType
): Promise<CatalogIdResult> {
  const result: CatalogIdResult = { targets: [], unresolved: [] };
  if (query.kind === "id") {
    result.targets.push({ type, id: query.id, lookup: await kit.contracts.findAgentCatalogById({ type, id: query.id }) });
    return result;
  }

  const seen = new Set<string>();
  const resolvedHashes = new Set<string>();
  for (const ref of query.refs) {
    // Hash solto com --type all: é de um recurso só; achou como fluxo, não tenta cadastro.
    if (ref.ref.kind === "hash" && resolvedHashes.has(ref.ref.hash)) continue;
    const id = await idOfRef(kit, ref);
    if (id === undefined) {
      result.unresolved.push(ref);
      continue;
    }
    if (ref.ref.kind === "hash") resolvedHashes.add(ref.ref.hash);
    const key = `${ref.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.targets.push({ type: ref.type, id, lookup: await kit.contracts.findAgentCatalogById({ type: ref.type, id }) });
  }
  // O hash que abriu num tipo não conta como "não abriu" no outro.
  result.unresolved = result.unresolved.filter((ref) => ref.ref.kind !== "hash" || !resolvedHashes.has(ref.ref.hash));
  return result;
}

/** O comando de pedido pronto para o item (mesma frase do `hint` do erro sem acesso). */
export function accessRequestCommand(item: Pick<CatalogItem, "type" | "id">): string {
  return `cange access request --${item.type} ${item.id} ${ACCESS_REASON_FLAG}`;
}

function nouns(types: readonly ResourceType[]): string {
  const unique = Array.from(new Set(types));
  if (unique.length === 1) return `${resourceNoun(unique[0]!)}s`;
  return "fluxos e cadastros";
}

function typesOf(type: CatalogType): ResourceType[] {
  return type === "all" ? [...RESOURCE_TYPES] : [type as ResourceType];
}

function foundNote(item: CatalogItem): string {
  const label = `O ${resourceNoun(item.type)} ${item.id}`;
  if (item.hasAccess) return `${label} está no seu catálogo e você já tem acesso: leia direto, sem pedir acesso.`;
  if (!item.requestable) {
    return `${label} está no seu catálogo sem acesso, e o Cange não aceita pedido para ele: diga ao usuário que alguém com permissão precisa adicionar o agente.`;
  }
  return (
    `${label} está no seu catálogo e você não tem acesso: peça agora com o comando do item ` +
    `(${accessRequestCommand(item)}), com o motivo real e sem perguntar ao usuário se deve pedir; ` +
    "se o acesso é um meio para o que pediram, passe também `--then \"<o que falta fazer>\"`. Na resposta, diga quem pode liberar."
  );
}

function notFoundNote(target: CatalogIdTarget): string {
  const incomplete = target.lookup.incompleteTypes;
  if (incomplete.length > 0) {
    const commands = incomplete.map((type) => `cange access request --${type} ${target.id} ${ACCESS_REASON_FLAG}`).join(" ou ");
    return (
      `O id ${target.id} não apareceu nos ${CATALOG_MAX_LIMIT} primeiros ${nouns(incomplete)} do seu catálogo (a lista é maior): ` +
      `procure pelo nome com --q <parte do nome>; se precisa do acesso, pode pedir direto com ${commands} ` +
      "(fora do seu catálogo, o Cange recusa o pedido sem criar nada)."
    );
  }
  return (
    `O id ${target.id} não está entre os ${nouns(typesOf(target.type))} do seu catálogo: não peça acesso por ele ` +
    "(o Cange recusa o pedido) e não diga que não existe; diga ao usuário que não achou com o seu acesso e peça o nome ou o link."
  );
}

/** Notas da busca pelo id (vão antes das notas gerais do catálogo). */
export function catalogIdNotes(query: Exclude<CatalogQuery, { kind: "name" }>, result: CatalogIdResult): string[] {
  const notes: string[] = [];
  if (query.kind === "ref" && query.refs.length === 0) {
    notes.push(
      query.cardOnly
        ? "Esse link é de um cartão e não traz o fluxo: procure o fluxo pelo nome com --q <nome do fluxo> ou peça ao usuário o link do fluxo."
        : "Esse link não traz fluxo nem cadastro: procure pelo nome com --q <nome>."
    );
    return notes;
  }
  for (const target of result.targets) {
    if (target.lookup.items.length === 0) notes.push(notFoundNote(target));
    for (const item of target.lookup.items) notes.push(foundNote(item));
  }
  if (result.unresolved.length > 0 && result.targets.length === 0) {
    notes.push(
      `Não consigo abrir esse ${query.kind === "ref" && query.source === "hash" ? "hash" : "link"} sem acesso, então não sei o id: ` +
        "procure pelo nome com cange catalog --q <nome> e peça com o id que aparecer. Não diga que não existe."
    );
  }
  return notes;
}
