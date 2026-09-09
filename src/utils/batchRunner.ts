import { createThrottle, isRateLimitError, isRetryableError, retryAfterMs, withRetry } from "./rateLimit.js";

/**
 * Executor de MUTAÇÕES em lote: throttle + backoff + disjuntor de bloqueio,
 * com resultado POR ITEM (nada de "deu tudo certo" agregado).
 *
 * As três garantias que este runner dá a quem consome o resultado:
 *   1. Cada item tem um desfecho explícito: `ok`, falhou, ou NÃO FOI TENTADO.
 *   2. Ao tomar 429 mesmo depois do backoff, o lote PARA (a chave fica
 *      bloqueada por 5 min no backend — martelar só estende o bloqueio e
 *      transforma um lote parcial em zero).
 *   3. Quem chama consegue distinguir "criou N de M" de "criou tudo" sem
 *      parsear mensagem de erro.
 */

export type BatchAbortReason = "RATE_LIMIT_BLOCK";

export interface BatchItemResult<T> {
  index: number;
  ok: boolean;
  /** Falso quando o lote abortou ANTES de chegar neste item. */
  attempted: boolean;
  /** Tentativas gastas (inclui os retries). */
  attempts: number;
  value?: T;
  error?: unknown;
}

export interface BatchAbort {
  reason: BatchAbortReason;
  message: string;
  /** Quando a API informou `Retry-After`: quando vale a pena voltar. */
  retryAfterSeconds?: number;
}

export interface BatchReport<T> {
  results: Array<BatchItemResult<T>>;
  aborted?: BatchAbort;
}

export interface RunBatchOptions {
  /** Requisições por segundo do lote. */
  rps: number;
  /** Tentativas adicionais por item em erro transitório (429/5xx/rede). */
  maxRetries: number;
  /** Injetável em teste. */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável em teste. */
  now?: () => number;
}

/**
 * Roda `fn` para cada item, SERIALMENTE e espaçado pelo `rps`.
 *
 * Serial de propósito: em escrita, ordem previsível e resultado item-a-item
 * valem mais que os poucos segundos que a concorrência economizaria — e o
 * disjuntor só é confiável se nada mais estiver em voo quando ele dispara.
 */
export async function runBatch<I, T>(
  items: readonly I[],
  options: RunBatchOptions,
  fn: (item: I, index: number) => Promise<T>
): Promise<BatchReport<T>> {
  const throttleOptions = {
    rps: options.rps,
    concurrency: 1,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {})
  };
  const throttle = createThrottle(throttleOptions);
  const results: Array<BatchItemResult<T>> = [];
  let aborted: BatchAbort | undefined;

  for (const [index, item] of items.entries()) {
    if (aborted) {
      results.push({ index, ok: false, attempted: false, attempts: 0 });
      continue;
    }

    // Contado na própria task: vale tanto para o caminho de sucesso quanto
    // para o de erro (o backoff pode desistir antes de gastar tudo).
    let attempts = 0;
    try {
      const { value } = await withRetry(
        () => {
          attempts += 1;
          return throttle.run(() => fn(item, index));
        },
        {
          maxRetries: options.maxRetries,
          shouldRetry: isRetryableError,
          ...(options.sleep ? { sleep: options.sleep } : {})
        }
      );
      results.push({ index, ok: true, attempted: true, attempts, value });
    } catch (error) {
      results.push({ index, ok: false, attempted: true, attempts, error });

      if (isRateLimitError(error)) {
        const waitMs = retryAfterMs(error);
        aborted = {
          reason: "RATE_LIMIT_BLOCK",
          message:
            "Teto de requisições da API estourado (429). A chave fica bloqueada por ~5 minutos: " +
            "o lote foi INTERROMPIDO para não estender o bloqueio. Os itens não tentados continuam pendentes — " +
            "espere o bloqueio passar e rode de novo SÓ os payloads que faltaram.",
          ...(waitMs !== undefined ? { retryAfterSeconds: Math.round(waitMs / 1000) } : {})
        };
      }
    }
  }

  return { results, ...(aborted ? { aborted } : {}) };
}
