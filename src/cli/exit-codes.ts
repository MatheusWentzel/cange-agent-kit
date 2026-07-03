import {
  CangeApiError,
  CangeAuthError,
  CangeCliUsageError,
  CangeValidationError
} from "../client/errors.js";

/**
 * Exit codes estáveis por categoria de erro. Contrato para consumidores
 * (agentes) roteiarem retry/correção sem parsear a mensagem.
 */
export const EXIT_CODES = {
  /** Sucesso. */
  SUCCESS: 0,
  /** Erro inesperado / não categorizado. */
  UNEXPECTED: 1,
  /** Erro de uso ou validação (comando/flag inválido, payload inválido). */
  USAGE: 2,
  /** Erro de autenticação (credenciais ausentes/ inválidas). */
  AUTH: 3,
  /** Erro de rede ou da API do Cange. */
  API: 4
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitCodeForError(error: unknown): ExitCode {
  if (error instanceof CangeAuthError) {
    return EXIT_CODES.AUTH;
  }
  if (error instanceof CangeApiError) {
    return EXIT_CODES.API;
  }
  if (error instanceof CangeCliUsageError || error instanceof CangeValidationError) {
    return EXIT_CODES.USAGE;
  }
  return EXIT_CODES.UNEXPECTED;
}
