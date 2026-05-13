import { z } from "zod";

import { idLikeSchema } from "./common.js";

export const FIELD_TYPES_FOR_API = [
  "TEXT_SHORT_FIELD",
  "TEXT_LONG_FIELD",
  "INPUT_RICH_TEXT_FIELD",
  "DATE_PICKER_FIELD",
  "DUE_DATE_FIELD",
  "COMBO_BOX_USER_FIELD",
  "REQUESTER_FIELD",
  "COMBO_BOX_FIELD",
  "RADIO_BOX_FIELD",
  "CHECK_BOX_FIELD",
  "CURRENCY_FIELD",
  "NUMBER_FIELD",
  "CHECK_LIST_FIELD",
  "FORMULA_FIELD",
  "INPUT_ATTACH_FIELD",
  "MAIL_FIELD",
  "PHONE_FIELD",
  "DOC_FIELD",
  "LINK_FIELD",
  "BUTTON_FIELD",
  "SWITCH_FIELD",
  "INPUT_LIST_FIELD",
  "DYNAMIC_TEXT_FIELD",
  "ID_FIELD",
  "TITLE_FIELD",
  "DESCRIPTION_FIELD",
  "DIVIDER_FIELD"
] as const;

export type FlowBuildFieldType = (typeof FIELD_TYPES_FOR_API)[number];

export const NO_ANSWER_FIELD_TYPES: readonly FlowBuildFieldType[] = [
  "BUTTON_FIELD",
  "TITLE_FIELD",
  "DESCRIPTION_FIELD",
  "DIVIDER_FIELD"
];

export const OPTIONS_REQUIRED_FIELD_TYPES: readonly FlowBuildFieldType[] = [
  "COMBO_BOX_FIELD",
  "RADIO_BOX_FIELD",
  "CHECK_BOX_FIELD"
];

const ynSchema = z.enum(["S", "N"]);
const zeroOneSchema = z.enum(["0", "1"]);

export const fieldTypeParamSchema = z.object({
  type: z.enum(FIELD_TYPES_FOR_API)
});

export const idFlowParamSchema = z.object({
  idFlow: idLikeSchema
});

export const idFlowStepParamSchema = z.object({
  idFlow: idLikeSchema,
  idStep: idLikeSchema
});

export const idFlowFieldParamSchema = z.object({
  idFlow: idLikeSchema,
  idField: idLikeSchema
});

export const idFlowStepFieldParamSchema = z.object({
  idFlow: idLikeSchema,
  idStep: idLikeSchema,
  idField: idLikeSchema
});

export const idFlowFormParamSchema = z.object({
  idFlow: idLikeSchema,
  formId: idLikeSchema
});

export const idFlowFormFieldParamSchema = z.object({
  idFlow: idLikeSchema,
  formId: idLikeSchema,
  idField: idLikeSchema
});

export const createFlowPayloadSchema = z
  .object({
    workspace_id: z.number().int().positive().optional(),
    name: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    button_add_name: z.string().optional(),
    isPrivate: z.string().optional(),
    isAllowedArchive: ynSchema.optional(),
    isAllowedDelete: ynSchema.optional()
  })
  .strict();

export type CreateFlowPayload = z.infer<typeof createFlowPayloadSchema>;

const updateFlowBaseSchema = z
  .object({
    rascunho: z.string().optional(),
    name: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    form_init_id: z.number().int().positive().optional(),
    button_add_name: z.string().optional(),
    isPrivate: z.string().optional(),
    email_type: z.string().optional(),
    company_email_config_id: z.union([z.number().int().positive(), z.null()]).optional(),
    schema_view: z.string().optional(),
    isAllowedListEdit: z.string().optional(),
    isAllowedArchive: ynSchema.optional(),
    isAllowedDelete: ynSchema.optional(),
    card_layout_schema: z.string().optional()
  })
  .strict();

export const updateFlowPayloadSchema = updateFlowBaseSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "Informe ao menos uma propriedade para atualizar." }
);

export type UpdateFlowPayload = z.infer<typeof updateFlowPayloadSchema>;

export const createStepPayloadSchema = z
  .object({
    name: z.string().min(1),
    form_name: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    isAddable: zeroOneSchema.optional(),
    isEndStep: zeroOneSchema.optional(),
    isRequiredTrack: zeroOneSchema.optional(),
    isRestrictMove: zeroOneSchema.optional(),
    description: z.string().optional(),
    user_id_owner: z.number().int().positive().optional(),
    due_time_type: z.number().int().optional(),
    due_time: z.number().int().optional(),
    due_time_bd: z.string().optional()
  })
  .strict();

export type CreateStepPayload = z.infer<typeof createStepPayloadSchema>;

const updateStepBaseSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    name: z.string().min(1).optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    isAddable: zeroOneSchema.optional(),
    isEndStep: zeroOneSchema.optional(),
    isRequiredTrack: zeroOneSchema.optional(),
    isRestrictMove: zeroOneSchema.optional(),
    description: z.string().optional(),
    user_id_owner: z.union([z.number().int().positive(), z.null()]).optional(),
    due_time_type: z.union([z.number().int(), z.null()]).optional(),
    due_time: z.union([z.number().int(), z.null()]).optional(),
    due_time_bd: z.union([z.string(), z.null()]).optional()
  })
  .strict();

export const updateStepPayloadSchema = updateStepBaseSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "Informe ao menos uma propriedade para atualizar." }
);

export type UpdateStepPayload = z.infer<typeof updateStepPayloadSchema>;

export const reorderStepPayloadSchema = z
  .object({
    id_step: z.number().int().positive(),
    upDown: z.enum(["up", "down"])
  })
  .strict();

export type ReorderStepPayload = z.infer<typeof reorderStepPayloadSchema>;

const fieldOptionSchema = z
  .object({
    value: z.union([z.string(), z.number()]),
    label: z.string(),
    hide: z.union([z.string(), z.boolean()]).optional(),
    order: z.number().int().nonnegative().optional(),
    id_field_option: z.number().int().positive().optional()
  })
  .strict();

const fieldValidationSchema = z
  .object({
    type: z.string().min(1),
    params: z.string()
  })
  .strict();

const FORMULA_INVALID_CHARS = /[[\]]/;

const createFieldBaseSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(FIELD_TYPES_FOR_API),
    title: z.string().optional(),
    index: z.number().int().nonnegative(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    help_text: z.string().optional(),
    required: z.string().optional(),
    validation_type: z.string().optional(),
    variation: z.string().optional(),
    formula: z.string().optional(),
    options: z.array(fieldOptionSchema).optional(),
    validations: z.array(fieldValidationSchema).optional(),
    filter_schema: z.string().optional(),
    register_id: z.number().int().positive().optional(),
    flow_id: z.number().int().positive().optional()
  })
  .strict();

export const createFieldPayloadSchema = createFieldBaseSchema.superRefine((value, ctx) => {
  if (OPTIONS_REQUIRED_FIELD_TYPES.includes(value.type)) {
    if (!value.options || value.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `options[] obrigatório e não-vazio para tipo ${value.type}.`
      });
    }
  }
  if (value.type === "FORMULA_FIELD" && value.formula && FORMULA_INVALID_CHARS.test(value.formula)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["formula"],
      message: "formula não pode conter '[' ou ']'. Use placeholders {nome_do_campo}."
    });
  }
  if (NO_ANSWER_FIELD_TYPES.includes(value.type)) {
    if (value.required && value.required !== "0") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required"],
        message: `required deve ser '0' para tipo ${value.type} (campos sem resposta).`
      });
    }
    const hasRequiredValidation = value.validations?.some(
      (validation) => validation.type === "required"
    );
    if (hasRequiredValidation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validations"],
        message: `Não envie validações 'required' para tipo ${value.type}.`
      });
    }
  }
});

export type CreateFieldPayload = z.infer<typeof createFieldPayloadSchema>;

const patchFieldBaseSchema = z
  .object({
    name: z.string().min(1).optional(),
    title: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    help_text: z.string().optional(),
    required: z.string().optional(),
    validation_type: z.string().optional(),
    variation: z.string().optional(),
    formula: z.string().optional(),
    options: z.array(fieldOptionSchema).optional(),
    validations: z.array(fieldValidationSchema).optional(),
    filter_schema: z.string().optional(),
    register_id: z.number().int().positive().optional(),
    flow_id: z.number().int().positive().optional()
  })
  .strict();

export const patchFieldPayloadSchema = patchFieldBaseSchema.superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Informe ao menos uma propriedade para atualizar."
    });
  }
  if (value.formula && FORMULA_INVALID_CHARS.test(value.formula)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["formula"],
      message: "formula não pode conter '[' ou ']'. Use placeholders {nome_do_campo}."
    });
  }
});

export type PatchFieldPayload = z.infer<typeof patchFieldPayloadSchema>;

export const stepRelationshipBodySchema = z
  .object({
    flow_step_id: z.number().int().positive(),
    step_available_id: z.number().int().positive(),
    isActive: zeroOneSchema
  })
  .strict();

export type StepRelationshipBodyPayload = z.infer<typeof stepRelationshipBodySchema>;

export const stepRelationshipFromQuerySchema = z.object({
  idFlow: idLikeSchema,
  idStep: idLikeSchema
});
