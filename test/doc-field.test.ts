import { describe, expect, it } from "vitest";

import { validateValuesAgainstFields } from "../src/contracts/payload-builder.js";
import { normalizeFieldType, validateValueByFieldType } from "../src/utils/fieldTypeGuards.js";
import type { NormalizedField } from "../src/schemas/fields.js";

// Caso real (run 196, 03/10/2026): o campo CNPJ do "CRM de Vendas" é DOC_FIELD e o
// --validate-fields reprovava com UNKNOWN_FIELD_TYPE, então o agente não criava o card.
const CNPJ_NAME = "c95406c0c1d6a94e506ac2989bd1fc5dc9fe08a5";
const FORMULA_NAME = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";

const CPF_NAME = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const ONLY_CNPJ_NAME = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";
const PHONE_NAME = "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0";

// R4-P2: a variation diz o tipo do documento, como a tela ("3" = CPF ou CNPJ, "2" = CNPJ, sem = CPF).
const fields: NormalizedField[] = [
  { id: 1, name: CNPJ_NAME, title: "CNPJ", type: "DOC_FIELD", variation: "3", required: true, formId: 900, raw: { variation: "3" } } as NormalizedField,
  { id: 2, name: FORMULA_NAME, title: "Total", type: "FORMULA_FIELD", required: false, formId: 900, raw: {} } as NormalizedField,
  { id: 3, name: CPF_NAME, title: "CPF", type: "DOC_FIELD", required: false, formId: 900, raw: {} } as NormalizedField,
  { id: 4, name: ONLY_CNPJ_NAME, title: "CNPJ da empresa", type: "DOC_FIELD", variation: "2", required: false, formId: 900, raw: { variation: "2" } } as NormalizedField,
  { id: 5, name: PHONE_NAME, title: "Telefone", type: "PHONE_FIELD", required: false, formId: 900, raw: {} } as NormalizedField
];

function validate(values: Record<string, unknown>) {
  return validateValuesAgainstFields({ fields, values, targetFormId: 900, requireRequiredFields: false });
}

describe("DOC_FIELD (CPF/CNPJ)", () => {
  it.each([
    ["CNPJ com máscara", "36.645.933/0001-83"],
    ["CNPJ só dígitos", "36645933000183"],
    ["CNPJ alfanumérico com máscara", "12.ABC.345/01DE-35"],
    ["CNPJ alfanumérico sem máscara", "12ABC34501DE35"],
    ["CPF com máscara", "123.456.789-09"],
    ["CPF só dígitos", "12345678909"]
  ])("aceita %s", (_label, value) => {
    const result = validate({ [CNPJ_NAME]: value });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it.each([
    ["curto demais", "123"],
    ["número em vez de texto", 36645933000183],
    ["letra no dígito verificador", "12ABC34501DEAB"]
  ])("reprova %s com INVALID_TYPE", (_label, value) => {
    const result = validate({ [CNPJ_NAME]: value });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("INVALID_TYPE");
  });

  it.each([
    ["CPF com dígito verificador errado", CPF_NAME, "555.555.555-55", "CPF inválido"],
    ["CPF repetido", CPF_NAME, "111.111.111-11", "CPF inválido"],
    ["CNPJ em campo só de CPF (a tela mascara para 11 dígitos)", CPF_NAME, "11.222.333/0001-81", "CPF inválido"],
    ["CPF em campo só de CNPJ", ONLY_CNPJ_NAME, "123.456.789-09", "CNPJ inválido"],
    ["CNPJ com dígito errado em campo CPF ou CNPJ", CNPJ_NAME, "16.505.668/0001-22", "CPF ou CNPJ inválido"],
    ["telefone curto", PHONE_NAME, "(12) 31231", "Telefone inválido"],
    ["telefone com DDI (a tela truncaria o número)", PHONE_NAME, "+55 21 98765-4321", "Telefone inválido"]
  ])("R4-P2: reprova %s com o motivo da tela", (_label, name, value, reason) => {
    const result = validate({ [name]: value });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("INVALID_TYPE");
    expect(result.issues[0]?.message).toContain(reason);
  });

  it("R4-P2: CPF, CNPJ e telefone válidos passam", () => {
    const result = validate({
      [CPF_NAME]: "111.444.777-35",
      [ONLY_CNPJ_NAME]: "11.222.333/0001-81",
      [PHONE_NAME]: "(21) 98765-4321"
    });
    expect(result.valid).toBe(true);
    expect(validateValueByFieldType("PHONE_FIELD", "2198765432").valid).toBe(true);
  });

  it("aliases pt-BR resolvem para DOC_FIELD", () => {
    expect(normalizeFieldType("CNPJ")).toBe("DOC_FIELD");
    expect(normalizeFieldType("documento")).toBe("DOC_FIELD");
    expect(validateValueByFieldType("cpf", "123.456.789-09").valid).toBe(true);
  });
});

describe("tipo sem validação local", () => {
  it("não bloqueia: valid continua true, com aviso UNKNOWN_FIELD_TYPE e o valor preservado", () => {
    const result = validate({ [CNPJ_NAME]: "36.645.933/0001-83", [FORMULA_NAME]: "x" });
    expect(result.valid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(["UNKNOWN_FIELD_TYPE"]);
    expect(result.normalizedValues[FORMULA_NAME]).toBe("x");
  });

  it("um erro real junto do aviso continua reprovando", () => {
    const result = validate({ [CNPJ_NAME]: "123", [FORMULA_NAME]: "x" });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(["INVALID_TYPE", "UNKNOWN_FIELD_TYPE"]);
  });
});
