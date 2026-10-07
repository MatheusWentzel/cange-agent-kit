import type { NormalizedField } from "../schemas/fields.js";

export function getRequiredFields(fields: NormalizedField[]): NormalizedField[] {
  return fields.filter((field) => field.required);
}

export function filterFieldsByFormId(
  fields: NormalizedField[],
  formId: number | string | undefined
): NormalizedField[] {
  if (formId === undefined) {
    return fields;
  }
  return fields.filter((field) => String(field.formId) === String(formId));
}

/**
 * EXTRA-06 D2/D3 (07/10/2026): o kit só cobra como obrigatório o que a TELA cobra.
 *
 * A tela (FormBuilder + createYupSchema, yup 0.29) não olha a coluna `field.required`:
 * monta o validador com as regras de `field_validation` que vêm em `field.validations`
 * (GET /field/by-flow e GET /form/pre-answer trazem). Campo é cobrado quando:
 *  - tem regra `type = 'required'`;
 *  - e o `validation_type` dele é um tipo do yup (sem tipo, `createYupSchema` devolve o
 *    schema sem validador nenhum);
 *  - e não está oculto no formulário (`show_on_form = 'S'`: o FormBuilder zera
 *    `required` e `validations` antes de validar).
 * Casos reais que a coluna errava (cange_local, 07/10): SWITCH com required=1 e nenhuma
 * regra (92 de 92), CHECK_LIST com required=1 sem regra (32 de 190), e o inverso (regra
 * sem required=1) em RADIO e usuário.
 *
 * Sem a lista `validations` no campo (back antigo, payload montado à mão), vale a coluna
 * `required`, como antes.
 */
const YUP_SCHEMA_TYPES = new Set(["string", "number", "boolean", "bool", "date", "array", "mixed", "object"]);
const DEFAULT_STRING_TYPES = new Set(["DOC_FIELD", "PHONE_FIELD"]);

/** Campo oculto no formulário: a tela nunca cobra (o FormBuilder zera o obrigatório). */
export function isHiddenOnForm(field: NormalizedField): boolean {
  const flag = field.raw?.show_on_form ?? field.raw?.showOnForm;
  return typeof flag === "string" && flag.trim().toUpperCase() === "S";
}

/** A regra de obrigatório que a tela aplica (sem olhar se está oculto). */
export function hasRequiredRule(field: NormalizedField): boolean {
  const raw = field.raw ?? {};
  const validations = raw.validations;
  if (!Array.isArray(validations)) return field.required;
  const hasRule = validations.some((rule) => {
    const type = rule !== null && typeof rule === "object" ? (rule as Record<string, unknown>).type : undefined;
    return typeof type === "string" && type.trim().toLowerCase() === "required";
  });
  if (!hasRule) return false;
  if (!("validation_type" in raw) && !("validationType" in raw)) return true;
  const yupType = raw.validation_type ?? raw.validationType;
  // createYupSchema: documento e telefone sem tipo viram "string".
  if ((yupType === null || yupType === undefined || yupType === "") && DEFAULT_STRING_TYPES.has(String(field.type ?? "").toUpperCase())) {
    return true;
  }
  return typeof yupType === "string" && YUP_SCHEMA_TYPES.has(yupType.trim().toLowerCase());
}

/** Obrigatório de verdade, igual à tela: regra `required` e campo visível no formulário. */
export function isRequiredOnScreen(field: NormalizedField): boolean {
  return !isHiddenOnForm(field) && hasRequiredRule(field);
}

const RICH_TEXT_TYPES = new Set(["INPUT_RICH_TEXT_FIELD", "RICH_TEXT_FIELD", "HTML_FIELD"]);

export function isRichTextType(type: string | undefined): boolean {
  return RICH_TEXT_TYPES.has(String(type ?? "").toUpperCase());
}

/**
 * EXTRA-06 D4: rich text sem conteúdo, com a régua exata da tela. O campo Texto Formatado
 * (`InputRichText`, função `isHtmlEmpty`) entrega "" ao formulário quando o HTML não tem
 * texto: tira toda tag (`/<[^>]*>/g`), troca `&nbsp;` por espaço e apara. Aí o obrigatório
 * (`rich-text-required` + `required` do createYupSchema) recusa. Então `<p></p>`,
 * `<p><br></p>` e `<p>&nbsp;</p>` são vazios, e HTML só com imagem ou tabela sem texto
 * também (a tela valida e grava "" nesses casos). `&#160;` a tela lê como texto.
 */
export function isEmptyRichText(value: string): boolean {
  if (value.trim() === "") return true;
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text === "";
}

/**
 * Valor que a tela trata como vazio no obrigatório. `false` e `0` são valores (o switch
 * desligado e o número zero passam no yup), texto em branco e lista vazia não; rich text
 * sem conteúdo também não (D4).
 */
export function isEmptyForField(field: Pick<NormalizedField, "type">, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    if (value.trim().length === 0) return true;
    return isRichTextType(field.type) && isEmptyRichText(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    if (isRichTextType(field.type)) return value.every((item) => typeof item === "string" && isEmptyRichText(item));
    return false;
  }
  return false;
}

/**
 * EXTRA-06 D5: check list com `formula = '1'` ("exigir todos os itens concluídos"). A
 * tela (FormBuilder) não envia o formulário enquanto houver item da lista sem marcar
 * (`checked !== 'S'`); lista vazia não é cobrada aqui (isso é do obrigatório).
 *
 * O item chega em três formatos: a linha gravada (texto JSON do item, com `checked`), o
 * que a tela manda (`{ value, label: <JSON do item>, checked }`) e o item solto
 * (`{ description, checked }`). Item que não dá para ler fica de fora (a tela também
 * descarta o que não consegue ler), e item sem descrição também: o CheckListField lê a
 * descrição como `description || ''` e o `getValue` tira o item de descrição vazia antes
 * de o FormBuilder conferir (R3-F5).
 */
export function requiresAllChecked(field: NormalizedField): boolean {
  if (String(field.type ?? "").toUpperCase() !== "CHECK_LIST_FIELD") return false;
  const formula = field.raw?.formula;
  return formula === "1" || formula === 1;
}

export interface CheckListProgress {
  total: number;
  pending: number;
}

export function checkListProgress(value: unknown): CheckListProgress | undefined {
  if (!Array.isArray(value)) return undefined;
  let total = 0;
  let pending = 0;
  for (const item of value) {
    const checked = checkedOf(item);
    if (checked === undefined || !hasDescription(item)) continue;
    total += 1;
    if (checked !== "S") pending += 1;
  }
  return total > 0 ? { total, pending } : undefined;
}

/** O item tem descrição (a tela descarta o de descrição vazia ou ausente). */
function hasDescription(item: unknown): boolean {
  let record: Record<string, unknown> | undefined;
  if (typeof item === "string") {
    record = parseJsonRecord(item);
  } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const raw = item as Record<string, unknown>;
    record = (typeof raw.label === "string" ? parseJsonRecord(raw.label) : undefined) ?? raw;
  }
  if (!record) return true;
  const description = record.description;
  return description !== undefined && description !== null && description !== "" && description !== false && description !== 0;
}

/** `checked` do item ("N" quando o item não diz: o default da tela). undefined = ilegível. */
function checkedOf(item: unknown): string | undefined {
  if (typeof item === "string") {
    const parsed = parseJsonRecord(item);
    return parsed ? normalizeChecked(parsed.checked) : undefined;
  }
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  if (record.checked !== undefined && record.checked !== null) return normalizeChecked(record.checked);
  if (typeof record.label === "string") {
    const parsed = parseJsonRecord(record.label);
    if (parsed) return normalizeChecked(parsed.checked);
  }
  if (typeof record.description === "string") return "N";
  return undefined;
}

function normalizeChecked(value: unknown): string {
  if (value === true) return "S";
  if (typeof value === "string" && value.trim().toUpperCase() === "S") return "S";
  return "N";
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
