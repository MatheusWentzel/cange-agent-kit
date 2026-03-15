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

export const moveCardStepPayloadSchema = z.object({
  flowId: z.number().int().positive(),
  cardId: z.number().int().positive(),
  fromStepId: z.number().int().positive(),
  toStepId: z.number().int().positive(),
  complete: z.enum(["S", "N"]).optional(),
  isFromCurrentStep: z.boolean().optional(),
  isTestMode: z.boolean().optional()
});

export const moveCardStepWithValuesPayloadSchema = moveCardStepPayloadSchema.extend({
  idForm: z.number().int().positive(),
  values: valuesSchema
});

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
