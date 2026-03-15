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
