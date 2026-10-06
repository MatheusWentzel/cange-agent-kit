import { describe, expect, it, vi } from "vitest";

import type { NormalizedField } from "../src/schemas/fields.js";
import { readCarryOver } from "../src/utils/carryOver.js";
import {
  coerceFieldValue,
  findMissingRequired,
  formatValueIssues,
  parseFlexibleDate,
  parseLocaleNumber,
  resolveFieldValues,
  type FormScope
} from "../src/utils/valueResolver.js";

/**
 * P4 (card #1367455): resolvedor único de valores. Cada conversão que gerou erro
 * em produção (número como texto, título como chave, cadastro como texto,
 * obrigatório ausente) tem um caso aqui.
 */

function field(partial: Partial<NormalizedField> & { name: string; type: string }): NormalizedField {
  return { required: false, raw: {}, ...partial };
}

const VALOR = field({ id: 10, name: "h_valor", title: "Valor do Negócio", type: "CURRENCY_FIELD", formId: 902, required: true });
const HORAS = field({ id: 11, name: "h_horas", title: "Horas", type: "NUMBER_FIELD", formId: 902 });
const DATA = field({ id: 12, name: "h_data", title: "Data da ligação", type: "DATE_PICKER_FIELD", formId: 902, required: true });
const AGENDA = field({
  id: 13,
  name: "h_agenda",
  title: "Agendamento",
  type: "RADIO_BOX_FIELD",
  formId: 902,
  required: true,
  options: [
    { value: "1", label: "Sim" },
    { value: "2", label: "Não" }
  ]
});
const TAGS = field({
  id: 14,
  name: "h_tags",
  title: "Canais",
  type: "CHECK_BOX_FIELD",
  formId: 902,
  options: [
    { value: "wa", label: "WhatsApp" },
    { value: "em", label: "E-mail" }
  ]
});
const RESP = field({ id: 15, name: "h_resp", title: "Responsável", type: "COMBO_BOX_USER_FIELD", formId: 902 });
const CLIENTE = field({
  id: 16,
  name: "h_cliente",
  title: "Cliente",
  type: "COMBO_BOX_REGISTER_FIELD",
  formId: 902,
  raw: { register_id: 175 }
});
const PCT = field({ id: 17, name: "h_pct", title: "Confiança", type: "NUMBER_FIELD", formId: 902, variation: "2" });
const ATIVO = field({ id: 18, name: "h_ativo", title: "Ativo", type: "SWITCH_FIELD", formId: 902 });
const TITULO_INICIAL = field({ id: 20, name: "h_titulo", title: "Título", type: "TEXT_SHORT_FIELD", formId: 900, required: true });
const VALOR_INICIAL = field({ id: 21, name: "h_valor_ini", title: "Valor do negocio", type: "CURRENCY_FIELD", formId: 900 });

const ETAPA: FormScope = {
  formId: "902",
  label: "etapa Agendamento",
  priority: 0,
  fields: [VALOR, HORAS, DATA, AGENDA, TAGS, RESP, CLIENTE, PCT, ATIVO]
};
const INICIAL: FormScope = { formId: "900", label: "formulário inicial", priority: 1, fields: [TITULO_INICIAL, VALOR_INICIAL] };

describe("parseLocaleNumber", () => {
  it.each([
    ["2500", 2500],
    ["2500.5", 2500.5],
    ["2.500,00", 2500],
    ["R$ 2.500,00", 2500],
    ["r$2.500,50", 2500.5],
    ["1,234.56", 1234.56],
    ["2,5", 2.5],
    ["0,500", 0.5],
    ["1.234.567", 1234567],
    ["-3,5", -3.5],
    ["12", 12]
  ])("%s → %d", (raw, expected) => {
    expect(parseLocaleNumber(raw)).toEqual({ ok: true, value: expected });
  });

  it.each(["2.500", "1,500"])("%s é ambíguo (milhar ou decimal)", (raw) => {
    const result = parseLocaleNumber(raw);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("ambíguo");
  });

  it.each(["doze", "12abc", "1.2.3", "2,"])("%s não é número", (raw) => {
    expect(parseLocaleNumber(raw).ok).toBe(false);
  });
});

describe("parseFlexibleDate", () => {
  it("dd/mm/aaaa vira ISO da meia-noite local (como a tela)", () => {
    expect(parseFlexibleDate("06/10/2026")).toEqual({ ok: true, value: new Date(2026, 9, 6).toISOString() });
  });

  it("dd/mm/aaaa hh:mm e aaaa-mm-dd", () => {
    expect(parseFlexibleDate("06/10/2026 14:30")).toEqual({ ok: true, value: new Date(2026, 9, 6, 14, 30).toISOString() });
    expect(parseFlexibleDate("2026-10-06")).toEqual({ ok: true, value: new Date(2026, 9, 6).toISOString() });
  });

  it("ISO com fuso fica como está", () => {
    expect(parseFlexibleDate("2026-10-06T12:00:00Z")).toEqual({ ok: true, value: "2026-10-06T12:00:00.000Z" });
  });

  it("data impossível ou texto livre é erro", () => {
    expect(parseFlexibleDate("31/02/2026").ok).toBe(false);
    expect(parseFlexibleDate("amanhã").ok).toBe(false);
  });
});

describe("coerceFieldValue", () => {
  it("número e moeda em texto viram number", async () => {
    expect(await coerceFieldValue(VALOR, "R$ 2.500,00")).toEqual({ ok: true, value: 2500 });
    expect(await coerceFieldValue(HORAS, "12")).toEqual({ ok: true, value: 12 });
  });

  it("percentual aceita 90% e vira fração", async () => {
    expect(await coerceFieldValue(PCT, "90%")).toEqual({ ok: true, value: 0.9 });
  });

  it("opção pelo rótulo, sem maiúscula nem acento", async () => {
    expect(await coerceFieldValue(AGENDA, "nao")).toEqual({ ok: true, value: "2" });
    expect(await coerceFieldValue(AGENDA, "Sim")).toEqual({ ok: true, value: "1" });
    expect(await coerceFieldValue(AGENDA, "1")).toEqual({ ok: true, value: "1" });
    const bad = await coerceFieldValue(AGENDA, "Talvez");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("Sim | Não");
  });

  it("checkbox aceita rótulos separados por vírgula ou lista JSON", async () => {
    expect(await coerceFieldValue(TAGS, "whatsapp, e-mail")).toEqual({ ok: true, value: ["wa", "em"] });
    expect(await coerceFieldValue(TAGS, '["E-mail"]')).toEqual({ ok: true, value: ["em"] });
  });

  it("interruptor aceita sim/não", async () => {
    expect(await coerceFieldValue(ATIVO, "Sim")).toEqual({ ok: true, value: true });
    expect(await coerceFieldValue(ATIVO, "não")).toEqual({ ok: true, value: false });
  });

  it("usuário por id, e-mail ou nome único", async () => {
    const listUsers = vi.fn().mockResolvedValue([
      { id: 7, name: "Ana Souza", email: "ana@acme.com" },
      { id: 8, name: "Ana Lima", email: "lima@acme.com" },
      { id: 9, name: "Bruno Reis", email: "bruno@acme.com" }
    ]);
    expect(await coerceFieldValue(RESP, "7", { listUsers })).toEqual({ ok: true, value: 7 });
    expect(await coerceFieldValue(RESP, "ANA@acme.com", { listUsers })).toEqual({ ok: true, value: 7 });
    expect(await coerceFieldValue(RESP, "bruno", { listUsers })).toEqual({ ok: true, value: 9 });
    const ambiguous = await coerceFieldValue(RESP, "Ana", { listUsers });
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.error).toContain("Ana Souza (id 7");
  });

  it("usuário por e-mail segue como texto quando a lista não está disponível (o back resolve)", async () => {
    const listUsers = vi.fn().mockRejectedValue(new Error("403"));
    expect(await coerceFieldValue(RESP, "ana@acme.com", { listUsers })).toEqual({ ok: true, value: "ana@acme.com" });
  });

  describe("cadastro", () => {
    it("id, lista de ids e texto numérico viram number[]", async () => {
      expect(await coerceFieldValue(CLIENTE, 12)).toEqual({ ok: true, value: [12] });
      expect(await coerceFieldValue(CLIENTE, "12, 13")).toEqual({ ok: true, value: [12, 13] });
      expect(await coerceFieldValue(CLIENTE, "[12]")).toEqual({ ok: true, value: [12] });
    });

    it("rótulo com 1 resultado vira o id da entrada", async () => {
      const searchRegisterEntries = vi.fn().mockResolvedValue([{ id: 4410, title: "ACME LTDA" }]);
      expect(await coerceFieldValue(CLIENTE, "ACME", { searchRegisterEntries })).toEqual({ ok: true, value: [4410] });
      expect(searchRegisterEntries).toHaveBeenCalledWith("175", "ACME");
    });

    it("rótulo com 2+ resultados: o exato vence; sem exato, erro listando os candidatos", async () => {
      const searchRegisterEntries = vi.fn().mockResolvedValue([
        { id: 1, title: "ACME" },
        { id: 2, title: "ACME Filial" }
      ]);
      expect(await coerceFieldValue(CLIENTE, "acme", { searchRegisterEntries })).toEqual({ ok: true, value: [1] });
      const result = await coerceFieldValue(CLIENTE, "ACM", { searchRegisterEntries });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("ACME (id 1), ACME Filial (id 2)");
    });

    it("rótulo com 0 resultados é erro", async () => {
      const searchRegisterEntries = vi.fn().mockResolvedValue([]);
      const result = await coerceFieldValue(CLIENTE, "Inexistente", { searchRegisterEntries });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("nenhuma entrada");
    });
  });
});

describe("resolveFieldValues: chave pelo título, id ou hash", () => {
  it("título sem maiúscula/acento, id e hash caem no mesmo formulário", async () => {
    const result = await resolveFieldValues({
      values: { "valor do NEGÓCIO": "2.500,00", "11": "3", h_data: "06/10/2026" },
      forms: [ETAPA]
    });
    expect(result.issues).toEqual([]);
    expect(Object.fromEntries(result.resolved.map((item) => [item.field.name, item.value]))).toEqual({
      h_valor: 2500,
      h_horas: 3,
      h_data: new Date(2026, 9, 6).toISOString()
    });
  });

  it("título repetido em formulários de prioridades diferentes: vale o de menor prioridade", async () => {
    const result = await resolveFieldValues({ values: { "Valor do Negócio": "10" }, forms: [ETAPA, INICIAL] });
    expect(result.resolved[0]?.field.name).toBe("h_valor");
  });

  it("título ambíguo na mesma prioridade = erro listando as opções", async () => {
    const result = await resolveFieldValues({
      values: { "Valor do Negócio": "10" },
      forms: [ETAPA, { ...INICIAL, priority: 0 }]
    });
    expect(result.resolved).toEqual([]);
    expect(result.issues[0]?.kind).toBe("ambiguous_field");
    expect(result.issues[0]?.text).toContain("id 10, etapa Agendamento");
    expect(result.issues[0]?.text).toContain("id 21, formulário inicial");
  });

  it("campo de outro formulário diz de qual etapa ele é", async () => {
    const result = await resolveFieldValues({ values: { Título: "x" }, forms: [ETAPA], outOfScope: [INICIAL] });
    expect(result.issues[0]?.kind).toBe("out_of_scope");
    expect(result.issues[0]?.text).toContain("formulário inicial (form 900)");
  });

  it("chave técnica desconhecida segue como veio só com passthroughUnknown", async () => {
    const strict = await resolveFieldValues({ values: { hzzz: 1 }, forms: [ETAPA] });
    expect(strict.issues[0]?.kind).toBe("unknown_field");
    const loose = await resolveFieldValues({ values: { hzzz: 1, Inexistente: 2 }, forms: [ETAPA], passthroughUnknown: true });
    expect(loose.passthrough).toEqual({ hzzz: 1 });
    expect(loose.issues).toHaveLength(1);
  });
});

describe("mensagem compacta", () => {
  it("lista tudo de uma vez, com tipo e opções", async () => {
    const result = await resolveFieldValues({ values: { Horas: "doze" }, forms: [ETAPA] });
    const missing = findMissingRequired(ETAPA, {});
    const message = formatValueIssues([...missing, ...result.issues]);
    expect(message).toBe(
      "Falta para a etapa Agendamento: Valor do Negócio (moeda), Data da ligação (data), Agendamento (Sim | Não)\n" +
        'Valor inválido: Horas (número): "doze" não é número'
    );
    expect(message).not.toContain("—");
  });

  it("obrigatório já preenchido no cartão não é cobrado", () => {
    const missing = findMissingRequired(ETAPA, { h_valor: 1 }, new Set(["h_data", "h_agenda"]));
    expect(missing).toEqual([]);
  });

  it("obrigatório oculto no formulário (show_on_form S) não é cobrado, igual à tela", () => {
    const oculto = field({
      id: 30,
      name: "h_oculto",
      title: "Código da integração",
      type: "TEXT_SHORT_FIELD",
      formId: 902,
      required: true,
      raw: { show_on_form: "S" }
    });
    const visivel = field({ ...oculto, name: "h_visivel", title: "Contato", raw: { show_on_form: "N" } });
    const form: FormScope = { ...ETAPA, fields: [oculto, visivel] };
    const missing = findMissingRequired(form, {});
    expect(missing.map((issue) => issue.text)).toEqual(["Contato (texto)"]);
  });
});

describe("readCarryOver: campos que o cartão já tem na etapa atual", () => {
  it("remonta por tipo, o snapshot mais recente vence e tipo sem remontagem vai para notKept", () => {
    const anexo = field({ id: 19, name: "h_anexo", title: "Proposta", type: "INPUT_ATTACH_FIELD", formId: 902 });
    const raw = {
      id_card: 55,
      form_answers: [
        {
          id_form_answer: 1,
          form_id: 902,
          dt_created: "2026-10-01 10:00:00",
          form_answer_fields: [{ field_id: 11, value: "5" }]
        },
        {
          id_form_answer: 2,
          form_id: 902,
          dt_created: "2026-10-02 10:00:00",
          form_answer_fields: [
            { field_id: 11, value: "7" },
            { field_id: 16, value: "12", index: 0 },
            { field_id: 16, value: "13", index: 1 },
            { field_id: 18, value: "true" },
            { field_id: 19, value: "999" }
          ]
        },
        { id_form_answer: 3, form_id: 900, form_answer_fields: [{ field_id: 20, value: "outro form" }] }
      ]
    };
    const carry = readCarryOver(raw, "902", [...ETAPA.fields, anexo]);
    expect(carry.values).toEqual({ h_horas: 7, h_cliente: [12, 13], h_ativo: true });
    expect(carry.notKept).toEqual([{ name: "h_anexo", title: "Proposta" }]);
    expect([...carry.filled].sort()).toEqual(["h_anexo", "h_ativo", "h_cliente", "h_horas"]);
  });
});
