import { inspect } from "node:util";

import type { CangeError } from "../client/errors.js";

import type { OutputProfile } from "./lean.js";

export type OutputMode = "json" | "pretty";

export interface CliPrinter {
  print: (value: unknown) => void;
  printError: (error: unknown) => void;
}

/**
 * `profile` (rodada 5): no perfil `lean` (padrão) o JSON de sucesso sai SEM
 * indentação (a indentação custava ~1,9 token por linha relida pelo agente);
 * `full` mantém o JSON indentado de antes. Erro sai sempre como antes (stderr,
 * indentado): o runner e o agente leem o código e o status dele.
 */
export function createCliPrinter(outputMode: OutputMode, profile: OutputProfile = "full"): CliPrinter {
  return {
    print(value) {
      if (outputMode === "json") {
        process.stdout.write(`${profile === "lean" ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatPretty(value)}\n`);
    },
    printError(error) {
      if (outputMode === "json") {
        process.stderr.write(`${JSON.stringify(serializeError(error), null, 2)}\n`);
        return;
      }
      process.stderr.write(`${formatPretty(serializeError(error))}\n`);
    }
  };
}

export function formatPretty(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, { depth: 10, colors: false, compact: false });
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (isCangeError(error)) {
    return error.toJSON() as unknown as Record<string, unknown>;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: "Erro inesperado.",
    details: error
  };
}

function isCangeError(value: unknown): value is CangeError {
  return (
    value !== null &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof (value as CangeError).toJSON === "function"
  );
}
