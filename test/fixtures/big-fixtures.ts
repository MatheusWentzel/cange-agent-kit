/**
 * Fixtures GRANDES e determinísticas para medir o tamanho da saída (card #1367459, C4).
 * Um fluxo com 6 etapas e 72 campos (combos com 3 a 24 opções, rich text, vínculos)
 * e um cartão com 48 campos preenchidos, 6 deles rich text longos (ata de reunião).
 */

const STEP_IDS = [485, 486, 487, 488, 489, 490];
const STEP_FORMS = [658, 659, 660, 661, 662, 663];
const FORM_INIT = 900;

const TYPES = [
  "TEXT_SHORT_FIELD",
  "COMBO_BOX_FIELD",
  "NUMBER_FIELD",
  "INPUT_RICH_TEXT_FIELD",
  "DATE_PICKER_FIELD",
  "CHECK_BOX_FIELD",
  "CURRENCY_FIELD",
  "COMBO_BOX_USER_FIELD",
  "RADIO_BOX_FIELD"
];

function optionsFor(index: number): Array<Record<string, unknown>> {
  const count = 3 + ((index * 7) % 22);
  return Array.from({ length: count }, (_, i) => ({
    id_field_option: index * 100 + i,
    value: `opcao-${index}-${i}`,
    label: `Opção ${i + 1}`,
    color: "#ffcc00",
    index: i
  }));
}

export function bigFlowFields(): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 72; i += 1) {
    const type = TYPES[i % TYPES.length]!;
    const formId = i < 24 ? FORM_INIT : STEP_FORMS[(i - 24) % STEP_FORMS.length]!;
    const hasOptions = type === "COMBO_BOX_FIELD" || type === "CHECK_BOX_FIELD" || type === "RADIO_BOX_FIELD";
    fields.push({
      id_field: 5000 + i,
      name: `${"f".repeat(30)}${String(i).padStart(10, "0")}`,
      title: `Campo ${i} ${type === "INPUT_RICH_TEXT_FIELD" ? "Descrição" : "Informação"}`,
      type,
      required: i % 4 === 0 ? "S" : "N",
      form_id: formId,
      description: `Ajuda do campo ${i}`,
      ...(hasOptions ? { options: optionsFor(i) } : {}),
      ...(i === 70 ? { type: "COMBO_BOX_FLOW_FIELD", flow_id: 317 } : {}),
      ...(i === 71 ? { type: "COMBO_BOX_REGISTER_FIELD", register_id: 44 } : {})
    });
  }
  return fields;
}

export function bigFlow(): Record<string, unknown> {
  return {
    id_flow: 316,
    name: "CNG CRM",
    form_init_id: FORM_INIT,
    flow_steps: STEP_IDS.map((id, i) => ({
      id_step: id,
      name: `Etapa ${i + 1} do processo comercial`,
      form_id: STEP_FORMS[i],
      index: i + 1,
      color_background: "#eee",
      description: "Descrição longa da etapa que ninguém lê"
    }))
  };
}

export const BIG_MY_FLOWS = [
  { id_flow: 316, name: "CNG CRM", form_init_id: FORM_INIT, total_cards: 1200, typeUserAccess: "A" },
  { id_flow: 317, name: "Fornecedores", form_init_id: 901, total_cards: 30, typeUserAccess: "M" }
];

const ATA =
  "<p><strong>Ata da reunião</strong> com o cliente. " +
  "Discutimos <a href=\"https://app.tactiq.io/t/abc\">a transcrição</a> e os próximos passos do projeto, " +
  "incluindo prazos, responsáveis, riscos e dependências de integração com o ERP.</p>";

export function bigCardRaw(): Record<string, unknown> {
  const fields = bigFlowFields();
  const answerFields = fields.slice(0, 48).map((field, i) => {
    const type = String(field.type);
    let value: string;
    if (type === "INPUT_RICH_TEXT_FIELD") value = ATA.repeat(12);
    else if (type === "NUMBER_FIELD" || type === "CURRENCY_FIELD") value = String(1000 + i);
    else if (type === "DATE_PICKER_FIELD") value = "2026-10-06";
    else value = `Valor do campo ${i}`;
    return {
      field_id: field.id_field,
      field: { id_field: field.id_field, name: field.name, title: field.title, type },
      value,
      valueString: value,
      deleted: "N"
    };
  });
  return {
    id_card: 1001,
    flow_id: 316,
    flow_step_id: 486,
    title: "Pedido ACME",
    complete: "N",
    flow: { id_flow: 316, name: "CNG CRM" },
    flow_step: { id_step: 486, name: "Etapa 2 do processo comercial" },
    form_answers: [{ id_form_answer: 1, deleted: "N", form_answer_fields: answerFields }]
  };
}
