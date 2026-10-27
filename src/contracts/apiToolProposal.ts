import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";

/**
 * Onda 3 (bloco D): o agente PROPÕE uma ferramenta de API para si mesmo.
 * `POST /agent-api-tool-proposal` (só token de run) só cria o PEDIDO de aprovação:
 * a ferramenta passa a existir quando quem administra o agente abre o pedido, revisa,
 * digita a credencial num campo seguro, testa e aprova. Recusada, nada é criado.
 *
 * A proposta diz ONDE vai a credencial (`secret_headers: [{ key, hint }]`), nunca o
 * valor. O kit confere isso antes da rede (o back confere de novo, é a autoridade).
 */

export interface ApiToolProposalItem {
  key: string;
  value: string;
}

export interface ApiToolProposalParam {
  name: string;
  description?: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
}

export interface ApiToolProposalSecretSlot {
  key: string;
  hint?: string;
}

/** Segredo no CAMINHO da URL (`{{secret:nome}}`, ex.: Z-API): só o nome e a dica. */
export interface ApiToolProposalPathSlot {
  name: string;
  hint?: string;
}

export interface ApiToolProposalBody {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  query?: ApiToolProposalItem[];
  headers?: ApiToolProposalItem[];
  body?: { type: "json" | "form-data" | "x-www-form-urlencoded" | "xml"; content: string };
  timeout?: number;
  params?: ApiToolProposalParam[];
  secret_headers?: ApiToolProposalSecretSlot[];
  secret_path_params?: ApiToolProposalPathSlot[];
  docs_url?: string;
  reason?: string;
}

export interface ApiToolProposalResult {
  approvalId: number | null;
  deduped: boolean;
  status: string;
  summary: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const BODY_TYPES = ["json", "form-data", "x-www-form-urlencoded", "xml"] as const;
const PARAM_TYPES = ["string", "number", "boolean"] as const;
const TOP_KEYS = new Set([
  "name", "description", "method", "url", "query", "headers", "body", "timeout", "params", "secret_headers", "secret_path_params",
  "docs_url", "reason"
]);
const SECRET_PATH_TOKEN_RE = /\{\{secret:([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;
/** Segmento do caminho que anuncia a credencial no segmento seguinte (`/token/<valor>`). */
const CREDENTIAL_PATH_SEGMENT_RE = /^(token|key|apikey|api[-_]?key|access[-_]?token|secret|password|senha|client[-_]?token)$/i;
/** Campo que só pode ser o VALOR de uma credencial: nunca vem do agente. */
const SECRET_FIELDS = new Set(["value", "valueenc", "value_enc", "secret", "token", "password", "senha", "api_key", "apikey", "credential", "credentials"]);
/** Nome que É a credencial (cabeçalho, query ou parâmetro). `page_token` passa. */
const CREDENTIAL_NAME_RE = /^(x-)?(authorization|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|client[-_]?token|password|passwd|senha|private[-_]?key|credentials?)$/i;
const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Valores com cara de segredo, em QUALQUER texto da especificação (as mesmas heurísticas
 * do Cange, `SECRET_VALUE_RES`). Conferido antes de tudo: o `--dry-run` nunca imprime uma
 * chave (2ª revisão do Alex).
 */
export const SECRET_VALUE_RES: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bbasic\s+[A-Za-z0-9+/=]{16,}/i
];

/** Todo texto (chaves e valores) dentro da especificação, em qualquer profundidade. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}
const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export const API_TOOL_SECRET_RULE =
  "A credencial (chave, token, senha) nunca vai na proposta: diga só o cabeçalho onde ela vai em secret_headers " +
  "[{\"key\": \"Authorization\", \"hint\": \"Bearer <chave>\"}], sem valor; se a API leva a credencial no caminho da URL, escreva " +
  "{{secret:nome}} no caminho (ex.: /token/{{secret:token}}). Quem administra o agente digita o valor num campo " +
  "seguro ao revisar. Nunca peça a credencial na conversa.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new CangeValidationError(message);
}

function secretFail(where: string, fix?: string): never {
  throw new CangeValidationError(`Valor de credencial na proposta (${where}). ${fix ?? API_TOOL_SECRET_RULE}`, {
    details: { code: "API_TOOL_PROPOSAL_SECRET_VALUE", where }
  });
}

/**
 * E2E do D (run 244): `{token}` como parâmetro no caminho recebia só "valor de credencial"
 * e o agente não sabia corrigir. Cada recusa diz o que escrever, com exemplo curto (os
 * mesmos textos do Cange), para a 2ª tentativa dar certo sem ajuda.
 */
const PATH_SECRET_EXAMPLE =
  'Ex.: "url": "https://api.z-api.io/instances/{{secret:instancia}}/token/{{secret:token}}/send-text", ' +
  '"secret_path_params": [{"name": "instancia", "hint": "ID da instância"}, {"name": "token", "hint": "token da instância"}].';

/** Credencial no CAMINHO da url (`/token/<valor ou {param}>`). */
export function pathSecretFix(segment: string, next: string): string {
  const name = /^\{([a-zA-Z][a-zA-Z0-9_]*)\}$/.test(next) ? next.slice(1, -1) : segment.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `A credencial vai no caminho da URL (depois de /${segment}/) e não pode ser valor nem {parametro}: credencial nunca vira parâmetro. ` +
    `Escreva {{secret:${name}}} no lugar, liste em secret_path_params: [{"name": "${name}", "hint": "<onde achar>"}] e tire "${name}" de params. ` +
    "Quem administra o agente digita o valor ao aprovar.";
}

/** Credencial em CABEÇALHO (valor fixo ou `{param}`). */
export function headerSecretFix(key: string): string {
  return `O cabeçalho ${key} é credencial e não pode ter valor nem {parametro}: credencial nunca vira parâmetro. ` +
    `Tire ${key} de headers e liste em secret_headers: [{"key": "${key}", "hint": "<onde achar>"}], sem valor. ` +
    "Quem administra o agente digita o valor ao aprovar.";
}

/** Parâmetro do agente com nome de credencial. */
export function paramSecretFix(name: string): string {
  return `O parâmetro "${name}" é credencial: credencial nunca vira parâmetro do agente. Tire "${name}" de params. ` +
    `Se ela vai no caminho da URL, escreva {{secret:${name}}} no lugar e liste em secret_path_params: [{"name": "${name}", "hint": "<onde achar>"}]; ` +
    'se vai em cabeçalho, liste em secret_headers: [{"key": "<Cabeçalho>", "hint": "<onde achar>"}], sem valor.';
}

/** Um lugar da especificação com credencial onde não pode, e o que escrever no lugar. */
export interface SecretProblem {
  where: string;
  fix: string;
  withPathExample: boolean;
}

/** Todas numa resposta só (as mesmas regras do Cange): uma = a instrução; várias = numeradas. */
export function secretProblemsMessage(problems: SecretProblem[]): string {
  const example = problems.some((x) => x.withPathExample) ? ` ${PATH_SECRET_EXAMPLE}` : "";
  if (problems.length === 1) return `${problems[0]!.fix}${example}`;
  const list = problems.map((x, i) => `${i + 1}) ${x.fix}`).join(" ");
  return `A proposta põe credencial onde não pode em ${problems.length} lugares. Corrija todos de uma vez no mesmo arquivo: ${list}${example}`;
}

/** Credencial na QUERY (a proposta não aceita credencial na query). */
export function querySecretFix(key: string): string {
  return `A credencial na query (${key}) não é aceita na proposta. Se a API aceita a credencial em cabeçalho, liste em ` +
    'secret_headers: [{"key": "<Cabeçalho>", "hint": "<onde achar>"}]; se ela vai no caminho, use {{secret:nome}} no caminho ' +
    'e secret_path_params: [{"name": "nome", "hint": "<onde achar>"}]. Sem valor: quem administra o agente digita ao aprovar.';
}

function text(value: unknown, field: string, opts: { required?: boolean; max: number }): string | undefined {
  if (value === undefined || value === null) {
    if (opts.required) fail(`${field} é obrigatório.`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} precisa ser texto.`);
  const trimmed = value.trim();
  if (opts.required && !trimmed) fail(`${field} é obrigatório.`);
  if (trimmed.length > opts.max) fail(`${field} passa de ${opts.max} caracteres.`);
  return trimmed;
}

function items(value: unknown, field: string, problems: SecretProblem[]): ApiToolProposalItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${field} precisa ser uma lista de { key, value }.`);
  if (value.length > 20) fail(`${field}: no máximo 20 itens.`);
  return value.map((item, i) => {
    if (!isRecord(item)) fail(`${field}[${i}] precisa ser { key, value }.`);
    for (const k of Object.keys(item)) {
      if (k !== "key" && k !== "value") fail(`${field}[${i}]: campo desconhecido "${k}" (use só key e value).`);
    }
    const key = text(item.key, `${field}[${i}].key`, { required: true, max: 100 })!;
    const v = text(item.value ?? "", `${field}[${i}].value`, { max: 2000 }) ?? "";
    if (CREDENTIAL_NAME_RE.test(key) && v !== "") {
      problems.push({ where: `${field} ${key}`, fix: field === "headers" ? headerSecretFix(key) : querySecretFix(key), withPathExample: false });
    }
    return { key, value: v };
  });
}

/**
 * Lê e confere a especificação (o JSON do `--spec`). Erro de uso antes da rede:
 * forma, https, `{param}` declarado e NENHUM valor de credencial. Pura.
 */
export function buildApiToolProposalBody(raw: unknown): ApiToolProposalBody {
  if (!isRecord(raw)) fail("A especificação precisa ser um objeto JSON (veja `cange tool propose --help`).");
  // Antes de qualquer outra coisa (e antes do --dry-run imprimir o corpo): valor com cara de chave.
  if (allStrings(raw).some((t) => SECRET_VALUE_RES.some((re) => re.test(t)))) secretFail("texto com cara de chave, token ou senha");
  for (const k of Object.keys(raw)) {
    if (SECRET_FIELDS.has(k.toLowerCase())) secretFail(k);
    if (!TOP_KEYS.has(k)) fail(`Campo desconhecido na especificação: "${k}". Campos aceitos: ${[...TOP_KEYS].join(", ")}.`);
  }

  const name = text(raw.name, "name", { required: true, max: 80 })!;
  const description = text(raw.description, "description", { required: true, max: 500 })!;
  const method = String(raw.method ?? "").trim().toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) fail(`method aceita ${METHODS.join(", ")}.`);
  const url = text(raw.url, "url", { required: true, max: 2000 })!;
  if (!/^https:\/\//i.test(url)) fail("url precisa começar com https://.");
  const authority = url.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) secretFail("url (usuário e senha na URL)");
  if (/\{/.test(authority)) fail("O endereço (host) da url precisa ser fixo: use {parametro} só no caminho, na query, nos cabeçalhos ou no corpo.");
  const afterHost = url.slice("https://".length + authority.length);
  const pathPart = afterHost.split(/[?#]/, 1)[0] ?? "";
  const pathSecretNames = Array.from(new Set(Array.from(pathPart.matchAll(SECRET_PATH_TOKEN_RE), (m) => m[1]!)));
  // `/token/<valor>`: a credencial no caminho, fixa ou como parâmetro do agente.
  // Credencial fora do lugar: junta TODAS e responde numa vez só (E2E run 244).
  const secretProblems: SecretProblem[] = [];
  const segments = pathPart.split("/");
  segments.forEach((seg, i) => {
    const next = segments[i + 1];
    if (!CREDENTIAL_PATH_SEGMENT_RE.test(seg) || next === undefined || next === "") return;
    if (/^\{\{secret:[a-zA-Z][a-zA-Z0-9_]*\}\}$/.test(next)) return;
    secretProblems.push({ where: `url (caminho depois de /${seg}/)`, fix: pathSecretFix(seg, next), withPathExample: true });
  });

  let params: ApiToolProposalParam[] | undefined;
  if (raw.params !== undefined) {
    if (!Array.isArray(raw.params)) fail("params precisa ser uma lista.");
    const seen = new Set<string>();
    params = raw.params.map((p, i) => {
      if (!isRecord(p)) fail(`params[${i}] precisa ser { name, description, type, required }.`);
      const pname = text(p.name, `params[${i}].name`, { required: true, max: 60 })!;
      if (!IDENTIFIER_RE.test(pname)) fail(`params[${i}].name: comece com letra e use só letras, números e _.`);
      if (CREDENTIAL_NAME_RE.test(pname)) secretProblems.push({ where: `params ${pname}`, fix: paramSecretFix(pname), withPathExample: true });
      if (seen.has(pname)) fail(`Parâmetro repetido: ${pname}.`);
      seen.add(pname);
      const type = p.type === undefined ? "string" : String(p.type);
      if (!(PARAM_TYPES as readonly string[]).includes(type)) fail(`params[${i}].type aceita string, number ou boolean.`);
      const out: ApiToolProposalParam = { name: pname, type: type as ApiToolProposalParam["type"], required: p.required === true };
      const pdesc = text(p.description, `params[${i}].description`, { max: 300 });
      if (pdesc) out.description = pdesc;
      return out;
    });
  }

  let secretHeaders: ApiToolProposalSecretSlot[] | undefined;
  if (raw.secret_headers !== undefined) {
    if (!Array.isArray(raw.secret_headers)) fail("secret_headers precisa ser uma lista de { key, hint }.");
    if (raw.secret_headers.length > 5) fail("secret_headers: no máximo 5.");
    secretHeaders = raw.secret_headers.map((s, i) => {
      if (!isRecord(s)) fail(`secret_headers[${i}] precisa ser { key, hint }.`);
      for (const k of Object.keys(s)) {
        if (k === "key" || k === "hint") continue;
        if (SECRET_FIELDS.has(k.toLowerCase())) secretFail(`secret_headers ${k}`);
        fail(`secret_headers[${i}]: campo desconhecido "${k}" (use só key e hint).`);
      }
      const key = text(s.key, `secret_headers[${i}].key`, { required: true, max: 64 })!;
      const hint = text(s.hint, `secret_headers[${i}].hint`, { max: 120 });
      return hint ? { key, hint } : { key };
    });
  }

  let secretPathParams: ApiToolProposalPathSlot[] | undefined;
  if (raw.secret_path_params !== undefined) {
    if (!Array.isArray(raw.secret_path_params)) fail("secret_path_params precisa ser uma lista de { name, hint }.");
    secretPathParams = raw.secret_path_params.map((s, i) => {
      if (!isRecord(s)) fail(`secret_path_params[${i}] precisa ser { name, hint }.`);
      for (const k of Object.keys(s)) {
        if (k === "name" || k === "hint") continue;
        if (SECRET_FIELDS.has(k.toLowerCase())) secretFail(`secret_path_params ${k}`);
        fail(`secret_path_params[${i}]: campo desconhecido "${k}" (use só name e hint).`);
      }
      const pname = text(s.name, `secret_path_params[${i}].name`, { required: true, max: 60 })!;
      if (!pathSecretNames.includes(pname)) fail(`secret_path_params cita "${pname}", mas o caminho da url não usa {{secret:${pname}}}.`);
      const hint = text(s.hint, `secret_path_params[${i}].hint`, { max: 120 });
      return hint ? { name: pname, hint } : { name: pname };
    });
  }

  const query = items(raw.query, "query", secretProblems);
  const headers = items(raw.headers, "headers", secretProblems);
  if (secretProblems.length > 0) {
    throw new CangeValidationError(`Valor de credencial na proposta (${secretProblems.map((x) => x.where).join("; ")}). ${secretProblemsMessage(secretProblems)}`, {
      details: { code: "API_TOOL_PROPOSAL_SECRET_VALUE", where: secretProblems.map((x) => x.where) }
    });
  }
  let body: ApiToolProposalBody["body"];
  if (raw.body !== undefined && raw.body !== null) {
    if (!isRecord(raw.body)) fail("body precisa ser { type, content }.");
    const type = String(raw.body.type ?? "");
    if (!(BODY_TYPES as readonly string[]).includes(type)) fail(`body.type aceita ${BODY_TYPES.join(", ")}.`);
    if (typeof raw.body.content !== "string") fail("body.content precisa ser texto (o JSON do corpo como texto).");
    body = { type: type as NonNullable<ApiToolProposalBody["body"]>["type"], content: raw.body.content };
  }
  let timeout: number | undefined;
  if (raw.timeout !== undefined) {
    timeout = Number(raw.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) fail("timeout: segundos, de 1 a 120.");
  }

  // `{{secret:nome}}` só no CAMINHO da url (o Cange recusa na query, cabeçalho ou corpo).
  const outsidePath = [afterHost.slice(pathPart.length), ...(query ?? []).flatMap((q) => [q.key, q.value]),
    ...(headers ?? []).flatMap((h) => [h.key, h.value]), body?.content ?? ""];
  if (outsidePath.some((t) => /\{\{secret:/.test(t))) {
    fail("{{secret:nome}} só pode ficar no caminho da url. Para credencial em cabeçalho, use secret_headers (sem valor).");
  }

  // Todo {parametro} usado precisa estar em params (senão ninguém o preenche).
  const declared = new Set((params ?? []).map((p) => p.name));
  const used = [url, ...(query ?? []).map((q) => q.value), ...(headers ?? []).map((h) => h.value), body?.content ?? ""]
    .flatMap((t) => Array.from(t.matchAll(PLACEHOLDER_RE), (m) => m[1]!));
  const missing = Array.from(new Set(used.filter((n) => !declared.has(n))));
  if (missing.length > 0) fail(`Parâmetro usado e não declarado em params: ${missing.map((n) => `{${n}}`).join(", ")}.`);

  const docsUrl = text(raw.docs_url, "docs_url", { max: 500 });
  const reason = text(raw.reason, "reason", { max: 1000 });
  return {
    name,
    description,
    method: method as ApiToolProposalBody["method"],
    url,
    ...(query ? { query } : {}),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(params ? { params } : {}),
    ...(secretHeaders ? { secret_headers: secretHeaders } : {}),
    ...(secretPathParams ? { secret_path_params: secretPathParams } : {}),
    ...(docsUrl ? { docs_url: docsUrl } : {}),
    ...(reason ? { reason } : {})
  };
}

export function normalizeApiToolProposalResult(raw: unknown): ApiToolProposalResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = Number(r.approval_id);
  return {
    approvalId: Number.isInteger(id) && id > 0 ? id : null,
    deduped: r.deduped === true,
    status: typeof r.status === "string" ? r.status : "pending",
    summary: typeof r.summary === "string" ? r.summary : ""
  };
}

export interface ApiToolProposalContracts {
  proposeApiTool: (body: ApiToolProposalBody) => Promise<ApiToolProposalResult>;
}

export function createApiToolProposalContracts(client: CangeClient): ApiToolProposalContracts {
  return {
    async proposeApiTool(body) {
      const raw = await client.post<unknown>("/agent-api-tool-proposal", { body });
      return normalizeApiToolProposalResult(raw);
    }
  };
}
