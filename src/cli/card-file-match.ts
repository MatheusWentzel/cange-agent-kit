/**
 * Onda 1b (item 6, 15/10/2026): "o arquivo do cartão" em linguagem de gente. Quando a
 * pessoa fala de um arquivo do cartão, ele está num CAMPO DE ANEXO ou na COLABORAÇÃO (os
 * anexos dos comentários; a aba Anexos também conta). O `attachment list` devolve todos
 * numa lista só, cada um dizendo de onde vem, e com `--name` acha o que a pessoa citou.
 *
 * Regra de decisão (para o agente não adivinhar):
 *  - um candidato que bate com o nome (ou o cartão só tem um arquivo): usa direto;
 *  - mais de um candidato, ou nenhum com o nome dito: a saída traz `ask`, a pergunta
 *    pronta citando cada arquivo e onde está ("Encontrei o arquivo X no campo Y e o
 *    arquivo Z na colaboração. De qual você está falando?").
 *
 * Puro: sem rede, testável direto.
 */
import type { CardAttachments } from "./card-attachments.js";

export type CardFileSource = "campo" | "colaboracao" | "aba_anexos";

export interface CardFileRef {
  attachmentId: number;
  fileName: string;
  /** De onde vem: campo de anexo, colaboração (comentário) ou aba Anexos. */
  source: CardFileSource;
  /** Onde está, em português: `campo "Contrato"`, `colaboração (comentário de Ana em 01/10)`, `aba Anexos`. */
  where: string;
  /** Título do campo (só `source` campo). */
  field?: string;
  /** Autor e data do comentário (só `source` colaboracao). */
  author?: string;
  createdAt?: string;
  mimeType?: string;
  sizeKb?: number;
}

export interface CardFileMatch {
  /** Os arquivos que batem com o nome (ou todos, sem nome ou sem nenhum que bata). */
  candidates: CardFileRef[];
  /** O nome bateu inteiro (todas as palavras)? `false` = só parte das palavras, ou nenhuma. */
  exact: boolean;
  /** Quantos bateram com o nome (0 = nenhum; `candidates` volta com todos os do cartão). */
  found: number;
}

/** Palavras que não identificam arquivo ("o arquivo do cartão", "o anexo"). */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas",
  "que", "esse", "essa", "este", "esta", "aquele", "aquela", "meu", "minha", "seu", "sua",
  "arquivo", "arquivos", "anexo", "anexos", "anexado", "anexada", "documento", "documentos", "doc", "docs",
  "cartao", "cartoes", "card", "cards", "file", "files"
]);

/** Minúsculas, sem acento, só letras e números separados por espaço. */
export function foldFileText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** As palavras do nome dito pela pessoa que identificam o arquivo. */
export function fileNameTokens(name: string): string[] {
  const tokens = foldFileText(name)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function commentWhere(author: string | undefined, createdAt: string | undefined): string {
  const parts = [author ? `de ${author}` : undefined, createdAt ? `em ${createdAt}` : undefined].filter(Boolean);
  return parts.length > 0 ? `colaboração (comentário ${parts.join(" ")})` : "colaboração";
}

/** Todos os arquivos do cartão numa lista só, sem repetir, com a origem de cada um. */
export function cardFileRefs(found: Pick<CardAttachments, "fields" | "comments" | "cardTab">): CardFileRef[] {
  const out: CardFileRef[] = [];
  const seen = new Set<number>();
  const push = (ref: CardFileRef): void => {
    if (seen.has(ref.attachmentId)) return;
    seen.add(ref.attachmentId);
    out.push(ref);
  };
  for (const field of found.fields) {
    for (const file of field.files) {
      push({
        attachmentId: file.attachmentId,
        fileName: file.fileName,
        source: "campo",
        where: `campo "${field.title}"`,
        field: field.title,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.sizeKb !== undefined ? { sizeKb: file.sizeKb } : {})
      });
    }
  }
  for (const comment of found.comments) {
    for (const file of comment.files) {
      push({
        attachmentId: file.attachmentId,
        fileName: file.fileName,
        source: "colaboracao",
        where: commentWhere(comment.author, comment.createdAt),
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.sizeKb !== undefined ? { sizeKb: file.sizeKb } : {})
      });
    }
  }
  for (const file of found.cardTab) {
    push({
      attachmentId: file.attachmentId,
      fileName: file.fileName,
      source: "aba_anexos",
      where: "aba Anexos",
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.sizeKb !== undefined ? { sizeKb: file.sizeKb } : {})
    });
  }
  return out;
}

/**
 * Acha os arquivos que batem com o nome dito pela pessoa. Compara as palavras do nome
 * (sem acento, sem "arquivo", "do", "cartão") com o nome do arquivo E com onde ele está
 * ("o contrato da colaboração" acha o contrato.pdf do comentário, não o do campo).
 * Todas as palavras = exato; senão, os que têm alguma palavra (parcial); nenhum = todos.
 */
export function matchCardFiles(refs: CardFileRef[], name: string | undefined): CardFileMatch {
  const tokens = name === undefined ? [] : fileNameTokens(name);
  if (tokens.length === 0) return { candidates: refs, exact: true, found: refs.length };
  const hay = new Map(refs.map((ref) => [ref.attachmentId, ` ${foldFileText(`${ref.fileName} ${ref.where}`)} `]));
  const has = (ref: CardFileRef, token: string): boolean => (hay.get(ref.attachmentId) ?? "").includes(token);
  const full = refs.filter((ref) => tokens.every((token) => has(ref, token)));
  if (full.length > 0) return { candidates: full, exact: true, found: full.length };
  const partial = refs.filter((ref) => tokens.some((token) => has(ref, token)));
  if (partial.length > 0) return { candidates: partial, exact: false, found: partial.length };
  return { candidates: refs, exact: false, found: 0 };
}

/** Quantos arquivos a pergunta cita (o resto fica em `files`). */
export const ASK_MAX_FILES = 6;

function onde(ref: CardFileRef): string {
  if (ref.source === "campo") return `no ${ref.where}`;
  if (ref.source === "aba_anexos") return "na aba Anexos";
  return `na ${ref.where}`;
}

function joinPt(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/**
 * A pergunta para a pessoa quando não dá para saber qual é o arquivo; `undefined` quando dá
 * (um candidato exato, ou o cartão sem arquivo).
 */
export function askWhichFile(match: CardFileMatch, name: string | undefined): string | undefined {
  const { candidates } = match;
  if (candidates.length === 0) return undefined;
  const named = name !== undefined && fileNameTokens(name).length > 0;
  if (candidates.length === 1 && match.exact) return undefined;
  const listed = candidates.slice(0, ASK_MAX_FILES).map((ref) => `o arquivo ${ref.fileName} ${onde(ref)}`);
  const more = candidates.length > ASK_MAX_FILES ? ` (e mais ${candidates.length - ASK_MAX_FILES})` : "";
  if (named && match.found === 0) {
    return `Não encontrei arquivo com o nome "${name!.trim()}" neste cartão. Os arquivos dele são: ${joinPt(listed)}${more}. De qual você está falando?`;
  }
  if (candidates.length === 1) {
    return `Encontrei só ${listed[0]}, que não bate exatamente com "${name!.trim()}". É esse?`;
  }
  return `Encontrei ${joinPt(listed)}${more}. De qual você está falando?`;
}
