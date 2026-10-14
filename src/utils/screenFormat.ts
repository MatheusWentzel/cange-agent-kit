/**
 * R4-P2 (revisão 4 do EXTRA-06, 07/10): documento (DOC_FIELD) e telefone (PHONE_FIELD) com a
 * régua da tela, copiada do front (`utils/validateCpfCnpj.ts`, `utils/maskDocument.ts` e o
 * `InputPhone`).
 *
 * A tela valida o formato SEMPRE, obrigatório ou não, oculto também: o `createYupSchema` dá
 * `validation_type = 'string'` a esses dois tipos e acrescenta o `document-validation(-optional)`
 * e o `phone-validation(-optional)` sem olhar a lista de regras (que o FormBuilder zera no
 * oculto). O valor validado é o que o componente devolve no `getValue`, já com a máscara:
 *  - documento: o `InputDoc` aplica a máscara do tipo (`variation`: "2" CNPJ, "3" CPF ou CNPJ,
 *    o resto CPF) ao abrir e de novo no `getValue`. CNPJ gravado em campo de CPF vira 11 dígitos
 *    e não passa no dígito verificador;
 *  - telefone: o `InputPhone` aplica `maskPhone` ao abrir e de novo no `getValue`; cada passada
 *    descarta o dígito depois de 11 quando sobram 10 ou mais depois do DDD.
 * Máscara que não deixa nada ("N/A" num campo de CPF) o componente entrega vazio.
 */

/** 1 = CPF, 2 = CNPJ, 3 = CPF ou CNPJ (o `resolveTypeDoc` da tela). */
export type DocType = 1 | 2 | 3;

export function docTypeOf(variation: unknown): DocType {
  const text = typeof variation === "number" ? String(variation) : typeof variation === "string" ? variation.trim() : "";
  return text === "2" ? 2 : text === "3" ? 3 : 1;
}

export function maskCPF(value: string): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})/, "$1-$2")
    .replace(/(-\d{2})\d+?$/, "$1");
}

export function maskCNPJ(value: string): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .substring(0, 14)
    .replace(/^([A-Z0-9]{2})([A-Z0-9])/, "$1.$2")
    .replace(/^([A-Z0-9]{2})\.([A-Z0-9]{3})([A-Z0-9])/, "$1.$2.$3")
    .replace(/\.([A-Z0-9]{3})([A-Z0-9])/, ".$1/$2")
    .replace(/([A-Z0-9]{4})([A-Z0-9])/, "$1-$2");
}

export function maskBoth(value: string): string {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9]/g, "");
  const isCnpj = /[A-Za-z]/.test(cleaned) || cleaned.length > 11;
  return isCnpj ? maskCNPJ(value) : maskCPF(value);
}

export function maskDocumentByType(value: string, typeDoc: DocType): string {
  if (typeDoc === 1) return maskCPF(value);
  if (typeDoc === 2) return maskCNPJ(value);
  return maskBoth(value);
}

/** A máscara do `InputPhone` (uma passada). */
export function maskPhone(value: string): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .replace(/(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d{4})(\d)/, "$1-$2");
}

function cleanCnpj(doc: string): string {
  return doc.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

export function validateCPF(cpf: string): boolean {
  const cleaned = cpf.replace(/\D/g, "");
  if (cleaned.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cleaned)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(cleaned.charAt(i)) * (10 - i);
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== Number(cleaned.charAt(9))) return false;
  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(cleaned.charAt(i)) * (11 - i);
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  return remainder === Number(cleaned.charAt(10));
}

/** CNPJ numérico ou alfanumérico (RFB, jul/2026): 12 posições [A-Z0-9] e 2 dígitos verificadores. */
export function validateCNPJ(cnpj: string): boolean {
  const cleaned = cleanCnpj(cnpj);
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cleaned)) return false;
  if (/^(.)\1{13}$/.test(cleaned)) return false;
  const calcDV = (length: number): number => {
    let sum = 0;
    let pos = length - 7;
    for (let i = length; i >= 1; i -= 1) {
      sum += (cleaned.charCodeAt(length - i) - 48) * pos;
      pos -= 1;
      if (pos < 2) pos = 9;
    }
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return calcDV(12) === Number(cleaned.charAt(12)) && calcDV(13) === Number(cleaned.charAt(13));
}

function validateCPForCNPJ(doc: string): boolean {
  const alnum = cleanCnpj(doc);
  if (/[A-Z]/.test(alnum)) return validateCNPJ(doc);
  if (alnum.length === 11) return validateCPF(doc);
  if (alnum.length === 14) return validateCNPJ(doc);
  return false;
}

/** `validateDocument` da tela para um valor preenchido. */
export function isValidDocument(doc: string, typeDoc: DocType): boolean {
  if (typeDoc === 1) return doc.replace(/\D/g, "").length === 11 && validateCPF(doc);
  if (typeDoc === 2) return cleanCnpj(doc).length === 14 && validateCNPJ(doc);
  return validateCPForCNPJ(doc);
}

/** `validatePhone` da tela para um valor preenchido: 10 ou 11 dígitos (DDD + número). */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "").length;
  return digits === 10 || digits === 11;
}

/** A frase da tela para o documento inválido ("CPF inválido", "CNPJ inválido", "CPF ou CNPJ inválido"). */
export function documentErrorText(typeDoc: DocType): string {
  return typeDoc === 1 ? "CPF inválido" : typeDoc === 2 ? "CNPJ inválido" : "CPF ou CNPJ inválido";
}

export const PHONE_ERROR_TEXT = "Telefone inválido: a tela exige 10 ou 11 dígitos com DDD";

const DOC_TYPES = new Set(["DOC_FIELD"]);
const PHONE_TYPES = new Set(["PHONE_FIELD"]);

/** Campo que a tela valida pelo formato (documento ou telefone). */
export function hasScreenFormat(type: string | undefined): boolean {
  const upper = String(type ?? "").toUpperCase();
  return DOC_TYPES.has(upper) || PHONE_TYPES.has(upper);
}

/**
 * O que o componente da tela entrega no `getValue` para o valor gravado (as duas passadas da
 * máscara). "" = a tela trata como vazio. Tipo sem máscara: o próprio texto.
 */
export function screenFormattedValue(type: string | undefined, variation: unknown, raw: string): string {
  const upper = String(type ?? "").toUpperCase();
  if (DOC_TYPES.has(upper)) {
    const typeDoc = docTypeOf(variation);
    return maskDocumentByType(maskDocumentByType(raw, typeDoc), typeDoc);
  }
  if (PHONE_TYPES.has(upper)) return maskPhone(maskPhone(raw));
  return raw;
}

/**
 * Erro de formato que a tela daria ao mover, sobre o valor como o componente o entrega.
 * undefined = passa (vazio passa aqui; o obrigatório é outra régua).
 */
export function screenFormatError(type: string | undefined, variation: unknown, raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const upper = String(type ?? "").toUpperCase();
  if (!DOC_TYPES.has(upper) && !PHONE_TYPES.has(upper)) return undefined;
  const shown = screenFormattedValue(upper, variation, String(raw));
  if (shown.trim() === "") return undefined;
  if (DOC_TYPES.has(upper)) {
    const typeDoc = docTypeOf(variation);
    return isValidDocument(shown, typeDoc) ? undefined : documentErrorText(typeDoc);
  }
  return isValidPhone(shown) ? undefined : PHONE_ERROR_TEXT;
}

/**
 * Régua do `--set` (o valor que o agente digita, como alguém digitando no campo): documento pela
 * máscara do tipo e o dígito verificador; telefone com 10 ou 11 dígitos no próprio valor. A tela
 * corta o dígito que passa de 11 (colar "+55 21 98765-4321" grava outro número); o kit recusa em
 * vez de gravar um número truncado.
 */
export function typedFormatError(type: string | undefined, variation: unknown, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return undefined;
  const upper = String(type ?? "").toUpperCase();
  if (DOC_TYPES.has(upper)) {
    const typeDoc = docTypeOf(variation);
    const shown = maskDocumentByType(raw, typeDoc);
    return shown.trim() !== "" && isValidDocument(shown, typeDoc) ? undefined : documentErrorText(typeDoc);
  }
  if (PHONE_TYPES.has(upper)) return isValidPhone(raw) ? undefined : PHONE_ERROR_TEXT;
  return undefined;
}
