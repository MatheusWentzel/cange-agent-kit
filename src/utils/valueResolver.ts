import type { NormalizedField } from "../schemas/fields.js";

import {
  extractAllowedOptionDescriptors,
  normalizeFieldType,
  validateValueByFieldType,
  type OptionDescriptor
} from "./fieldTypeGuards.js";
import { isEmptyForField, isRequiredOnScreen } from "./requiredFields.js";

export { isHiddenOnForm } from "./requiredFields.js";

/**
 * P4 (05/10, card #1367455): resolvedor ÚNICO de valores de escrita.
 *
 * 27 erros de validação em 13 runs: número como texto (7x, o agente não aprende
 * entre runs), título do campo como chave (4x), hash "não existe" porque o mover
 * filtrava pelo idForm errado (10x), cadastro como texto (2x), obrigatório
 * ausente (4x). Todas as escritas (card create, update-values, move, add-child,
 * register create/update) passam por aqui:
 *
 *  - CHAVE: hash (`name`), id numérico ou TÍTULO do campo (sem maiúscula/acento,
 *    espaços normalizados). Título repetido: vale o formulário de prioridade
 *    menor (ex.: etapa atual antes do inicial); empate = erro com as opções.
 *  - VALOR: número/moeda em texto ("2.500,00", "R$ 2.500,00", "2500.5"), data
 *    "06/10/2026" ou ISO, rótulo de opção, usuário por id/e-mail/nome, cadastro
 *    por id ou rótulo da entrada (busca no cadastro).
 *  - ERRO: tudo de uma vez, numa mensagem curta (`formatValueIssues`).
 */

/** Um formulário em que as chaves podem cair (inicial, etapa atual, destino, cadastro). */
export interface FormScope {
  formId: string;
  /** Rótulo humano: "formulário inicial", "etapa Agendamento", "cadastro Clientes". */
  label: string;
  fields: NormalizedField[];
  /** Menor = preferido quando o mesmo título aparece em mais de um formulário. */
  priority: number;
}

export interface RegisterEntryCandidate {
  id: number;
  title: string;
}

export interface CompanyUser {
  id: number;
  name?: string;
  email?: string;
}

/** Consultas sob demanda (só chamadas quando o valor precisa). */
export interface ResolverLookups {
  searchRegisterEntries?: (registerId: string, text: string) => Promise<RegisterEntryCandidate[]>;
  listUsers?: () => Promise<CompanyUser[]>;
}

export type ValueIssueKind =
  | "unknown_field"
  | "ambiguous_field"
  | "out_of_scope"
  | "invalid_value"
  | "missing_required"
  /** O mover não pode seguir como veio (etapa de origem errada, campo que ficaria vazio). */
  | "move_conflict"
  /** Como resolver (não bloqueia sozinho): sai no fim da mensagem, só quando há bloqueio. */
  | "hint";

export interface ValueIssue {
  kind: ValueIssueKind;
  /** Frase curta, pronta para a mensagem. */
  text: string;
  /** Formulário do problema (agrupa os obrigatórios ausentes numa linha). */
  formLabel?: string;
  /** Campo em "Título (tipo)", para a linha de obrigatórios. */
  fieldLabel?: string;
  blocking: boolean;
}

export interface ResolvedValue {
  /** Chave como veio (título, id ou hash). */
  key: string;
  field: NormalizedField;
  form: FormScope;
  value: unknown;
}

export interface ResolveResult {
  resolved: ResolvedValue[];
  issues: ValueIssue[];
  /** Chaves técnicas desconhecidas mantidas como vieram (payload por arquivo sem validação). */
  passthrough: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/** Minúsculas, sem acento, espaços normalizados, sem `*`/`:` no fim (rótulo de tela). */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s*:]+$/, "")
    .trim();
}

/**
 * Chave que NÃO é hash nem id: tem espaço, acento ou começa com maiúscula.
 * Só ela obriga o kit a consultar os campos quando o payload vem de arquivo sem
 * `--validate-fields` (hash e chave técnica seguem direto, sem GET extra).
 */
export function looksLikeTitleKey(key: string): boolean {
  return /\s/.test(key) || /[^\x00-\x7F]/.test(key) || /^[A-Z]/.test(key);
}

// ---------------------------------------------------------------------------
// Número
// ---------------------------------------------------------------------------

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * "2500", "2500.5", "2.500,00", "R$ 2.500,00", "1,234.56", "-3,5".
 * Ambíguo ("2.500" ou "1,500": milhar ou decimal?) = erro pedindo a forma sem dúvida.
 */
export function parseLocaleNumber(raw: string): ParseOutcome<number> {
  let text = raw.trim().replace(/^r\$\s*/i, "").replace(/^\$\s*/, "").replace(/\s+/g, "");
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  text = text.replace(/^r\$/i, "");

  if (!/^[0-9][0-9.,]*$/.test(text) || /[.,]$/.test(text)) {
    return { ok: false, error: `"${raw}" não é número` };
  }

  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;

  const groupsOk = (intPart: string, sep: string): boolean => {
    const groups = intPart.split(sep);
    return /^\d{1,3}$/.test(groups[0] ?? "") && groups.slice(1).every((group) => /^\d{3}$/.test(group));
  };

  let normalized: string;
  if (dots > 0 && commas > 0) {
    const last = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
    const decimalSep = text[last]!;
    const thousandsSep = decimalSep === "." ? "," : ".";
    const intPart = text.slice(0, last);
    const fraction = text.slice(last + 1);
    if (intPart.includes(decimalSep) || !groupsOk(intPart, thousandsSep) || !/^\d+$/.test(fraction)) {
      return { ok: false, error: `"${raw}" não é número` };
    }
    normalized = `${intPart.split(thousandsSep).join("")}.${fraction}`;
  } else if (dots + commas === 1) {
    const sep = dots === 1 ? "." : ",";
    const [intPart = "", fraction = ""] = text.split(sep);
    if (fraction.length === 3 && intPart !== "0") {
      return {
        ok: false,
        error: `"${raw}" é ambíguo (milhar ou decimal?): escreva ${intPart}${fraction} ou ${intPart}${sep === "." ? "," : "."}${fraction}`
      };
    }
    normalized = `${intPart}.${fraction}`;
  } else if (dots + commas > 1) {
    const sep = dots > 0 ? "." : ",";
    if (!groupsOk(text, sep)) {
      return { ok: false, error: `"${raw}" não é número` };
    }
    normalized = text.split(sep).join("");
  } else {
    normalized = text;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `"${raw}" não é número` };
  }
  return { ok: true, value: sign * value };
}

/**
 * K4: número LIDO do banco (`value` de campo número/moeda/fórmula), não digitado por
 * gente. Espelha o `parseNumber` do back (CardFieldSnapshotService), o mesmo que
 * alimenta o `value_number` que o agregador do V2 soma. Assim a soma do V1 bate com a
 * do V2: separador sozinho é decimal ("1.500" = 1,5; "12,345" = 12,345); com os dois,
 * o último é o decimal ("1.234,56", "1,234.56"). Nunca "ambíguo": o banco tem um
 * formato só. Para entrada do usuário use `parseLocaleNumber`.
 */
export function parseStoredNumber(raw: string | number): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  let cleaned = raw.replace(/[R$\s]/g, "");
  if (cleaned === "") return undefined;
  const isPercent = /\d%$/.test(cleaned);
  if (isPercent) cleaned = cleaned.slice(0, -1);
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    cleaned =
      cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, ".");
  }
  // Texto que não é número inteiro (ex.: "abc", "12abc") fica de fora, ao contrário
  // do parseFloat do back, que aceitaria o prefixo: aqui ele vira `ignored` na soma.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return undefined;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return undefined;
  return isPercent ? value / 100 : value;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * "06/10/2026", "06/10/2026 14:30", "2026-10-06", "2026-10-06T14:30", ISO com fuso.
 * Sai no formato que os campos de data gravam (ISO 8601 em UTC, como o
 * `toISOString` da tela). Data sem fuso é hora LOCAL (o runner roda em
 * America/Sao_Paulo), igual à tela.
 */
export function parseFlexibleDate(raw: string): ParseOutcome<string> {
  const text = raw.trim();
  const invalid: ParseOutcome<string> = {
    ok: false,
    error: `"${raw}" não é data (use dd/mm/aaaa, dd/mm/aaaa hh:mm ou aaaa-mm-dd)`
  };

  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (br) {
    const [, d, m, y, hh, mi, ss] = br;
    return localDate(Number(y), Number(m), Number(d), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0)) ?? invalid;
  }

  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDateOnly) {
    const [, y, m, d] = isoDateOnly;
    return localDate(Number(y), Number(m), Number(d), 0, 0, 0) ?? invalid;
  }

  const isoLocal = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
  if (isoLocal) {
    const [, y, m, d, hh, mi, ss] = isoLocal;
    return localDate(Number(y), Number(m), Number(d), Number(hh), Number(mi), Number(ss ?? 0)) ?? invalid;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? invalid : { ok: true, value: date.toISOString() };
  }

  return invalid;
}

function localDate(y: number, m: number, d: number, hh: number, mi: number, ss: number): ParseOutcome<string> | undefined {
  const date = new Date(y, m - 1, d, hh, mi, ss);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d ||
    hh > 23 ||
    mi > 59 ||
    ss > 59
  ) {
    return undefined;
  }
  return { ok: true, value: date.toISOString() };
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

const NUMBER_TYPES = new Set(["NUMBER_FIELD", "NUMERIC_FIELD", "CURRENCY_FIELD", "MONEY_FIELD"]);
const MONEY_TYPES = new Set(["CURRENCY_FIELD", "MONEY_FIELD"]);
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD", "DATE_FIELD"]);
const SINGLE_OPTION_TYPES = new Set(["COMBO_BOX_FIELD", "RADIO_BOX_FIELD"]);
const MULTI_OPTION_TYPES = new Set(["CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
const USER_TYPES = new Set(["COMBO_BOX_USER_FIELD", "USER_FIELD", "REQUESTER_FIELD"]);
const REGISTER_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "REGISTER_FIELD"]);
const FLOW_LINK_TYPES = new Set(["COMBO_BOX_FLOW_FIELD", "FLOW_FIELD"]);
const BOOLEAN_TYPES = new Set(["SWITCH_FIELD", "TOGGLE_FIELD"]);
const TEXT_TYPES = new Set([
  "TEXT_SHORT_FIELD",
  "TEXT_LONG_FIELD",
  "RICH_TEXT_FIELD",
  "INPUT_RICH_TEXT_FIELD",
  "HTML_FIELD",
  "PHONE_FIELD",
  "PHONE_NUMBER_FIELD",
  "DOC_FIELD",
  "DOCUMENT_FIELD",
  "DOCUMENTS_FIELD",
  "LINK_FIELD",
  "URL_FIELD",
  "MAIL_FIELD",
  "EMAIL_FIELD",
  "DYNAMIC_TEXT_FIELD"
]);

function optionsOf(field: NormalizedField): OptionDescriptor[] {
  return extractAllowedOptionDescriptors(field.options);
}

function optionLabels(field: NormalizedField): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const option of optionsOf(field)) {
    const label = option.label ?? String(option.value);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.slice(0, 12).join(" | ") + (labels.length > 12 ? " | ..." : "");
}

function isPercentField(field: NormalizedField): boolean {
  const variation = field.variation ?? (typeof field.raw?.variation === "string" ? field.raw.variation : undefined);
  return normalizeFieldType(field.type) === "NUMBER_FIELD" && variation === "2";
}

/** Tipo esperado em linguagem de gente, para as mensagens ("moeda", "Sim | Não"). */
export function describeExpected(field: NormalizedField): string {
  const type = normalizeFieldType(field.type);
  if (MONEY_TYPES.has(type)) return "moeda";
  if (isPercentField(field)) return "percentual, ex.: 90%";
  if (NUMBER_TYPES.has(type)) return "número";
  if (DATE_TYPES.has(type)) return "data";
  if (SINGLE_OPTION_TYPES.has(type)) return optionLabels(field) || "opção";
  if (MULTI_OPTION_TYPES.has(type)) return `lista de: ${optionLabels(field) || "opções"}`;
  if (USER_TYPES.has(type)) return "usuário: id, e-mail ou nome";
  if (REGISTER_TYPES.has(type)) return "cadastro: id ou nome da entrada";
  if (FLOW_LINK_TYPES.has(type)) return "cartão: id";
  if (BOOLEAN_TYPES.has(type)) return "sim ou não";
  if (type === "MAIL_FIELD" || type === "EMAIL_FIELD") return "e-mail";
  if (type === "DOC_FIELD") return "CPF/CNPJ";
  if (TEXT_TYPES.has(type)) return "texto";
  return type.replace(/_FIELD$/, "").toLowerCase();
}

/** "da etapa X" / "do formulário inicial" / "do cadastro 175". */
export function withArticle(label: string, kind: "de" | "para"): string {
  const feminine = /^etapa\b/i.test(label);
  if (kind === "de") return `${feminine ? "da" : "do"} ${label}`;
  return `${feminine ? "a" : "o"} ${label}`;
}

function fieldLabel(field: NormalizedField): string {
  return field.title ?? field.name;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim().length === 0);
}

/** Texto do --set que é lista JSON (`[1,2]`, `["A","B"]`). */
function parseJsonArray(text: string): unknown[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toIdNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^#?\d+$/.test(value.trim())) {
    const n = Number(value.trim().replace(/^#/, ""));
    return n > 0 ? n : undefined;
  }
  return undefined;
}

type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

function matchOption(field: NormalizedField, raw: unknown): ParseOutcome<string | number> {
  const options = optionsOf(field);
  if (options.length === 0) {
    return typeof raw === "string" || typeof raw === "number"
      ? { ok: true, value: raw }
      : { ok: false, error: "valor de opção inválido" };
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, error: `use uma das opções: ${optionLabels(field)}` };
  }
  const text = String(raw);
  const exact = options.find((option) => String(option.value) === text);
  if (exact) return { ok: true, value: exact.value };
  const wanted = normalizeText(text);
  const byLabel = options.find((option) => option.label !== undefined && normalizeText(option.label) === wanted);
  if (byLabel) return { ok: true, value: byLabel.value };
  const byValue = options.find((option) => normalizeText(String(option.value)) === wanted);
  if (byValue) return { ok: true, value: byValue.value };
  return { ok: false, error: `"${text}" não é opção (${optionLabels(field)})` };
}

function splitList(text: string): string[] {
  const separator = text.includes(";") ? ";" : ",";
  return text
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function resolveUser(raw: unknown, lookups: ResolverLookups | undefined): Promise<Coerced> {
  const id = toIdNumber(raw);
  if (id !== undefined) return { ok: true, value: id };
  if (typeof raw !== "string") return { ok: false, error: "use o id, o e-mail ou o nome do usuário" };
  const text = raw.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

  let users: CompanyUser[] | undefined;
  try {
    users = lookups?.listUsers ? await lookups.listUsers() : undefined;
  } catch {
    users = undefined;
  }
  if (!users) {
    // Sem a lista, o e-mail segue como texto: o back resolve e-mail → usuário.
    return isEmail
      ? { ok: true, value: text }
      : { ok: false, error: `não deu para buscar o usuário "${text}": use o id ou o e-mail` };
  }

  if (isEmail) {
    const hit = users.find((user) => user.email?.toLowerCase() === text.toLowerCase());
    return hit ? { ok: true, value: hit.id } : { ok: false, error: `nenhum usuário com o e-mail ${text}` };
  }

  const wanted = normalizeText(text);
  const exact = users.filter((user) => user.name !== undefined && normalizeText(user.name) === wanted);
  const pool =
    exact.length > 0
      ? exact
      : users.filter((user) => user.name !== undefined && normalizeText(user.name).includes(wanted));
  if (pool.length === 1) return { ok: true, value: pool[0]!.id };
  if (pool.length === 0) return { ok: false, error: `nenhum usuário chamado "${text}"` };
  return {
    ok: false,
    error: `"${text}" é ambíguo: ${pool
      .slice(0, 8)
      .map((user) => `${user.name} (id ${user.id}${user.email ? `, ${user.email}` : ""})`)
      .join(", ")}`
  };
}

async function resolveRegisterEntry(
  field: NormalizedField,
  label: string,
  lookups: ResolverLookups | undefined
): Promise<ParseOutcome<number>> {
  const registerId = field.raw?.register_id ?? field.raw?.registerId;
  if (registerId === undefined || registerId === null || !lookups?.searchRegisterEntries) {
    return { ok: false, error: `use o id da entrada (cange register entries --search "${label}")` };
  }
  let entries: RegisterEntryCandidate[];
  try {
    entries = await lookups.searchRegisterEntries(String(registerId), label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `não deu para buscar "${label}" no cadastro ${registerId} (${message})` };
  }
  const wanted = normalizeText(label);
  const exact = entries.filter((entry) => normalizeText(entry.title) === wanted);
  const pool = exact.length > 0 ? exact : entries;
  if (pool.length === 1) return { ok: true, value: pool[0]!.id };
  if (pool.length === 0) {
    return { ok: false, error: `nenhuma entrada "${label}" no cadastro ${registerId}` };
  }
  return {
    ok: false,
    error: `"${label}" casa com ${pool.length} entradas: ${pool
      .slice(0, 8)
      .map((entry) => `${entry.title} (id ${entry.id})`)
      .join(", ")}${pool.length > 8 ? ", ..." : ""}. Use o id`
  };
}

/** Converte o valor para o formato que o campo grava. Não lança. */
export async function coerceFieldValue(
  field: NormalizedField,
  raw: unknown,
  lookups?: ResolverLookups
): Promise<Coerced> {
  if (isEmptyValue(raw)) return { ok: true, value: raw };
  const type = normalizeFieldType(field.type);

  if (NUMBER_TYPES.has(type)) {
    if (typeof raw === "number") return { ok: true, value: raw };
    if (typeof raw !== "string") return { ok: false, error: "não é número" };
    const percent = isPercentField(field) && raw.trim().endsWith("%");
    const parsed = parseLocaleNumber(percent ? raw.trim().slice(0, -1) : raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: percent ? Number((parsed.value / 100).toPrecision(12)) : parsed.value };
  }

  if (DATE_TYPES.has(type)) {
    if (typeof raw !== "string") return { ok: false, error: "data em texto (dd/mm/aaaa ou aaaa-mm-dd)" };
    return parseFlexibleDate(raw);
  }

  if (SINGLE_OPTION_TYPES.has(type)) {
    return matchOption(field, raw);
  }

  if (MULTI_OPTION_TYPES.has(type)) {
    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === "string") {
      const asJson = parseJsonArray(raw);
      if (asJson) {
        items = asJson;
      } else {
        const whole = matchOption(field, raw);
        items = whole.ok ? [raw] : splitList(raw);
      }
    } else {
      items = [raw];
    }
    const values: string[] = [];
    for (const item of items) {
      const hit = matchOption(field, item);
      if (!hit.ok) return hit;
      values.push(String(hit.value));
    }
    return { ok: true, value: values };
  }

  if (USER_TYPES.has(type)) {
    return resolveUser(raw, lookups);
  }

  if (REGISTER_TYPES.has(type) || FLOW_LINK_TYPES.has(type)) {
    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === "string") {
      const asJson = parseJsonArray(raw);
      const list = asJson ?? splitList(raw);
      items = list.every((item) => toIdNumber(item) !== undefined) ? list : asJson ?? (raw.includes(";") ? splitList(raw) : [raw]);
    } else {
      items = [raw];
    }
    const ids: number[] = [];
    for (const item of items) {
      const id = toIdNumber(item);
      if (id !== undefined) {
        ids.push(id);
        continue;
      }
      if (FLOW_LINK_TYPES.has(type) || typeof item !== "string") {
        return { ok: false, error: `"${String(item)}" não é id de cartão` };
      }
      const entry = await resolveRegisterEntry(field, item, lookups);
      if (!entry.ok) return entry;
      ids.push(entry.value);
    }
    return { ok: true, value: Array.from(new Set(ids)) };
  }

  if (BOOLEAN_TYPES.has(type)) {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const text = normalizeText(String(raw));
    if (["sim", "s", "true", "1", "yes", "y", "ligado", "on"].includes(text)) return { ok: true, value: true };
    if (["nao", "n", "false", "0", "no", "desligado", "off"].includes(text)) return { ok: true, value: false };
    return { ok: false, error: `"${String(raw)}" não é sim/não` };
  }

  if (TEXT_TYPES.has(type) && (typeof raw === "number" || typeof raw === "boolean")) {
    return { ok: true, value: String(raw) };
  }

  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Chaves
// ---------------------------------------------------------------------------

interface FieldHit {
  field: NormalizedField;
  form: FormScope;
}

function findCandidates(key: string, forms: FormScope[]): FieldHit[] {
  const hits: FieldHit[] = [];
  const plain = key.trim();
  for (const form of forms) {
    for (const field of form.fields) {
      if (field.name === plain) hits.push({ field, form });
    }
  }
  if (hits.length > 0) return hits;

  if (/^#?\d+$/.test(plain)) {
    const id = plain.replace(/^#/, "");
    for (const form of forms) {
      for (const field of form.fields) {
        if (field.id !== undefined && String(field.id) === id) hits.push({ field, form });
      }
    }
    if (hits.length > 0) return hits;
  }

  const wanted = normalizeText(plain);
  if (wanted.length === 0) return hits;
  for (const form of forms) {
    for (const field of form.fields) {
      if (field.title && normalizeText(field.title) === wanted) hits.push({ field, form });
    }
  }
  return hits;
}

/**
 * C4 (card #1367459): a MESMA resolução de chave das escritas (hash, id, título sem
 * maiúscula/acento), para leitura (`card read --fields`) e agregação (`cards count/sum`).
 * Devolve todos os campos que casam (sem prioridade): na leitura, título repetido em
 * duas etapas traz os dois; quem precisa de um só decide com a lista.
 */
export function matchFieldsByKey(key: string, fields: NormalizedField[]): NormalizedField[] {
  const form: FormScope = { formId: "*", label: "fluxo", fields, priority: 0 };
  const seen = new Set<string>();
  const out: NormalizedField[] = [];
  for (const hit of findCandidates(key, [form])) {
    const id = String(hit.field.id ?? hit.field.name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(hit.field);
  }
  return out;
}

/** Títulos para a mensagem de "campo não existe" (até 15, sem repetir). */
export function listFieldTitles(fields: NormalizedField[]): string {
  return listTitles([{ formId: "*", label: "fluxo", fields, priority: 0 }]);
}

function pickByPriority(hits: FieldHit[]): FieldHit[] {
  // O mesmo campo (mesmo hash) visto por dois escopos conta uma vez só.
  const unique = new Map<string, FieldHit>();
  for (const hit of hits) {
    const existing = unique.get(hit.field.name);
    if (!existing || hit.form.priority < existing.form.priority) unique.set(hit.field.name, hit);
  }
  const list = Array.from(unique.values());
  if (list.length <= 1) return list;
  const best = Math.min(...list.map((hit) => hit.form.priority));
  return list.filter((hit) => hit.form.priority === best);
}

function listTitles(forms: FormScope[]): string {
  const titles = forms.flatMap((form) => form.fields.map((field) => fieldLabel(field)));
  const unique = Array.from(new Set(titles));
  return unique.slice(0, 15).join(", ") + (unique.length > 15 ? ", ..." : "");
}

/**
 * Resolve chaves e valores contra os formulários do escopo. `outOfScope` são
 * formulários do mesmo fluxo em que o campo existe mas NÃO pode ser gravado por
 * este comando: a mensagem diz de qual etapa ele é.
 */
export async function resolveFieldValues(input: {
  values: Record<string, unknown>;
  forms: FormScope[];
  outOfScope?: FormScope[];
  lookups?: ResolverLookups;
  /**
   * Payload por arquivo sem --validate-fields: chave técnica (hash) que não está
   * na estrutura segue como veio e o servidor decide, como antes do P4. Título
   * e id desconhecidos continuam sendo erro.
   */
  passthroughUnknown?: boolean;
}): Promise<ResolveResult> {
  const resolved: ResolvedValue[] = [];
  const issues: ValueIssue[] = [];
  const passthrough: Record<string, unknown> = {};
  const seenFields = new Map<string, string>();

  for (const [key, raw] of Object.entries(input.values)) {
    const hits = pickByPriority(findCandidates(key, input.forms));

    if (hits.length === 0) {
      if (input.passthroughUnknown && !looksLikeTitleKey(key) && !/^#?\d+$/.test(key.trim())) {
        passthrough[key] = raw;
        continue;
      }
      const elsewhere = input.outOfScope ? pickByPriority(findCandidates(key, input.outOfScope)) : [];
      if (elsewhere.length > 0) {
        const hit = elsewhere[0]!;
        issues.push({
          kind: "out_of_scope",
          blocking: true,
          text: `"${fieldLabel(hit.field)}" é ${withArticle(hit.form.label, "de")} (form ${hit.form.formId}), que este comando não grava (aqui: ${input.forms
            .map((form) => form.label)
            .join(", ")})`
        });
        continue;
      }
      issues.push({
        kind: "unknown_field",
        blocking: true,
        text: `campo "${key}" não existe (${input.forms.map((form) => form.label).join(", ")}: ${listTitles(input.forms)})`
      });
      continue;
    }

    if (hits.length > 1) {
      issues.push({
        kind: "ambiguous_field",
        blocking: true,
        text: `"${key}" casa com ${hits.length} campos: ${hits
          .map((hit) => `${fieldLabel(hit.field)} (id ${hit.field.id ?? hit.field.name}, ${hit.form.label})`)
          .join(", ")}. Use o id`
      });
      continue;
    }

    const { field, form } = hits[0]!;
    const previousKey = seenFields.get(field.name);
    if (previousKey !== undefined) {
      issues.push({
        kind: "ambiguous_field",
        blocking: true,
        text: `"${key}" e "${previousKey}" são o mesmo campo (${fieldLabel(field)}): mande um só`
      });
      continue;
    }
    seenFields.set(field.name, key);

    const coerced = await coerceFieldValue(field, raw, input.lookups);
    if (!coerced.ok) {
      issues.push({
        kind: "invalid_value",
        blocking: true,
        text: `${fieldLabel(field)} (${describeExpected(field)}): ${coerced.error}`
      });
      continue;
    }

    const valueIssue = checkCoercedValue(field, coerced.value);
    if (valueIssue) {
      issues.push(valueIssue);
      continue;
    }

    resolved.push({ key, field, form, value: coerced.value });
  }

  return { resolved, issues, passthrough };
}

/** Guarda final pelo tipo (mesmas regras do validate-fields de sempre). */
function checkCoercedValue(field: NormalizedField, value: unknown): ValueIssue | undefined {
  if (isEmptyValue(value)) return undefined;
  if (isPercentField(field) && typeof value === "number" && Math.abs(value) > 10) {
    return {
      kind: "invalid_value",
      blocking: true,
      text: `${fieldLabel(field)} (percentual): ${value} vira ${(value * 100).toLocaleString("pt-BR")}%. Para ${value}% mande "${value}%" ou ${value / 100}`
    };
  }
  const check = validateValueByFieldType(field.type, value, field.options);
  if (check.expected === "unknown" || check.valid) return undefined;
  return {
    kind: "invalid_value",
    blocking: true,
    text: `${fieldLabel(field)} (${describeExpected(field)}): ${JSON.stringify(value)} não serve`
  };
}

/**
 * Obrigatórios do formulário ainda vazios depois desta escrita. `alreadyFilled`
 * são os hashes que o cartão já tem preenchidos (contam como presentes). Só entra o
 * que a TELA cobra (`isRequiredOnScreen`: regra `required` do campo, visível no
 * formulário) e vazio é o vazio da tela (`isEmptyForField`: rich text `<p></p>` é vazio,
 * switch desligado não é).
 */
export function missingRequiredFields(
  form: FormScope,
  values: Record<string, unknown>,
  alreadyFilled: ReadonlySet<string> = new Set()
): NormalizedField[] {
  return form.fields.filter((field) => {
    if (!isRequiredOnScreen(field)) return false;
    const present = field.name in values ? !isEmptyForField(field, values[field.name]) : alreadyFilled.has(field.name);
    return !present;
  });
}

/** Linha "Falta para <formulário>: Campo (tipo)" de um obrigatório vazio. */
export function missingRequiredIssue(form: FormScope, field: NormalizedField): ValueIssue {
  const label = `${fieldLabel(field)} (${describeExpected(field)})`;
  return { kind: "missing_required", blocking: true, formLabel: form.label, fieldLabel: label, text: label };
}

export function findMissingRequired(
  form: FormScope,
  values: Record<string, unknown>,
  alreadyFilled: ReadonlySet<string> = new Set()
): ValueIssue[] {
  return missingRequiredFields(form, values, alreadyFilled).map((field) => missingRequiredIssue(form, field));
}

/**
 * Mensagem COMPACTA, de uma vez (sem travessão):
 *   Falta para a etapa Agendamento: Data da ligação (data), Agendamento (Sim | Não)
 *   Valor inválido: Horas (número): "doze" não é número
 */
export function formatValueIssues(issues: ValueIssue[]): string {
  const lines: string[] = [];
  const missingByForm = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.kind === "missing_required") {
      const label = issue.formLabel ?? "formulário";
      missingByForm.set(label, [...(missingByForm.get(label) ?? []), issue.fieldLabel ?? issue.text]);
    }
  }
  for (const [label, fields] of missingByForm) {
    lines.push(`Falta para ${withArticle(label, "para")}: ${fields.join(", ")}`);
  }
  const prefix: Partial<Record<ValueIssueKind, string>> = {
    invalid_value: "Valor inválido",
    unknown_field: "Campo desconhecido",
    ambiguous_field: "Campo ambíguo",
    out_of_scope: "Campo de outro formulário",
    move_conflict: "Para mover"
  };
  for (const issue of issues) {
    if (issue.kind === "missing_required" || issue.kind === "hint") continue;
    lines.push(`${prefix[issue.kind] ?? "Problema"}: ${issue.text}`);
  }
  // Dica de como resolver: por último, sem prefixo (é o próximo passo, não um problema).
  for (const issue of issues) {
    if (issue.kind === "hint") lines.push(issue.text);
  }
  return lines.join("\n");
}

/** Mapa hash → valor a partir dos resolvidos (opcionalmente só de um formulário). */
export function valuesOf(resolved: ResolvedValue[], formId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of resolved) {
    if (formId !== undefined && item.form.formId !== formId) continue;
    out[item.field.name] = item.value;
  }
  return out;
}
