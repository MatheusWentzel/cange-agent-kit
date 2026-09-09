import { CangeApiError } from "../client/errors.js";
import {
  createThrottle,
  isRateLimitError,
  isRetryableError,
  retryAfterMs,
  withRetry
} from "./rateLimit.js";

/**
 * Executor de MUTAÇÕES em lote: throttle + backoff + disjuntor de bloqueio,
 * com resultado POR ITEM (nada de "deu tudo certo" agregado).
 *
 * As três garantias que este runner dá a quem consome o resultado:
 *   1. Cada item tem um desfecho explícito: `ok`, falhou, ou NÃO FOI TENTADO.
 *   2. Ao tomar 429, o lote PARA: enquanto a chave está bloqueada (~5 min) TODA
 *      requisição falha, então seguir o lote só queima requisição e o tempo da
 *      execução sem criar nada. O mesmo vale para o 403 de aprovação/permissão
 *      do agente, que é one-shot por requisição: os itens seguintes tomariam
 *      403 um a um até o fim do lote.
 *   3. Quem chama consegue distinguir "criou N de M" de "criou tudo" sem
 *      parsear mensagem de erro.
 */

export type BatchAbortReason = "RATE_LIMIT_BLOCK" | "APPROVAL_BLOCK";

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
  /** Quanto esperar antes de voltar (segundos). */
  retryAfterSeconds?: number;
}

export interface BatchReport<T> {
  results: Array<BatchItemResult<T>>;
  aborted?: BatchAbort;
}

export interface RunBatchOptions {
  /** Requisições por segundo do lote. */
  rps: number;
  /** Tentativas adicionais por item em erro transitório. */
  maxRetries: number;
  /**
   * Que erro merece nova tentativa. Default: `isRetryableError` (429/5xx/rede),
   * seguro só para operação IDEMPOTENTE. Em POST não idempotente (create), quem
   * chama passa `isRateLimitError` — ver o comentário em `card create`.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Injetável em teste. */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável em teste. */
  now?: () => number;
}

/**
 * Bloqueio do `apiRateLimiter` do backend quando o teto de req/s estoura
 * (`blockTimeInMinutes` = 5). Usado como piso quando a resposta não traz
 * `Retry-After` — que é o caso hoje: o 429 do rate limiter não emite o header.
 * Quando o backend passar a emitir, o valor real vence este default.
 */
const RATE_LIMIT_BLOCK_FALLBACK_SECONDS = 300;

/**
 * `complement.code` dos 403 do gate de agente (`assertAgentActionAllowed` +
 * `approvalGate` no wendata-back). São one-shot POR REQUISIÇÃO: uma aprovação
 * libera UMA chamada, então num lote os itens seguintes tomariam 403 em
 * sequência. Melhor parar e devolver o que falta como pendente.
 */
const APPROVAL_BLOCK_CODES = new Set([
  "APPROVAL_REQUIRED",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED",
  "PERMISSION_REQUIRED"
]);

/**
 * 403 de aprovação/permissão do agente.
 *
 * O código NÃO vem em `error.code` — nada no kit popula esse campo a partir do
 * corpo HTTP. O backend serializa o `complement` do `AppError` no body
 * (`{ status, message, complement: { code, action_kind } }`) e o cliente guarda
 * o body inteiro em `error.details`. É de lá que ele é lido.
 */
export function isApprovalBlockError(error: unknown): boolean {
  return approvalBlockCode(error) !== undefined;
}

function approvalBlockCode(error: unknown): string | undefined {
  if (!(error instanceof CangeApiError) || error.status !== 403) {
    return undefined;
  }
  const details = error.details as { complement?: { code?: unknown } } | undefined;
  const code = details?.complement?.code;
  return typeof code === "string" && APPROVAL_BLOCK_CODES.has(code) ? code : undefined;
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
          shouldRetry: options.shouldRetry ?? isRetryableError,
          ...(options.sleep ? { sleep: options.sleep } : {})
        }
      );
      results.push({ index, ok: true, attempted: true, attempts, value });
    } catch (error) {
      results.push({ index, ok: false, attempted: true, attempts, error });
      aborted = abortFor(error);
    }
  }

  return { results, ...(aborted ? { aborted } : {}) };
}

function abortFor(error: unknown): BatchAbort | undefined {
  if (isRateLimitError(error)) {
    const waitMs = retryAfterMs(error);
    return {
      reason: "RATE_LIMIT_BLOCK",
      message:
        "Teto de requisições da API estourado (429). A chave fica bloqueada por ~5 minutos e, enquanto isso, " +
        "TODA tentativa falha: o lote foi INTERROMPIDO para não queimar requisições e o tempo da execução sem criar nada. " +
        "Os itens não tentados continuam pendentes — espere o bloqueio passar e rode de novo SÓ os payloads que faltaram.",
      retryAfterSeconds:
        waitMs !== undefined ? Math.round(waitMs / 1000) : RATE_LIMIT_BLOCK_FALLBACK_SECONDS
    };
  }

  const approvalCode = approvalBlockCode(error);
  if (approvalCode !== undefined) {
    return {
      reason: "APPROVAL_BLOCK",
      message:
        `Ação barrada pelo gate do agente (403 ${approvalCode}). A liberação é ONE-SHOT por requisição: ` +
        "uma aprovação/concessão libera UM item, então os seguintes tomariam 403 um a um. O lote foi INTERROMPIDO. " +
        "Peça a liberação da ação (ou o grant do agente) e rode de novo SÓ os payloads que faltaram."
    };
  }

  return undefined;
}
