import { CangeCliUsageError, CangeValidationError } from "../client/errors.js";
import { readJsonFile } from "../utils/files.js";

export function parseOptionalBoolean(input: string | boolean | undefined): boolean | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input === "boolean") {
    return input;
  }
  const normalized = input.toLowerCase();
  if (["true", "1", "s", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "n", "no"].includes(normalized)) {
    return false;
  }
  throw new CangeCliUsageError(`Valor booleano inválido: ${input}`);
}

export async function readPayloadFile<T>(payloadPath: string): Promise<T> {
  if (!payloadPath || payloadPath.trim().length === 0) {
    throw new CangeCliUsageError("Informe --payload com um caminho de arquivo JSON.");
  }
  const normalized = payloadPath.trim();
  if (looksLikeInlineJson(normalized)) {
    throw new CangeCliUsageError(
      "O argumento --payload aceita somente caminho de arquivo JSON (ex: ./payloads/create-card.json), não JSON inline."
    );
  }
  return readJsonFile<T>(payloadPath);
}

export function assertValidationResult(valid: boolean, details: unknown): void {
  if (!valid) {
    throw new CangeValidationError("Validação de fields falhou.", { details });
  }
}

function looksLikeInlineJson(input: string): boolean {
  return (
    (input.startsWith("{") && input.endsWith("}")) ||
    (input.startsWith("[") && input.endsWith("]"))
  );
}

/**
 * 5.2 (retro runs 16-19) — chaves de `values` DEVEM ser o hash (`name`) do field,
 * mas agentes erram e usam o ID numérico (run 18 perdeu um ciclo nisso). Em vez
 * de falhar, TRADUZIMOS: se houver chave toda-dígitos, buscamos os fields do
 * flow e trocamos id → hash. Chave numérica que não casa com field nenhum vira
 * erro claro (não deixamos passar para a API gravar em lugar errado).
 * Custo: 1 GET de fields, e SÓ quando existe chave numérica no payload.
 */
export async function normalizeNumericValueKeys(
  kit: { contracts: { getFieldsByFlow: (input: { flowId: string | number }) => Promise<{ fields: Array<{ id?: number | string; name: string; title?: string }> }> } },
  flowId: string | number,
  values: Record<string, unknown>,
  // Em dry-run o CLI pula a autenticação, mas a tradução precisa de 1 GET —
  // o ensureAuth entra aqui para autenticar SÓ quando há chave numérica.
  ensureAuth?: () => Promise<unknown>
): Promise<{ values: Record<string, unknown>; translatedKeys: Array<{ from: string; to: string; title?: string }> }> {
  const numericKeys = Object.keys(values).filter((key) => /^\d+$/.test(key));
  if (numericKeys.length === 0) {
    return { values, translatedKeys: [] };
  }

  if (ensureAuth) {
    await ensureAuth();
  }
  const { fields } = await kit.contracts.getFieldsByFlow({ flowId });
  const byId = new Map<string, { name: string; title?: string }>();
  for (const field of fields) {
    if (field.id !== undefined) {
      byId.set(String(field.id), { name: field.name, title: field.title });
    }
  }

  const out: Record<string, unknown> = {};
  const translatedKeys: Array<{ from: string; to: string; title?: string }> = [];
  for (const [key, value] of Object.entries(values)) {
    if (/^\d+$/.test(key)) {
      const hit = byId.get(key);
      if (!hit) {
        throw new CangeValidationError(
          `Chave numérica "${key}" em values não corresponde a nenhum field do flow ${flowId}. Use o hash (name) do field.`,
          { details: { unknownFieldId: key, flowId } }
        );
      }
      out[hit.name] = value;
      translatedKeys.push({ from: key, to: hit.name, ...(hit.title ? { title: hit.title } : {}) });
    } else {
      out[key] = value;
    }
  }
  return { values: out, translatedKeys };
}
