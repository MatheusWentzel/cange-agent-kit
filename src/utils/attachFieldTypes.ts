/**
 * C2 (onda 1): tipos de arquivo aceitos por campo de anexo.
 *
 * ESPELHO de `wendata-back/src/config/attachFieldTypes.ts` (card #1241184, PR back #674) e
 * do app (#1241185): a configuração vive em `field.filter_schema` como
 * `{"allowedFileTypes":["pdf","image","spreadsheet","document"]}`. Sem configuração
 * (ausente, inválida ou lista vazia) o campo aceita tudo. Um arquivo passa quando o tipo
 * (mime) OU a extensão é de um dos grupos escolhidos. Mudou lá, muda aqui.
 *
 * O kit confere antes de subir para o agente não gastar um envio (e uma aprovação) com
 * um arquivo que a tela e o back recusariam.
 */

export type AttachFileTypePreset = "pdf" | "image" | "spreadsheet" | "document";

const PRESET_KEYS: AttachFileTypePreset[] = ["pdf", "image", "spreadsheet", "document"];

const LABELS: Record<AttachFileTypePreset, string> = {
  pdf: "PDF",
  image: "Imagens",
  spreadsheet: "Planilhas",
  document: "Documentos"
};

const PRESETS: Record<AttachFileTypePreset, { mimes: string[]; exts: string[] }> = {
  pdf: { mimes: ["application/pdf"], exts: [".pdf"] },
  image: {
    mimes: ["image/jpeg", "image/pjpeg", "image/png", "image/gif", "image/webp", "image/heic"],
    exts: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]
  },
  spreadsheet: {
    mimes: [
      "application/vnd.ms-excel",
      "application/excel",
      "application/x-excel",
      "application/x-xls",
      "application/xls",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv"
    ],
    exts: [".xls", ".xlsx", ".csv"]
  },
  document: {
    mimes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain"
    ],
    exts: [".doc", ".docx", ".txt"]
  }
};

/** Grupos aceitos pelo campo (`filter_schema` em texto ou já lido). Inválido = [] (aceita tudo). */
export function parseAllowedFileTypes(filterSchema: unknown): AttachFileTypePreset[] {
  let parsed: unknown = filterSchema;
  if (typeof filterSchema === "string") {
    if (filterSchema.trim() === "") return [];
    try {
      parsed = JSON.parse(filterSchema);
    } catch {
      return [];
    }
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).allowedFileTypes : undefined;
  if (!Array.isArray(raw)) return [];
  const out = new Set<AttachFileTypePreset>();
  for (const item of raw) {
    if (typeof item === "string" && (PRESET_KEYS as string[]).includes(item)) out.add(item as AttachFileTypePreset);
  }
  return PRESET_KEYS.filter((key) => out.has(key));
}

/** Extensão minúscula com ponto (".pdf"); "" sem extensão. */
export function fileExtension(fileName: string | undefined | null): string {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

/** O arquivo é aceito pelos grupos do campo? Sem grupos = aceita. */
export function isFileAllowed(
  mimeType: string | undefined | null,
  fileName: string | undefined | null,
  presets: AttachFileTypePreset[]
): boolean {
  if (presets.length === 0) return true;
  const mime = String(mimeType ?? "").toLowerCase();
  const ext = fileExtension(fileName);
  return presets.some((preset) => {
    const def = PRESETS[preset];
    return (mime !== "" && def.mimes.includes(mime)) || (ext !== "" && def.exts.includes(ext));
  });
}

/** "PDF, Imagens" (ordem fixa). */
export function describeAllowedFileTypes(presets: AttachFileTypePreset[]): string {
  return PRESET_KEYS.filter((key) => presets.includes(key))
    .map((key) => LABELS[key])
    .join(", ");
}

/**
 * Tipo (mime) do arquivo pela extensão, para o back gravar o mesmo tipo que a tela grava
 * (a tela mostra a prévia de PDF e imagem pelo tipo). Só tipos da lista que o back aceita
 * (`config/allowedMimes.ts`); o resto vai como `application/octet-stream`, que o back
 * aceita e a tela baixa.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg"
};

export function mimeTypeOf(fileName: string): string {
  return MIME_BY_EXT[fileExtension(fileName)] ?? "application/octet-stream";
}
