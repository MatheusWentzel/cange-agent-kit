import { describe, expect, it } from "vitest";

import {
  createPayloadBuilderContracts,
  validateValuesAgainstFields
} from "../src/contracts/payload-builder.js";
import type { FieldsContracts } from "../src/contracts/fields.js";
import type { FlowsContracts } from "../src/contracts/flows.js";
import type { RegistersContracts } from "../src/contracts/registers.js";
import type { NormalizedField } from "../src/schemas/fields.js";

const fields: NormalizedField[] = [
  {
    id: 1,
    name: "customer_name",
    title: "Nome do cliente",
    description: "Nome visível para identificar o cliente",
    type: "TEXT_SHORT_FIELD",
    required: true,
    formId: 662,
    raw: {}
  },
  {
    id: 2,
    name: "due_date",
    title: "Data de vencimento",
    description: "Data limite para concluir a tarefa",
    type: "DATE_PICKER_FIELD",
    required: false,
    formId: 662,
    raw: {}
  },
  {
    id: 3,
    name: "other_form_field",
    type: "TEXT_SHORT_FIELD",
    required: true,
    formId: 999,
    raw: {}
  }
];

describe("payload builder", () => {
  it("builds card template from flow init form", async () => {
    const flows: FlowsContracts = {
      getFlow: async () => ({
        raw: {},
        summary: {
          id: 192,
          formInitId: 662
        }
      })
    };

    const fieldsContracts: FieldsContracts = {
      getFieldsByFlow: async () => ({
        raw: {},
        fields,
        summary: {
          total: fields.length,
          requiredCount: 2,
          groupedByFormId: {},
          items: []
        }
      }),
      getFieldsByRegister: async () => ({
        raw: {},
        fields: [],
        summary: {
          total: 0,
          requiredCount: 0,
          groupedByFormId: {},
          items: []
        }
      })
    };

    const registers: RegistersContracts = {
      getRegister: async () => ({
        raw: {},
        summary: { formId: 700 }
      }),
      getRegisterFormAnswer: async () => ({ raw: {} }),
      createRegister: async () => ({ raw: {}, summary: {} }),
      updateRegister: async () => ({ raw: {}, summary: {} })
    };

    const contracts = createPayloadBuilderContracts({
      flows,
      fields: fieldsContracts,
      registers
    });

    const template = await contracts.buildCardCreationTemplate({ flowId: 192 });

    expect(template.context.formId).toBe(662);
    expect(template.requiredFields.map((item) => item.name)).toEqual(["customer_name"]);
    expect(template.requiredFields[0]).toMatchObject({
      title: "Nome do cliente",
      description: "Nome visível para identificar o cliente",
      expectedFormat: "string"
    });
    expect(template.payloadSkeleton).toMatchObject({
      idForm: 662,
      flowId: 192,
      values: {
        customer_name: "<TEXT_SHORT_FIELD>",
        due_date: "<DATE_PICKER_FIELD>"
      }
    });
  });

  it("validates requireds and types", () => {
    const invalid = validateValuesAgainstFields({
      values: {
        customer_name: 123,
        due_date: "invalid-date"
      },
      fields: fields.filter((item) => item.formId === 662),
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "INVALID_TYPE")).toBe(true);

    const valid = validateValuesAgainstFields({
      values: {
        customer_name: "ACME LTDA",
        due_date: "2025-07-25T12:30:00.000Z"
      },
      fields: fields.filter((item) => item.formId === 662),
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(valid.valid).toBe(true);
  });

  it("includes fieldTitle on validation issues", () => {
    const invalid = validateValuesAgainstFields({
      values: {},
      fields: fields.filter((item) => item.formId === 662),
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(invalid.valid).toBe(false);
    const missingRequiredIssue = invalid.issues.find((issue) => issue.code === "MISSING_REQUIRED");
    expect(missingRequiredIssue).toMatchObject({
      code: "MISSING_REQUIRED",
      fieldName: "customer_name",
      fieldTitle: "Nome do cliente"
    });
    expect(missingRequiredIssue?.message).toContain("Nome do cliente");
  });

  it("accepts INPUT_RICH_TEXT_FIELD as string", () => {
    const richTextField: NormalizedField[] = [
      {
        id: 10,
        name: "execution_note",
        title: "Execução",
        type: "INPUT_RICH_TEXT_FIELD",
        required: true,
        formId: 662,
        raw: {}
      }
    ];

    const valid = validateValuesAgainstFields({
      values: {
        execution_note: "<p>Etapa concluída com sucesso.</p>"
      },
      fields: richTextField,
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(valid.valid).toBe(true);
    expect(valid.issues.length).toBe(0);
  });

  it("validates RADIO_BOX_FIELD and COMBO_BOX_FIELD against options", () => {
    const optionFields: NormalizedField[] = [
      {
        id: 20,
        name: "priority_radio",
        type: "RADIO_BOX_FIELD",
        required: true,
        formId: 662,
        options: [
          { id_field_option: 1, value: "low", title: "Baixa" },
          { id_field_option: 2, value: "high", title: "Alta" }
        ],
        raw: {}
      },
      {
        id: 21,
        name: "status_combo",
        type: "COMBO_BOX_FIELD",
        required: false,
        formId: 662,
        options: [
          { id_field_option: 10, value: "todo", title: "To Do" },
          { id_field_option: 11, value: "done", title: "Done" }
        ],
        raw: {}
      }
    ];

    const invalid = validateValuesAgainstFields({
      values: {
        priority_radio: "medium",
        status_combo: "doing"
      },
      fields: optionFields,
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.issues.filter((issue) => issue.code === "INVALID_OPTION").length).toBe(2);
    expect(invalid.issues[0]?.message).toContain("Opções válidas");
    expect(invalid.issues[0]?.message).toContain("\"low\" (Baixa)");
    expect(invalid.issues[0]?.message).toContain("\"high\" (Alta)");

    const valid = validateValuesAgainstFields({
      values: {
        priority_radio: "high",
        status_combo: "done"
      },
      fields: optionFields,
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(valid.valid).toBe(true);
  });

  it("validates COMBO_BOX_REGISTER_FIELD as number[]", () => {
    const registerField: NormalizedField[] = [
      {
        id: 30,
        name: "repository",
        type: "COMBO_BOX_REGISTER_FIELD",
        required: true,
        formId: 662,
        raw: {}
      }
    ];

    const invalid = validateValuesAgainstFields({
      values: {
        repository: 8719
      },
      fields: registerField,
      requireRequiredFields: true,
      targetFormId: 662
    });
    expect(invalid.valid).toBe(false);

    const valid = validateValuesAgainstFields({
      values: {
        repository: [8719, 8720]
      },
      fields: registerField,
      requireRequiredFields: true,
      targetFormId: 662
    });
    expect(valid.valid).toBe(true);
  });

  it("does not accept option label as value in RADIO_BOX_FIELD", () => {
    const optionField: NormalizedField[] = [
      {
        id: 40,
        name: "passed_test",
        title: "Passou no teste?",
        type: "RADIO_BOX_FIELD",
        required: true,
        formId: 662,
        options: [
          { id_field_option: 1, value: "1", title: "Sim" },
          { id_field_option: 2, value: "2", title: "Não" }
        ],
        raw: {}
      }
    ];

    const invalid = validateValuesAgainstFields({
      values: {
        passed_test: "Sim"
      },
      fields: optionField,
      requireRequiredFields: true,
      targetFormId: 662
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.issues[0]).toMatchObject({
      code: "INVALID_OPTION",
      fieldName: "passed_test",
      fieldTitle: "Passou no teste?"
    });
    expect(invalid.issues[0]?.message).toContain("\"1\" (Sim)");
    expect(invalid.issues[0]?.message).toContain("\"2\" (Não)");
  });

  it("builds step-move template from step form_id", async () => {
    const flows: FlowsContracts = {
      getFlow: async () => ({
        raw: {
          id_flow: 192,
          flow_steps: [
            { id_step: 487, name: "A Fazer", form_id: 660 },
            { id_step: 87742, name: "Concluído", form_id: 661 }
          ]
        },
        summary: {
          id: 192,
          formInitId: 662
        }
      })
    };

    const fieldsContracts: FieldsContracts = {
      getFieldsByFlow: async () => ({
        raw: {},
        fields: [
          {
            id: 10,
            name: "result_test",
            title: "Resultado do Teste",
            type: "TEXT_LONG_FIELD",
            required: true,
            formId: 660,
            raw: {}
          },
          {
            id: 11,
            name: "notes",
            title: "Notas",
            type: "INPUT_RICH_TEXT_FIELD",
            required: false,
            formId: 660,
            raw: {}
          },
          {
            id: 12,
            name: "other_form",
            title: "Outro",
            type: "TEXT_SHORT_FIELD",
            required: true,
            formId: 999,
            raw: {}
          }
        ],
        summary: {
          total: 3,
          requiredCount: 2,
          groupedByFormId: {},
          items: []
        }
      }),
      getFieldsByRegister: async () => ({
        raw: {},
        fields: [],
        summary: {
          total: 0,
          requiredCount: 0,
          groupedByFormId: {},
          items: []
        }
      })
    };

    const registers: RegistersContracts = {
      getRegister: async () => ({
        raw: {},
        summary: { formId: 700 }
      }),
      getRegisterFormAnswer: async () => ({ raw: {} }),
      createRegister: async () => ({ raw: {}, summary: {} }),
      updateRegister: async () => ({ raw: {}, summary: {} })
    };

    const contracts = createPayloadBuilderContracts({
      flows,
      fields: fieldsContracts,
      registers
    });

    const template = await contracts.buildCardStepMoveTemplate({
      flowId: 192,
      fromStepId: 487,
      toStepId: 87742
    });

    expect(template.context).toMatchObject({
      kind: "flow-step-move",
      flowId: 192,
      fromStepId: 487,
      toStepId: 87742,
      formId: 660
    });
    expect(template.requiredFields.map((item) => item.name)).toEqual(["result_test"]);
    expect(template.optionalFields.map((item) => item.name)).toEqual(["notes"]);
    expect(template.payloadSkeleton).toMatchObject({
      flowId: 192,
      fromStepId: 487,
      toStepId: 87742,
      idForm: 660
    });
  });
});
