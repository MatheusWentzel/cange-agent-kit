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

/**
 * Criação de registro de cadastro.
 *
 * `registerId` é OBRIGATÓRIO: o backend resolve a referência do formulário por
 * `register_id` (ou `flow_id`) no nível RAIZ do body de `POST /form/new-answer`.
 * Sem ele a rota devolve 404 "Parâmetros inválidos, não foi possível encontrar a
 * referência do formulário!" antes mesmo de olhar o `id_form`. O antigo
 * `registerContext` era aninhado e o backend nunca o leu.
 */
export const createRegisterPayloadSchema = z.object({
  idForm: z.number().int().positive(),
  origin: nonEmptyStringSchema,
  values: valuesSchema,
  registerId: idLikeSchema
});

/**
 * Atualização de registro de cadastro.
 *
 * Na prática o backend exige `registerId` JUNTO de `formAnswerId`: `PUT /form/answer`
 * despacha por `register_id` (ou `flow_id`) e devolve 404 quando só recebe o
 * `form_answer_id`. O schema aceita um ou outro por compatibilidade, mas mandar só
 * o `formAnswerId` falha na API.
 */
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

export const getRegisterEngineStatusParamsSchema = z.object({
  registerId: idLikeSchema
});

/**
 * Params do smart reader de cadastros (`getRegisterEntries`).
 * Paginação é por cursor (só o caminho v2 pagina; v1 devolve tudo numa página).
 * `pageSize` tem teto de 200 no back (rota v2).
 */
export const getRegisterEntriesParamsSchema = z.object({
  registerId: idLikeSchema,
  search: z.string().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional()
});
