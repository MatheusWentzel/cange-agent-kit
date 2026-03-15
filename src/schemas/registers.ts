import { z } from "zod";

import { idLikeSchema, nonEmptyStringSchema, valuesSchema } from "./common.js";

export const getRegisterParamsSchema = z
  .object({
    idRegister: z.string().regex(/^\d+$/).optional(),
    hash: nonEmptyStringSchema.optional()
  })
  .refine((value) => value.idRegister !== undefined || value.hash !== undefined, {
    message: "Informe idRegister ou hash para obter register."
  });

export const getRegisterFormAnswerParamsSchema = z.object({
  formAnswerId: idLikeSchema
});

export const createRegisterPayloadSchema = z.object({
  idForm: z.number().int().positive(),
  origin: nonEmptyStringSchema,
  values: valuesSchema,
  registerContext: z.record(z.string(), z.unknown()).optional()
});

export const updateRegisterPayloadSchema = z
  .object({
    idForm: z.number().int().positive(),
    registerId: idLikeSchema.optional(),
    formAnswerId: idLikeSchema.optional(),
    values: valuesSchema
  })
  .refine((value) => value.registerId !== undefined || value.formAnswerId !== undefined, {
    message: "Informe registerId ou formAnswerId para atualizar registro."
  });
