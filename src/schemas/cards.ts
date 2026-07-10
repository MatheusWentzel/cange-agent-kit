import { z } from "zod";

import { idLikeSchema, nonEmptyStringSchema, valuesSchema } from "./common.js";

export const createCardPayloadSchema = z.object({
  idForm: z.number().int().positive(),
  flowId: z.number().int().positive(),
  origin: nonEmptyStringSchema,
  values: valuesSchema
});

export const updateCardPayloadSchema = z
  .object({
    flowId: z.number().int().positive(),
    cardId: z.number().int().positive(),
    userId: z.number().int().positive().optional(),
    dtDue: z.string().optional(),
    flowTagId: z.number().int().positive().optional(),
    complete: z.enum(["S", "N"]).optional(),
    archived: z.enum(["S", "N"]).optional()
  })
  .refine(
    (value) =>
      value.userId !== undefined ||
      value.dtDue !== undefined ||
      value.flowTagId !== undefined ||
      value.complete !== undefined ||
      value.archived !== undefined,
    {
      message: "Ao menos um atributo mutável deve ser enviado em updateCard."
    }
  );

export const updateCardValuesPayloadSchema = z.object({
  idForm: z.number().int().positive(),
  flowId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  values: valuesSchema
});

export const addCardLabelPayloadSchema = z.object({
  flowId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  flowTagId: z.number().int().positive()
});

// Leitura confiável da relação pai-filho (COMBO_BOX_FLOW_FIELD / "Meus Fluxos").
// `flowId` é o flow ALVO do campo de vínculo; `cardId` é o card cujo id está
// armazenado no `form_answer_field.value`. Retorna os cards que o referenciam
// (direção filho -> pai). Os read-models (card get / FlowQuery V2) NÃO expõem
// esse vínculo; esta é a leitura correta.
export const cardRelationshipParamsSchema = z.object({
  flowId: idLikeSchema,
  cardId: idLikeSchema,
  withCards: z.boolean().optional()
});

// Cria um card filho em outro fluxo e o vincula ao campo "Meus Fluxos" do pai.
// O campo é MULTI-VALOR e o update é REPLACE — por isso `parent.existingChildIds`
// deve trazer os filhos atuais (read-modify-write); o comando envia
// [...existingChildIds, novoId] de uma vez. Omitir existingChildIds = só o novo
// (caso "primeiro marco"); para preservar vínculos existentes, é OBRIGATÓRIO passá-los.
export const addChildCardPayloadSchema = z.object({
  child: z.object({
    flowId: z.number().int().positive(),
    idForm: z.number().int().positive(),
    origin: nonEmptyStringSchema,
    values: valuesSchema
  }),
  parent: z.object({
    flowId: z.number().int().positive(),
    cardId: z.number().int().positive(),
    idForm: z.number().int().positive(),
    linkField: nonEmptyStringSchema,
    existingChildIds: z.array(z.number().int().positive()).optional()
  })
});

const moveCardStepBasePayloadSchema = z.object({
  flowId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  fromStepId: z.number().int().positive(),
  toStepId: z.number().int().positive(),
  // Opcional: se omitido, o contrato resolve o form da etapa DESTINO (toStepId).
  // Um move usa o form de uma ETAPA (origem ou destino) — nunca o form de criação
  // (form_init), que criaria um form_answer duplicado sob o form_init e quebraria o V2.
  idForm: z.number().int().positive().optional(),
  values: valuesSchema,
  complete: z.enum(["S", "N"]).optional(),
  isFromCurrentStep: z.boolean().optional(),
  isTestMode: z.boolean().optional()
});

export const moveCardStepWithValuesPayloadSchema = moveCardStepBasePayloadSchema;

// Deprecated alias: endpoint exige idForm + values em qualquer movimentação.
export const moveCardStepPayloadSchema = moveCardStepBasePayloadSchema;

export const getCardParamsSchema = z.object({
  cardId: idLikeSchema,
  flowId: idLikeSchema,
  companyId: idLikeSchema.optional()
});

export const listCardsByFlowParamsSchema = z.object({
  flowId: idLikeSchema,
  isTestModel: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  isWithPreAnswer: z.boolean().optional(),
  isWithTimeTracking: z.boolean().optional()
});
