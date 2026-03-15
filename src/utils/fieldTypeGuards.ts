export interface TypeValidationResult {
  valid: boolean;
  expected: string;
  normalizedType: string;
  reason?: string;
}

type GuardFn = (value: unknown) => boolean;

interface GuardDefinition {
  expected: string;
  guard: GuardFn;
}

const TYPE_GUARDS: Record<string, GuardDefinition> = {
  TEXT_SHORT_FIELD: stringGuard(),
  TEXT_LONG_FIELD: stringGuard(),
  CHECKBOX_FIELD: stringGuard(),
  CHECK_BOX_FIELD: stringGuard(),
  DATE_PICKER_FIELD: isoDateGuard(),
  SINGLE_SELECT_FIELD: stringGuard(),
  SELECT_FIELD: stringGuard(),
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
  HTML_FIELD: stringGuard(),
  LINK_FIELD: stringGuard(),
  URL_FIELD: stringGuard()
};

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

export function validateValueByFieldType(fieldType: string, value: unknown): TypeValidationResult {
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
