import { asRecord, extractCardRecord } from "../contracts/raw-adapters.js";

/**
 * v9 (g, decisão de 08/10): vencimento, responsável e etiquetas do cartão com 1 comando
 * curto e barato. Fonte única de leitura (o `card read` enxuto e o `card update`) e da
 * régua do `--due`.
 *
 * Fuso: o Cange guarda o vencimento em hora de parede de Brasília (a tela manda
 * "aaaa-mm-dd HH:MM" sem fuso no PUT /card e zera a hora no seletor). O GET /card devolve
 * ISO com Z; o kit converte para America/Sao_Paulo. Valor sem fuso é hora de parede e sai
 * como está.
 */
export const CANGE_TIME_ZONE = "America/Sao_Paulo";

/** "aaaa-mm-dd HH:MM": hora de parede de Brasília, o formato do PUT /card. */
export type WallClock = string;

export interface CardResponsible {
  id: number;
  name?: string;
}

export interface CardTag {
  id: number;
  name?: string;
}

export interface CardState {
  /** Vencimento em hora de parede de Brasília, ou null (sem vencimento). */
  due: WallClock | null;
  responsible: CardResponsible | null;
  tags: CardTag[];
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const pad = (value: number, size = 2): string => String(value).padStart(size, "0");

function wallOf(parts: WallParts): WallClock {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Partes da data no fuso de Brasília (`Intl`, sem dependência). */
function partsInSaoPaulo(date: Date): WallParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CANGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? date.getUTCFullYear(),
    month: out.month ?? date.getUTCMonth() + 1,
    day: out.day ?? date.getUTCDate(),
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0
  };
}

/**
 * Vencimento gravado → hora de parede de Brasília. ISO com Z (ou com deslocamento) é
 * convertido; "aaaa-mm-dd HH:MM[:SS]" sem fuso sai como está. Vazio ou ilegível = null.
 */
export function dueWallClock(raw: unknown): WallClock | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const text = raw.trim();
  const plain = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(text);
  if (plain) {
    const [, y, m, d, hh, mi] = plain;
    return wallOf({ year: Number(y), month: Number(m), day: Number(d), hour: Number(hh ?? 0), minute: Number(mi ?? 0) });
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return wallOf(partsInSaoPaulo(date));
}

/** "aaaa-mm-dd HH:MM" → "dd/mm/aaaa HH:MM" (o que o agente lê e repete para a pessoa). */
export function dueLabel(wall: WallClock): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(wall);
  if (!match) return wall;
  const [, y, m, d, hh, mi] = match;
  return `${d}/${m}/${y} ${hh}:${mi}`;
}

/** Vencimento como o agente lê ("27/10/2026 00:00") ou null. */
export function dueForAgent(raw: unknown): string | null {
  const wall = dueWallClock(raw);
  return wall === null ? null : dueLabel(wall);
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Estado do cartão no GET /card: `dt_due`, `user_id` + `user.name` e `card_flow_tags[]`
 * (com `flow_tag.description`). Sempre as 3 chaves: null e [] querem dizer vazio.
 */
export function cardStateOf(raw: unknown): CardState {
  const record = extractCardRecord(raw) ?? asRecord(raw) ?? {};
  const user = asRecord(record.user);
  const userId = positiveInt(record.user_id) ?? positiveInt(user?.id_user);
  const userName = textOf(user?.name);
  const tags: CardTag[] = [];
  const seen = new Set<number>();
  for (const item of Array.isArray(record.card_flow_tags) ? record.card_flow_tags : []) {
    const link = asRecord(item);
    if (!link) continue;
    const tag = asRecord(link.flow_tag);
    const id = positiveInt(link.flow_tag_id) ?? positiveInt(tag?.id_flow_tag);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const name = textOf(tag?.description);
    tags.push({ id, ...(name !== undefined ? { name } : {}) });
  }
  return {
    due: dueWallClock(record.dt_due),
    responsible: userId === undefined ? null : { id: userId, ...(userName !== undefined ? { name: userName } : {}) },
    tags
  };
}

// ---------------------------------------------------------------------------
// --due
// ---------------------------------------------------------------------------

export type DueInput = { kind: "clear" } | { kind: "set"; wall: WallClock };

const CLEAR_WORDS = new Set(["", "limpar", "sem"]);

/** Hoje em Brasília (`now` injetável nos testes). */
function todayInSaoPaulo(now: Date): { year: number; month: number; day: number } {
  const parts = partsInSaoPaulo(now);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function isValidDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last;
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function normalizeWord(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * `--due` do `card update`: dd/mm/aaaa [HH:MM], dd/mm (a próxima ocorrência a partir de
 * hoje), aaaa-mm-dd [HH:MM] ou aaaa-mm-ddTHH:MM, hoje, amanhã/amanha; `limpar`, `sem` ou
 * "" tiram o vencimento. Sem hora = 00:00, como o seletor da tela. Hora de parede de
 * Brasília, sem conversão. undefined = inválido.
 */
export function parseDueInput(raw: string, now: Date = new Date()): DueInput | undefined {
  const text = raw.trim();
  const word = normalizeWord(text);
  if (CLEAR_WORDS.has(word)) return { kind: "clear" };

  const time = (hh: string | undefined, mi: string | undefined): { hour: number; minute: number } | undefined => {
    const hour = Number(hh ?? 0);
    const minute = Number(mi ?? 0);
    return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
  };
  const build = (year: number, month: number, day: number, hh?: string, mi?: string): DueInput | undefined => {
    if (!isValidDay(year, month, day)) return undefined;
    const clock = time(hh, mi);
    return clock ? { kind: "set", wall: wallOf({ year, month, day, ...clock }) } : undefined;
  };

  const relative = /^(hoje|amanha)(?:\s+(?:as\s+)?(\d{1,2}):(\d{2}))?$/.exec(word);
  if (relative) {
    const base = todayInSaoPaulo(now);
    const day = relative[1] === "amanha" ? addDays(base, 1) : base;
    return build(day.year, day.month, day.day, relative[2], relative[3]);
  }

  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (br) {
    const [, d, m, y, hh, mi] = br;
    const day = Number(d);
    const month = Number(m);
    if (y !== undefined) return build(Number(y), month, day, hh, mi);
    // dd/mm: a próxima ocorrência a partir de hoje (hoje conta). 29/02 procura o próximo ano bissexto.
    const today = todayInSaoPaulo(now);
    const fromToday = month > today.month || (month === today.month && day >= today.day);
    for (let year = fromToday ? today.year : today.year + 1, tries = 0; tries < 8; year += 1, tries += 1) {
      if (isValidDay(year, month, day)) return build(year, month, day, hh, mi);
    }
    return undefined;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (iso) {
    const [, y, m, d, hh, mi] = iso;
    return build(Number(y), Number(m), Number(d), hh, mi);
  }
  return undefined;
}

export function dueInvalidMessage(raw: string): string {
  return `Data de vencimento inválida: "${raw}". Use dd/mm/aaaa, com hora opcional (27/10/2026 18:00), ou limpar.`;
}
