import { z } from "zod";

import { coercedIdSchema } from "./common.js";

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Valor de uma condição. Escalar = rótulo OU código (o kit resolve). Quando o mesmo texto é
 * o código de uma opção e o rótulo de outra, o kit recusa e pede a forma explícita:
 * `{ "code": "2" }` ou `{ "label": "2" }`.
 */
export const conditionValueSchema = z.union([
  scalarSchema,
  z.object({ code: scalarSchema }).strict(),
  z.object({ label: z.string().trim().min(1) }).strict()
]);

export type ConditionValueInput = z.infer<typeof conditionValueSchema>;

export const conditionInputSchema = z
  .object({
    /** Campo de origem: id, hash (`name`) ou título. Padrão da tela: -1, -2, -3 e -4. */
    field: z.union([z.number().int(), z.string().trim().min(1)]),
    comparator: z.string().trim().min(1),
    value: conditionValueSchema.optional(),
    values: z.array(conditionValueSchema).min(1).optional()
  })
  .strict()
  .refine((input) => input.value === undefined || input.values === undefined, {
    message: "Use `value` (um) ou `values` (lista), não os dois."
  });

export type ConditionInput = z.infer<typeof conditionInputSchema>;

/** Body do `--payload`. Strict: `conditions_items`, `selectedField` etc. são montados pelo kit. */
export const conditionalPayloadSchema = z
  .object({
    action: z.union([z.string().trim().min(1), z.number()]).optional(),
    conditions: z.array(conditionInputSchema).min(1).optional()
  })
  .strict();

export type ConditionalPayload = z.infer<typeof conditionalPayloadSchema>;

export const conditionalTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("field"), idField: coercedIdSchema }).strict(),
  z.object({ type: z.literal("step"), idStep: coercedIdSchema, idStepFrom: coercedIdSchema }).strict()
]);

export type ConditionalTargetInput =
  | { type: "field"; idField: number | string }
  | { type: "step"; idStep: number | string; idStepFrom: number | string };

export type ConditionalTarget = z.infer<typeof conditionalTargetSchema>;
