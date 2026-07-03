import { CangeCliUsageError } from "../client/errors.js";
import type { OutputMode } from "../utils/output.js";

interface OutputStreamLike {
  isTTY?: boolean;
}

/**
 * Resolve o modo de saída priorizando o caminho feliz do consumidor máquina:
 * - `--output` explícito vence (json|pretty), erro de uso se inválido.
 * - senão `CANGE_OUTPUT` (json|pretty).
 * - senão: **json quando stdout NÃO é TTY** (pipe/redirect) e pretty em terminal.
 *
 * Assim o agente obtém JSON parseável sem precisar lembrar de nenhuma flag.
 */
export function resolveOutputMode(
  flag: string | undefined,
  stream: OutputStreamLike = process.stdout
): OutputMode {
  if (flag !== undefined) {
    if (flag !== "json" && flag !== "pretty") {
      throw new CangeCliUsageError("Valor inválido para --output. Use json ou pretty.");
    }
    return flag;
  }

  const env = process.env.CANGE_OUTPUT;
  if (env === "json" || env === "pretty") {
    return env;
  }

  return stream.isTTY ? "pretty" : "json";
}
