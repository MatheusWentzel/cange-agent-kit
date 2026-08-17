import type { NormalizedField } from "../schemas/fields.js";

/**
 * Skeleton de `values` para templates. Campo OBRIGATÓRIO vira `<TIPO>`; campo
 * OPCIONAL vira `<OPTIONAL:TIPO>` — a marcação existe porque agente-LLM sem
 * instrução DESCARTA o placeholder opcional em vez de preenchê-lo (run 19 do
 * Comprador removeu o vínculo "Itens da Cotação" do skeleton e os cards criados
 * ficaram órfãos). O `skeletonNote` dos templates explica a regra.
 */
export function buildValuesSkeleton(fields: NormalizedField[]): Record<string, string> {
  const skeleton: Record<string, string> = {};
  for (const field of fields) {
    const placeholder = normalizePlaceholder(field.type);
    skeleton[field.name] = field.required ? `<${placeholder}>` : `<OPTIONAL:${placeholder}>`;
  }
  return skeleton;
}

/** Nota-padrão que acompanha todo payloadSkeleton com campos opcionais. */
export const SKELETON_NOTE =
  "Campos <TIPO> são OBRIGATÓRIOS: preencha todos. Campos <OPTIONAL:TIPO> são opcionais: " +
  "PREENCHA os que a sua tarefa pede (ex.: campos de vínculo como 'Itens da Cotação') e " +
  "REMOVA apenas os que realmente não se aplicam — nunca envie um placeholder literal.";

function normalizePlaceholder(type: string): string {
  const normalized = type.trim().replace(/\s+/g, "_").toUpperCase();
  return normalized.length > 0 ? normalized : "VALUE";
}
