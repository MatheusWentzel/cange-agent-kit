import type { Command } from "commander";

import { CangeApiError } from "../client/errors.js";
import { readJsonFile } from "../utils/files.js";

import { envCardId, envFlowId } from "./env-defaults.js";

/**
 * Bancada do lote F2-F6 (t06, run 444): o agente leu `card list` num fluxo sem
 * acesso, tomou o 404 do back ("Não foi possivel encontrar o fluxo ou você não
 * possuí acesso", exit 4), procurou no catálogo pelo nome, não achou e perguntou
 * ao usuário em vez de pedir acesso (nas outras 2 repetições ele pediu).
 *
 * Aqui o erro de API 403/404 de "sem acesso ou não encontrado" de um fluxo,
 * cadastro ou cartão referenciado por id ganha o campo `hint` com o comando de
 * pedido de acesso pronto, com o tipo e o id certos. A mensagem do back, o
 * código de saída (4) e os outros campos do JSON ficam como estão.
 *
 * O back não diferencia "não existe" de "sem acesso" (mesma frase, 404), daí o
 * "se o recurso existe". `access request` só pede fluxo ou cadastro: cartão sem
 * acesso vira o pedido do fluxo dele.
 */

type TargetType = "flow" | "register";

interface ResourceRefs {
  flow?: string;
  register?: string;
  card?: string;
}

/** Comandos que já tratam acesso do jeito deles (as dicas por código do back). */
const SKIP_COMMANDS: ReadonlySet<string> = new Set(["access request", "catalog"]);

const REASON = '--reason "<por que precisa>"';

const POSITIVE_INT_RE = /^[1-9]\d*$/;

/** "sem acesso", "não possuí/possui/tem acesso", "acesso negado". */
const ACCESS_PHRASE_RE = /\b(nao\s+(possui|tem)\s+acesso|sem\s+acesso|acesso\s+negado)\b/;
/** "Não foi possível encontrar o …", "… não encontrado". Só conta com o nome do recurso. */
const NOT_FOUND_PHRASE_RE = /\b(nao\s+foi\s+possivel\s+encontrar|nao\s+encontrad[oa]s?)\b/;

/** Recurso que NÃO é o fluxo, cadastro ou cartão do comando: a dica erraria o alvo. */
const OTHER_RESOURCE_RE =
  /\b(etapa|formulario|campo|anexo|artefato|checklist|visualizacao|automacao|workspace|usuario|condicional|template|comentario|agente|conversa|rotina|repositorio)s?\b/;

/**
 * Códigos do back em que o pedido de acesso não resolve: o fluxo passou na
 * checagem de acesso e o cartão não está nele (`GET /card`), ou está excluído.
 */
const NOT_AN_ACCESS_CODES: ReadonlySet<string> = new Set(["CARD_NOT_FOUND", "CARD_DELETED"]);

function backCode(error: CangeApiError): string | undefined {
  const details = error.details as { complement?: { code?: unknown }; code?: unknown } | undefined;
  const code = details?.complement?.code ?? details?.code ?? error.code;
  return typeof code === "string" ? code : undefined;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function positiveId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && POSITIVE_INT_RE.test(value.trim())) return value.trim();
  return undefined;
}

function firstId(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const id = positiveId(source[key]);
    if (id) return id;
  }
  return undefined;
}

const FLOW_KEYS = ["flowId", "idFlow", "flow", "flow_id", "id_flow"] as const;
const REGISTER_KEYS = ["registerId", "idRegister", "register", "register_id", "id_register"] as const;
const CARD_KEYS = ["cardId", "idCard", "card", "card_id", "id_card"] as const;

function declares(command: Command, attribute: string): boolean {
  return command.options.some((option) => option.attributeName() === attribute);
}

/** O `--payload` (avançado) traz o próprio flowId/registerId/cardId. Falha de leitura = sem ids. */
async function payloadRefs(path: unknown): Promise<ResourceRefs> {
  if (typeof path !== "string" || path.trim().length === 0) return {};
  try {
    const parsed = await readJsonFile<unknown>(path);
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    if (!record || typeof record !== "object") return {};
    return {
      flow: firstId(record, FLOW_KEYS),
      register: firstId(record, REGISTER_KEYS),
      card: firstId(record, CARD_KEYS)
    };
  } catch {
    return {};
  }
}

/**
 * Ids que o comando usou: opções (já normalizadas para o número), depois o
 * payload e, por fim, o ambiente do run, só quando o comando tem a opção e não
 * a recebeu. O fluxo do ambiente só vale sem cartão ou para o próprio cartão do
 * run: para outro cartão, o fluxo do ambiente não é o dele.
 */
async function commandRefs(command: Command, options: Record<string, unknown>): Promise<ResourceRefs> {
  const refs: ResourceRefs = {
    flow: firstId(options, FLOW_KEYS),
    register: firstId(options, REGISTER_KEYS),
    card: firstId(options, CARD_KEYS)
  };
  if (!refs.flow || !refs.register || !refs.card) {
    const fromPayload = await payloadRefs(options.payload);
    refs.flow ??= fromPayload.flow;
    refs.register ??= fromPayload.register;
    refs.card ??= fromPayload.card;
  }
  if (!refs.card && declares(command, "cardId")) refs.card = envCardId();
  if (!refs.flow && declares(command, "flowId")) {
    const runCard = envCardId();
    if (!refs.card || refs.card === runCard) refs.flow = envFlowId();
  }
  return refs;
}

function requestHint(type: TargetType, id: string): string {
  return `Se o recurso existe e você não tem acesso, peça: cange access request --${type} ${id} ${REASON}`;
}

function cardHint(flowId: string | undefined): string {
  if (flowId) {
    return `Se o cartão existe e você não tem acesso, peça acesso ao fluxo dele: cange access request --flow ${flowId} ${REASON}`;
  }
  return (
    `Se o cartão existe e você não tem acesso, peça acesso ao fluxo dele: cange access request --flow <id do fluxo> ${REASON} ` +
    "(ache o id em cange catalog --q <nome do fluxo>)"
  );
}

/** Sem o nome do recurso na frase (ou "registro", que o back usa para fluxo, cartão e cadastro): o que o comando referenciou. */
function hintFromRefs(refs: ResourceRefs): string | undefined {
  if (refs.register && !refs.flow) return requestHint("register", refs.register);
  if (refs.flow) return requestHint("flow", refs.flow);
  if (refs.card) return cardHint(undefined);
  return undefined;
}

/**
 * A linha de próximo passo para um erro de API, ou `undefined` quando o erro não
 * é "sem acesso ou não encontrado" de um recurso que o comando referenciou por id.
 */
export function noAccessHintFor(error: unknown, refs: ResourceRefs): string | undefined {
  if (!(error instanceof CangeApiError)) return undefined;
  if (error.status !== 403 && error.status !== 404) return undefined;
  if (error.hint !== undefined) return undefined;

  const code = backCode(error);
  if (code && NOT_AN_ACCESS_CODES.has(code)) return undefined;

  const text = normalize(error.message);
  // "Fluxo/Campo relacionado": o recurso é o do vínculo, não o do comando.
  if (/\brelacionad[oa]s?\b/.test(text)) return undefined;
  // Exige administrador (Flow Build, canvas): o pedido de acesso só dá Membro.
  if (/\badministrador(es)?\b/.test(text)) return undefined;

  const cardNoun = /\bregistro\s+do\s+fluxo\b/.test(text) || /\b(cartao|cartoes|card|cards)\b/.test(text);
  const flowNoun = !cardNoun && /\b(fluxo|fluxos|flow|flows)\b/.test(text);
  const registerNoun = !cardNoun && !flowNoun && /\b(cadastros?|registers?)\b/.test(text);
  const ambiguousNoun = /\bregistros?\b/.test(text);
  const named = cardNoun || flowNoun || registerNoun || ambiguousNoun;

  const accessPhrase = ACCESS_PHRASE_RE.test(text);
  if (!accessPhrase && !(named && NOT_FOUND_PHRASE_RE.test(text))) return undefined;

  if (flowNoun) {
    if (refs.flow) return requestHint("flow", refs.flow);
    return refs.card ? cardHint(undefined) : undefined;
  }
  if (cardNoun) return refs.card || refs.flow ? cardHint(refs.flow) : undefined;
  if (registerNoun) return refs.register ? requestHint("register", refs.register) : undefined;
  if (!ambiguousNoun && OTHER_RESOURCE_RE.test(text)) return undefined;
  return hintFromRefs(refs);
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let cursor: Command | null = command;
  while (cursor && cursor.parent) {
    names.unshift(cursor.name());
    cursor = cursor.parent;
  }
  return names.join(" ");
}

/**
 * Devolve o erro com o `hint` do pedido de acesso, quando cabe. Mesma classe
 * (exit 4 continua 4), mesma mensagem, mesmos campos.
 */
export async function withNoAccessHint(error: unknown, command: Command, options: unknown): Promise<unknown> {
  if (!(error instanceof CangeApiError)) return error;
  if (SKIP_COMMANDS.has(commandPath(command))) return error;
  const refs = await commandRefs(command, options && typeof options === "object" ? (options as Record<string, unknown>) : {});
  const hint = noAccessHintFor(error, refs);
  if (!hint) return error;
  const enriched = new CangeApiError(error.message, {
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
    ...(error.method !== undefined ? { method: error.method } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
    hint
  });
  if (error.stack) enriched.stack = error.stack;
  return enriched;
}
