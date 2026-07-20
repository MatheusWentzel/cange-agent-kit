import { describe, expect, it } from "vitest";

import { validateValuesAgainstFields } from "../src/contracts/payload-builder.js";
import {
  getExpectedFormatByFieldType,
  normalizeFieldType,
  validateValueByFieldType
} from "../src/utils/fieldTypeGuards.js";
import type { NormalizedField } from "../src/schemas/fields.js";

// Reproduz o campo "Arte digital" do fluxo 7105 reportado pelo cliente.
const CHECKBOX_NAME = "a32515b144647d631f87c37050efea92ed35259a";

const options = [
  { value: "1", label: "Feed" },
  { value: "2", label: "Stories" },
  { value: "3", label: "Carrossel" },
  { value: "4", label: "Card para uso interno/WhatsApp" }
];

const fields: NormalizedField[] = [
  {
    id: 10,
    name: CHECKBOX_NAME,
    title: "Arte digital",
    type: "CHECK_BOX_FIELD",
    required: false,
    formId: 700,
    options,
    raw: {}
  } as NormalizedField
];

function validate(value: unknown) {
  return validateValuesAgainstFields({
    fields,
    values: { [CHECKBOX_NAME]: value },
    targetFormId: 700,
    requireRequiredFields: false
  });
}

function firstIssue(value: unknown) {
  const { issues } = validate(value);
  expect(issues.length).toBeGreaterThan(0);
  return issues[0]!;
}

describe("CHECK_BOX_FIELD — formato de valor", () => {
  it("aceita array de códigos de opção (formato que o backend exige)", () => {
    expect(validate(["1"]).issues).toHaveLength(0);
  });

  it("aceita múltiplas opções marcadas", () => {
    expect(validate(["1", "2"]).issues).toHaveLength(0);
  });

  it("aceita array vazio (nenhuma opção marcada)", () => {
    expect(validate([]).issues).toHaveLength(0);
  });

  it("rejeita string solta indicando string[] como esperado", () => {
    const issue = firstIssue("1");
    expect(issue.code).toBe("INVALID_TYPE");
    expect(issue.expected).toBe("string[]");
  });

  it("rejeita array de números (backend exige strings)", () => {
    const issue = firstIssue([1, 2]);
    expect(issue.code).toBe("INVALID_TYPE");
    expect(issue.expected).toBe("string[]");
  });

  it("rejeita o label humano e lista as opções válidas", () => {
    const issue = firstIssue(["Feed"]);
    expect(issue.code).toBe("INVALID_OPTION");
    expect(issue.message).toContain("Feed");
    expect(issue.message).toContain('"1"');
  });

  it("aponta apenas os itens inválidos numa seleção parcialmente errada", () => {
    const issue = firstIssue(["1", "99"]);
    expect(issue.code).toBe("INVALID_OPTION");
    expect(issue.message).toContain("99");
  });

  it("sem options disponíveis, valida só o formato", () => {
    expect(validateValueByFieldType("CHECK_BOX_FIELD", ["qualquer"], undefined).valid).toBe(true);
    expect(validateValueByFieldType("CHECK_BOX_FIELD", "qualquer", undefined).valid).toBe(false);
  });

  it("expõe string[] como formato esperado", () => {
    expect(getExpectedFormatByFieldType("CHECK_BOX_FIELD")).toBe("string[]");
    expect(getExpectedFormatByFieldType("CHECKBOX_FIELD")).toBe("string[]");
  });
});

describe("aliases pt-BR de campos com opções", () => {
  it('"Caixa de seleção" é o combo single, não o checkbox', () => {
    expect(normalizeFieldType("Caixa de seleção")).toBe("COMBO_BOX_FIELD");
    expect(getExpectedFormatByFieldType("Caixa de seleção")).toBe("string | number");
  });

  it('"Checkbox" resolve para o multi-valor', () => {
    expect(normalizeFieldType("Checkbox")).toBe("CHECK_BOX_FIELD");
  });
});
