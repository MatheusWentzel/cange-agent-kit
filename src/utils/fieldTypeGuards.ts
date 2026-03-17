export interface TypeValidationResult {
  valid: boolean;
  expected: string;
  normalizedType: string;
  reason?: string;
  allowedOptions?: OptionDescriptor[];
}

type GuardFn = (value: unknown) => boolean;

interface GuardDefinition {
  expected: string;
  guard: GuardFn;
}

interface OptionDescriptor {
  value: string | number;
  label?: string;
}

const TYPE_GUARDS: Record<string, GuardDefinition> = {
  TEXT_SHORT_FIELD: stringGuard(),
  TEXT_LONG_FIELD: stringGuard(),
  CHECKBOX_FIELD: stringGuard(),
  CHECK_BOX_FIELD: stringGuard(),
  DATE_PICKER_FIELD: isoDateGuard(),
  RADIO_BOX_FIELD: singleChoiceGuard(),
  SINGLE_SELECT_FIELD: stringGuard(),
  SELECT_FIELD: stringGuard(),
  COMBO_BOX_FIELD: singleChoiceGuard(),
  COMBO_BOX_SINGLE_FIELD: stringGuard(),
  COMBO_BOX_MULTI_FIELD: stringArrayGuard(),
  MULTI_SELECT_FIELD: stringArrayGuard(),
  COMBO_BOX_USER_FIELD: {
    expected: "number | string",
    guard: (value) => typeof value === "number" || typeof value === "string"
  },
  USER_FIELD: {
    expected: "number | string",
    guard: (value) => typeof value === "number" || typeof value === "string"
  },
  COMBO_BOX_REGISTER_FIELD: numberArrayGuard(),
  REGISTER_FIELD: numberArrayGuard(),
  COMBO_BOX_FLOW_FIELD: numberArrayGuard(),
  FLOW_FIELD: numberArrayGuard(),
  MONEY_FIELD: numberGuard(),
  CURRENCY_FIELD: numberGuard(),
  DUE_DATE_FIELD: isoDateGuard(),
  EMAIL_FIELD: emailGuard(),
  PHONE_FIELD: stringGuard(),
  PHONE_NUMBER_FIELD: stringGuard(),
  SWITCH_FIELD: booleanGuard(),
  TOGGLE_FIELD: booleanGuard(),
  LIST_ITEMS_FIELD: objectGuard(),
  ITEM_LIST_FIELD: objectGuard(),
  NUMERIC_FIELD: numberGuard(),
  NUMBER_FIELD: numberGuard(),
  DOCUMENT_FIELD: stringGuard(),
  DOCUMENTS_FIELD: stringGuard(),
  RICH_TEXT_FIELD: stringGuard(),
  INPUT_RICH_TEXT_FIELD: stringGuard(),
  HTML_FIELD: stringGuard(),
  LINK_FIELD: stringGuard(),
  URL_FIELD: stringGuard()
};

const OPTION_BOUND_TYPES = new Set(["RADIO_BOX_FIELD", "COMBO_BOX_FIELD"]);

const PT_BR_ALIASES: Record<string, string> = {
  "texto curto": "TEXT_SHORT_FIELD",
  "texto longo": "TEXT_LONG_FIELD",
  "caixa de selecao": "CHECKBOX_FIELD",
  "caixa de seleção": "CHECKBOX_FIELD",
  data: "DATE_PICKER_FIELD",
  "selecao unica": "SINGLE_SELECT_FIELD",
  "seleção única": "SINGLE_SELECT_FIELD",
  "selecao multipla": "COMBO_BOX_MULTI_FIELD",
  "seleção múltipla": "COMBO_BOX_MULTI_FIELD",
  responsavel: "COMBO_BOX_USER_FIELD",
  "responsável": "COMBO_BOX_USER_FIELD",
  "meus cadastros": "COMBO_BOX_REGISTER_FIELD",
  "meus fluxos": "COMBO_BOX_FLOW_FIELD",
  moeda: "MONEY_FIELD",
  vencimento: "DUE_DATE_FIELD",
  email: "EMAIL_FIELD",
  "e-mail": "EMAIL_FIELD",
  telefone: "PHONE_FIELD",
  interruptor: "SWITCH_FIELD",
  "lista de itens": "LIST_ITEMS_FIELD",
  numerico: "NUMERIC_FIELD",
  "numérico": "NUMERIC_FIELD",
  documentos: "DOCUMENTS_FIELD",
  "texto formatado": "RICH_TEXT_FIELD",
  link: "LINK_FIELD"
};

export function validateValueByFieldType(
  fieldType: string,
  value: unknown,
  options?: unknown
): TypeValidationResult {
  const normalizedType = normalizeFieldType(fieldType);
  const guardDef = TYPE_GUARDS[normalizedType];

  if (!guardDef) {
    return {
      valid: false,
      normalizedType,
      expected: "unknown",
      reason: `Tipo de field não mapeado: ${fieldType}`
    };
  }

  if (OPTION_BOUND_TYPES.has(normalizedType)) {
    const optionDescriptors = extractAllowedOptionDescriptors(options);
    const allowedValues = optionDescriptors.map((item) => item.value);
    if (allowedValues.length > 0) {
      const valid = isValueInOptions(value, allowedValues);
      return {
        valid,
        expected: `${guardDef.expected} (one of options)`,
        normalizedType,
        reason: valid ? undefined : buildInvalidOptionReason(value, optionDescriptors),
        allowedOptions: optionDescriptors
      };
    }
  }

  return {
    valid: guardDef.guard(value),
    expected: guardDef.expected,
    normalizedType
  };
}

export function normalizeFieldType(fieldType: string): string {
  const raw = fieldType.trim();
  if (!raw) {
    return raw;
  }

  const lower = raw.toLowerCase();
  const ptAlias = PT_BR_ALIASES[lower];
  if (ptAlias) {
    return ptAlias;
  }

  return raw.toUpperCase().replace(/[\s-]+/g, "_");
}

function stringGuard(): GuardDefinition {
  return {
    expected: "string",
    guard: (value) => typeof value === "string"
  };
}

function singleChoiceGuard(): GuardDefinition {
  return {
    expected: "string | number",
    guard: (value) => typeof value === "string" || typeof value === "number"
  };
}

function isoDateGuard(): GuardDefinition {
  return {
    expected: "string ISO",
    guard: (value) =>
      typeof value === "string" &&
      value.includes("T") &&
      !Number.isNaN(new Date(value).getTime())
  };
}

function stringArrayGuard(): GuardDefinition {
  return {
    expected: "string[]",
    guard: (value) => Array.isArray(value) && value.every((item) => typeof item === "string")
  };
}

function numberArrayGuard(): GuardDefinition {
  return {
    expected: "number[]",
    guard: (value) =>
      Array.isArray(value) &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
  };
}

function numberGuard(): GuardDefinition {
  return {
    expected: "number",
    guard: (value) => typeof value === "number" && Number.isFinite(value)
  };
}

function booleanGuard(): GuardDefinition {
  return {
    expected: "boolean",
    guard: (value) => typeof value === "boolean"
  };
}

function objectGuard(): GuardDefinition {
  return {
    expected: "object",
    guard: (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  };
}

function emailGuard(): GuardDefinition {
  return {
    expected: "string",
    guard: (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  };
}

function extractAllowedOptionDescriptors(options: unknown): OptionDescriptor[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const allowed: OptionDescriptor[] = [];
  for (const option of options) {
    if (typeof option === "string" || typeof option === "number") {
      allowed.push({
        value: option
      });
      continue;
    }

    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      continue;
    }

    const record = option as Record<string, unknown>;
    const label = pickOptionLabel(record);
    const valueCandidates = pickOptionValueCandidates(record);
    for (const valueCandidate of valueCandidates) {
      allowed.push({
        value: valueCandidate,
        label
      });
    }
  }

  return dedupeOptionDescriptors(allowed);
}

function pickOptionValueCandidates(record: Record<string, unknown>): Array<string | number> {
  const keys = ["value", "id", "id_field_option", "field_option_id", "option_id", "key"];
  const values: Array<string | number> = [];
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      values.push(candidate);
    }
  }
  return values;
}

function pickOptionLabel(record: Record<string, unknown>): string | undefined {
  const keys = ["title", "label", "name", "text"];
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function dedupeOptionDescriptors(values: OptionDescriptor[]): OptionDescriptor[] {
  const map = new Map<string, OptionDescriptor>();
  for (const value of values) {
    const key = String(value.value);
    if (!map.has(key)) {
      map.set(key, value);
      continue;
    }

    const existing = map.get(key);
    if (existing && !existing.label && value.label) {
      map.set(key, value);
    }
  }
  return Array.from(map.values());
}

function isValueInOptions(value: unknown, allowed: Array<string | number>): boolean {
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }

  const valueAsString = String(value);
  return allowed.some((candidate) => String(candidate) === valueAsString);
}

export function getExpectedFormatByFieldType(fieldType: string): string {
  const normalizedType = normalizeFieldType(fieldType);
  const guardDef = TYPE_GUARDS[normalizedType];
  return guardDef?.expected ?? "unknown";
}

function buildInvalidOptionReason(
  attemptedValue: unknown,
  options: OptionDescriptor[]
): string {
  const attempted =
    typeof attemptedValue === "string" || typeof attemptedValue === "number"
      ? String(attemptedValue)
      : JSON.stringify(attemptedValue);
  const optionValues = options.map((item) =>
    item.label ? `${String(item.value)} (${item.label})` : String(item.value)
  );
  return `Valor "${attempted}" inválido para opções do field. Opções válidas: ${optionValues.join(", ")}`;
}
