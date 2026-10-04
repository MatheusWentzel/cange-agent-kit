/**
 * SAÍDA ENXUTA por padrão (rodada 5, 01/10, decisão 3 do Matheus).
 *
 * Medição da rodada 4 (25 runs de agente): a saída do kit era 17% do custo e era
 * relida a cada turno. Ruído medido: indentação (~1,9 token por linha), `raw`
 * junto do resumo (my-flows: 98,6% do texto), aliases snake_case, nulos, hash do
 * campo no `map` (23%), HTML cru em rich text e comentário.
 *
 * O perfil `lean` é o padrão para TODOS os consumidores (agentes do produto e
 * agentes locais). `--full` (ou `CANGE_OUTPUT_PROFILE=full`) devolve o formato de
 * antes, byte a byte; `--raw` continua cru.
 */

export type OutputProfile = "lean" | "full";

/** `--full` vence; senão `CANGE_OUTPUT_PROFILE=full`; o resto é `lean`. */
export function resolveOutputProfile(
  fullFlag: boolean | undefined,
  env: Record<string, string | undefined> = process.env
): OutputProfile {
  if (fullFlag === true) return "full";
  return env.CANGE_OUTPUT_PROFILE?.trim().toLowerCase() === "full" ? "full" : "lean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Remove nulo, `undefined`, string vazia, `[]` e `{}`. As chaves do NÍVEL DE CIMA
 * do envelope ficam sempre (o agente lê `d['summaries']` mesmo vazio); `false` e
 * `0` são dado e ficam. Itens de lista ficam na posição (só são limpos por dentro).
 */
export function dropEmpty<T>(value: T): T {
  return dropEmptyAt(value, 0) as T;
}

function dropEmptyAt(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dropEmptyAt(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleaned = dropEmptyAt(raw, depth + 1);
    if (depth > 0 && isEmptyValue(cleaned)) continue;
    if (depth === 0 && cleaned === undefined) continue;
    out[key] = cleaned;
  }
  return out;
}

/** O texto parece HTML (rich text do Cange, comentário)? */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(p|br|div|span|a|ul|ol|li|strong|b|em|i|u|h[1-6]|table|thead|tbody|tr|td|th|blockquote|pre|code|img|hr)\b[^>]*>/i.test(
    text
  );
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  "#39": "'"
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]!;
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/**
 * HTML do rich text e dos comentários → markdown, PRESERVANDO os links (`[texto](url)`)
 * e as listas: texto puro perdia o href do tactiq, da tela e do anexo (crítica da
 * rodada 4). Sem dependência: cobre o que o editor do Cange gera (p, br, listas,
 * negrito, itálico, títulos, links, tabelas simples, imagem). Texto que não é HTML
 * volta igual.
 */
export function htmlToMarkdown(html: string): string {
  if (!looksLikeHtml(html)) return html;
  let text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\r\n?/g, "\n")
    // Quebra de linha do HTML vira a quebra; a do código-fonte é só espaço.
    .replace(/\n/g, " ");

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const href = attr(attrs, "href");
    const label = decodeEntities(stripTags(inner)).trim();
    if (!href) return label;
    const url = decodeEntities(href);
    if (!label || label === url) return `<${url}>`;
    return `[${label}](${url})`;
  });
  text = text.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const alt = attr(attrs, "alt")?.trim();
    const src = attr(attrs, "src");
    if (src && !src.startsWith("data:")) return `![${alt ?? ""}](${decodeEntities(src)})`;
    return alt ? `[imagem: ${alt}]` : "[imagem]";
  });
  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      return `\n\n${"#".repeat(Number(level))} ${stripTags(inner).trim()}\n\n`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
      const body = inner.trim();
      return body ? `**${body}**` : "";
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
      const body = inner.trim();
      return body ? `*${body}*` : "";
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner}\``)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(p|div|blockquote|table|h[1-6])>/gi, "\n\n")
    .replace(/<p\b[^>]*>|<div\b[^>]*>/gi, "");

  text = decodeEntities(stripTags(text));
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/\s+$/, "").replace(/^ (?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
