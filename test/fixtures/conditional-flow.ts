/**
 * Fluxo ANÔNIMO no formato do `GET /flow` (o que o editor da tela lê) e uma regra no formato
 * que a tela grava. Ids, nomes e rótulos são inventados; o conjunto de chaves é o real.
 */

type Rec = Record<string, unknown>;

export const FLOW_ID = 100;
export const FORM_INIT = 200;
export const STEP_A = 11;
export const STEP_B = 12;

/** Chaves de um campo no `GET /flow`, com `conditionals` (o `GET /field/by-flow` traz todas menos ela). */
export const SCREEN_FIELD_KEYS = [
  "ac_child_field_id", "ac_form_answer_id", "ac_parent_field_id", "ac_type", "card_aggregate", "card_highlight",
  "card_title", "company_id", "conditionals", "description", "dt_created", "dt_last_update", "filter_schema", "flow",
  "flow_id", "form_id", "formula", "help_text", "id_field", "index", "is_just_view", "max_length", "name",
  "old_id_field", "on_edit", "on_field", "on_transaction", "options", "placeholder", "register", "register_id",
  "required", "show_on_form", "show_on_history", "title", "turn_on_field", "type", "type_view", "unique", "updated",
  "user_id_creator", "validation_type", "validations", "variation"
].sort();

/** Chaves de um item de `conditions_items` gravado pela tela. */
export const SCREEN_ITEM_KEYS = [
  "comparators", "fields", "index", "nameComponent", "selectedComparator", "selectedField", "value", "valueOptions"
];

export function field(id: number, type: string, title: string, extra: Rec = {}): Rec {
  const base: Rec = Object.fromEntries(SCREEN_FIELD_KEYS.map((key) => [key, null]));
  return {
    ...base,
    id_field: id,
    name: `hash${id}`,
    type,
    title,
    description: "",
    index: id,
    form_id: FORM_INIT,
    company_id: 1,
    required: "0",
    show_on_form: "N",
    options: [],
    validations: [],
    conditionals: [],
    ...extra
  };
}

export function options(fieldId: number, labels: Array<[string, string]>): Rec[] {
  return labels.map(([value, label], index) => ({
    id_field_option: fieldId * 10 + index,
    field_id: fieldId,
    value,
    label,
    order: String(index),
    hide: null,
    description: null,
    old_id_field_option: null
  }));
}

/** Regra como a tela grava: `selectedField` inteiro. */
export function screenRule(idConditional: number, target: number, source: Rec, overrides: Rec = {}): Rec {
  return {
    id_conditional: idConditional,
    company_id: 1,
    flow_id: FLOW_ID,
    type: "field",
    action: "1",
    index: null,
    key: target,
    field_id: target,
    flow_step_id: null,
    flow_step_parent_id: null,
    conditions_items: JSON.stringify([
      {
        index: 0,
        fields: [],
        comparators: [],
        selectedField: source,
        selectedComparator: "Igual a",
        value: "",
        nameComponent: "OPTION_FILTER",
        valueOptions: ["2"]
      }
    ]),
    name: "Quando o campo [Tipo for igual a] ",
    dt_created: "2026-01-01T00:00:00.000Z",
    dt_last_update: "2026-01-01T00:00:00.000Z",
    user_id_creator: 1,
    ...overrides
  };
}

export const TIPO = field(1, "COMBO_BOX_FIELD", "Tipo", { options: options(1, [["1", "Interno"], ["2", "Externo"], ["3", "2"]]) });
export const DETALHE = field(2, "TEXT_LONG_FIELD", "Detalhe");
export const VALOR = field(3, "CURRENCY_FIELD", "Valor");
export const PRAZO = field(4, "DATE_PICKER_FIELD", "Prazo");
export const ATIVO = field(5, "SWITCH_FIELD", "Ativo");
export const SEM_OPCOES = field(6, "RADIO_BOX_FIELD", "Sem opções");
export const DONO = field(7, "COMBO_BOX_USER_FIELD", "Dono");
export const FORNECEDOR = field(8, "COMBO_BOX_REGISTER_FIELD", "Fornecedor", { register_id: 70 });
export const PEDIDO = field(9, "COMBO_BOX_FLOW_FIELD", "Pedido", { flow_id: 80 });
export const COR = field(10, "COLOR_PICKER_FIELD", "Cor");
export const SECAO = field(13, "TITLE_FIELD", "Seção");
export const REPETIDO_A = field(14, "TEXT_SHORT_FIELD", "Repetido");
export const REPETIDO_B = field(15, "TEXT_SHORT_FIELD", "Repetido", { form_id: 201 });
export const TAXA = field(16, "FORMULA_FIELD", "Taxa");

/** Regra enxuta, como um script que monta `conditions_items` à mão grava: o editor não abre. */
export const LEAN_RULE = screenRule(900, 2, { id_field: 1, name: "hash1", title: "Tipo", type: "COMBO_BOX_FIELD" });

export function flow(rules: Rec[] = [], stepRules: Rec[] = []): Rec {
  const initFields = [
    TIPO, DETALHE, VALOR, PRAZO, ATIVO, SEM_OPCOES, DONO, FORNECEDOR, PEDIDO, COR, SECAO, REPETIDO_A, TAXA
  ];
  const withRules = (item: Rec): Rec => ({ ...item, conditionals: rules.filter((rule) => rule.field_id === item.id_field) });
  const step = (id: number, name: string, fields: Rec[]): Rec => ({
    id_step: id,
    flow_id: FLOW_ID,
    name,
    index: id,
    form_id: 200 + id,
    form: { id_form: 200 + id, fields: fields.map(withRules) },
    conditionals: stepRules.filter((rule) => rule.flow_step_id === id)
  });
  return {
    id_flow: FLOW_ID,
    name: "Fluxo de teste",
    form_init_id: FORM_INIT,
    form_init: { id_form: FORM_INIT, fields: initFields.map(withRules) },
    flow_steps: [step(STEP_A, "Entrada", [REPETIDO_B]), step(STEP_B, "Análise", [])]
  };
}
