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
  API: 4,
  /**
   * SUCESSO PARCIAL em operação de lote: parte dos itens foi processada e
   * parte NÃO. Existe para que um lote incompleto seja impossível de confundir
   * com sucesso (achado A4: o agente vinculou 8 ids de cards que nunca foram
   * criados porque a rajada saiu com exit 0). Ao receber 5: leia o resumo em
   * stdout, use SÓ os ids retornados e reprocesse os payloads que faltaram.
   */
  PARTIAL: 5
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

/**
 * Exit code de uma operação em LOTE.
 *
 * Regra (pensada para o agente decidir sem ler texto):
 *   · nada falhou                    → 0
 *   · algo passou E algo falhou      → 5 (PARTIAL: existe dado novo, e existe pendência)
 *   · nada passou                    → a categoria do primeiro erro (4/3/2/1)
 */
export function exitCodeForBatch(input: {
  succeeded: number;
  failed: number;
  firstError?: unknown;
}): ExitCode {
  if (input.failed === 0) {
    return EXIT_CODES.SUCCESS;
  }
  if (input.succeeded > 0) {
    return EXIT_CODES.PARTIAL;
  }
  return exitCodeForError(input.firstError);
}
