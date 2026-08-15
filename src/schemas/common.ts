import { z } from "zod";

export const idLikeSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/, "Expected integer numeric string")
]);

/**
 * Id que ACEITA number ou string numérica e SEMPRE entrega number.
 * Existe porque os templates (`cange template step-move` etc.) ecoam os ids como
 * vieram do CLI (string) — e os payloads de mutação exigiam number, fazendo o
 * skeleton do próprio kit falhar na validação ("expected number, received string").
 * Caso real: agente Comprador queimou 2 turnos nisso (run card 1219728).
 */
export const coercedIdSchema = z
  .union([z.number(), z.string().regex(/^\d+$/, "Expected integer numeric string")])
  .transform((value) => (typeof value === "number" ? value : Number.parseInt(value, 10)))
  .pipe(z.number().int().positive());

export const nonEmptyStringSchema = z.string().trim().min(1);

export const valuesSchema = z.record(z.string(), z.unknown());

export const outputSchema = z.enum(["json", "pretty"]);

export function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

export function toStringNumber(value: string | number): string {
  return typeof value === "string" ? value : String(value);
}

export function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "s", "y", "yes"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "n", "no"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

export function parseRequiredLike(value: unknown): boolean {
  return parseBooleanLike(value) ?? false;
}
