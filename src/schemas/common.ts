import { z } from "zod";

export const idLikeSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/, "Expected integer numeric string")
]);

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
