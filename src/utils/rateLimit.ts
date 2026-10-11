import { CangeApiError } from "../client/errors.js";
import { readsHoldingWindow } from "../client/readWindow.js";

/**
 * Throttle + retry para operações contra a API do Cange.
 *
 * POR QUE existe (achado A4 — runs 34/35 do agente Comprador, company 6728):
 * o agente criou 28 cards numa RAJADA de `card create` (loop de shell, um
 * processo por payload), estourou o teto de escrita do backend, a chave foi
 * BLOQUEADA por 5 minutos (429) e 8 dos 28 creates falharam. Como ninguém
 * conferia o retorno de cada create, o agente seguiu montando o vínculo com os
 * ids que ESPERAVA — 8 ids que nunca existiram — e fechou a tarefa como
 * sucesso. Perda silenciosa de ~29%, reproduzida 2 de 2 vezes em produção.
 *
 * Tetos do backend (`wendata-back/src/modules/middlewares/apiRateLimiter.ts`):
 *   GET   → 10 req/s   ·   WRITE → 20 req/s
 * Estourar QUALQUER um dos dois bloqueia a chave por 5 MINUTOS. Por isso os
 * defaults daqui ficam bem abaixo do teto: um lote de algumas dezenas de cards
 * custa poucos segundos a mais, e um bloqueio custa 5 minutos de integração
 * derrubada.
 */

/** Teto de LEITURA do backend (req/s por chave). */
export const BACKEND_READ_RPS_LIMIT = 10;
/** Teto de ESCRITA do backend (req/s por chave). */
export const BACKEND_WRITE_RPS_LIMIT = 20;
/** Default de escrita do kit (40% do teto). */
export const DEFAULT_WRITE_RPS = 8;
/** Default de leitura do kit (60% do teto). */
export const DEFAULT_READ_RPS = 6;

export interface ThrottleOptions {
  /** Requisições por segundo (teto do agendador). */
  rps: number;
  /** Máximo de tarefas em voo (default: 1 = serial). */
  concurrency?: number;
  /** Injetável em teste. */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável em teste. */
  now?: () => number;
}

export interface Throttle {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * Agendador que garante DOIS limites ao mesmo tempo: espaçamento mínimo entre
 * inícios (o `rps`) e número máximo de tarefas em voo (o `concurrency`).
 * Só o `concurrency` não basta: 5 requisições em voo de 50 ms cada dão 100
 * req/s — muito acima do teto.
 */
export function createThrottle(options: ThrottleOptions): Throttle {
  const rps = Math.max(0.001, options.rps);
  const intervalMs = 1000 / rps;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  let nextStartAt = 0;
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (inFlight < concurrency) {
      inFlight += 1;
      return;
    }
    // A vaga é TRANSFERIDA no release (inFlight não muda), então não há janela
    // em que dois chamadores achem que sobrou vaga.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    inFlight -= 1;
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        const current = now();
        const startAt = Math.max(current, nextStartAt);
        nextStartAt = startAt + intervalMs;
        const wait = startAt - current;
        if (wait > 0) {
          await sleep(wait);
        }
        return await task();
      } finally {
        release();
      }
    }
  };
}

/** A leitura não começou porque o prazo de quem a pediu acabou (`createReadWindowPacer`). */
export class ReadBudgetExceededError extends Error {
  constructor() {
    super("Prazo das leituras esgotado: a leitura não foi feita.");
    this.name = "ReadBudgetExceededError";
  }
}

export interface ReadWindowPacerOptions {
  /** Máximo de GETs que podem cair na mesma janela de `windowMs`, contando os de fora do pacer. */
  maxPerWindow: number;
  /** Tamanho da janela (default 1000 ms, a do back). */
  windowMs?: number;
  /**
   * Até quando cada GET ainda pode cair na janela de uma leitura que comece em `at` (em voo =
   * `Infinity`), só os que ainda seguram. Default: os GETs sem credencial (`readsHoldingWindow`, o
   * registro anônimo); quem lê com credencial passa os do cliente (`clientReadsHoldingWindow`, N-1).
   */
  holding?: (windowMs: number, at: number) => number[];
  /** Instante (ms) a partir do qual nenhuma leitura nova começa: `run` rejeita com `ReadBudgetExceededError`. */
  deadlineAt?: number;
  /** Injetável em teste. */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável em teste. */
  now?: () => number;
}

/** Com a janela cheia de GETs em voo (outra leitura em paralelo), espera e olha de novo. */
const IN_FLIGHT_POLL_MS = 20;

/**
 * REG-F1 (07/10/2026): leituras uma por vez, no ritmo que cabe no teto do back.
 *
 * O ritmo fixo (2 por segundo) não sabia das leituras feitas antes dele e, folgado demais, fazia o
 * mover de um cartão com 43 anexos levar 22 s, mais que o prazo de 15 s da conferência do gate. Aqui
 * cada leitura só começa quando menos de `maxPerWindow` GETs do processo ainda podem cair na mesma
 * janela do back que ela: o que está em voo e o que terminou há menos de `windowMs` (o back conta a
 * leitura quando ela chega, entre o início e o fim do GET; ver `readWindow`). Uma por vez. Assim, numa
 * janela fixa do back, a última leitura do pacer que cai nela tem no máximo `maxPerWindow - 1` antes
 * dela; depois dela, só um GET de fora do pacer (em paralelo) pode somar.
 *
 * Com `deadlineAt`, a leitura que não começaria a tempo nem espera: `run` rejeita com
 * `ReadBudgetExceededError` e quem chamou decide o que fazer com o que não conferiu.
 */
export function createReadWindowPacer(options: ReadWindowPacerOptions): Throttle {
  const maxPerWindow = Math.max(1, Math.trunc(options.maxPerWindow));
  const windowMs = options.windowMs ?? 1000;
  const holding = options.holding ?? readsHoldingWindow;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const { deadlineAt } = options;
  let chain: Promise<unknown> = Promise.resolve();

  async function waitTurn(): Promise<void> {
    for (;;) {
      const at = now();
      if (deadlineAt !== undefined && at >= deadlineAt) throw new ReadBudgetExceededError();
      const until = holding(windowMs, at);
      if (until.length < maxPerWindow) return;
      // Quando o mais cedo dos `maxPerWindow` que mais seguram a janela a soltar, sobra vaga.
      const releaseAt = until[until.length - maxPerWindow]!;
      const wait = Number.isFinite(releaseAt) ? Math.max(1, releaseAt - at) : IN_FLIGHT_POLL_MS;
      if (deadlineAt !== undefined && at + wait >= deadlineAt) throw new ReadBudgetExceededError();
      await sleep(wait);
    }
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        await waitTurn();
        return task();
      });
      chain = result.catch(() => undefined);
      return result;
    }
  };
}

/** `Promise.all` com throttle (ordem do input preservada na saída). */
export async function mapWithThrottle<T, R>(
  items: readonly T[],
  options: ThrottleOptions,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const throttle = createThrottle(options);
  return Promise.all(items.map((item, index) => throttle.run(() => fn(item, index))));
}

/** 429 — teto de requisições estourado (chave provavelmente bloqueada). */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof CangeApiError && error.status === 429;
}

/**
 * Erro que vale a pena repetir: 429, 5xx e falha de rede (sem status).
 * 4xx que não seja 429 é problema do PAYLOAD — repetir só queima requisição.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof CangeApiError)) {
    return false;
  }
  if (error.status === undefined) {
    return true;
  }
  return error.status === 429 || error.status >= 500;
}

/** `Retry-After` (em ms) quando a API informou; senão `undefined`. */
export function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof CangeApiError) || error.retryAfterSeconds === undefined) {
    return undefined;
  }
  return error.retryAfterSeconds * 1000;
}

export interface RetryOptions {
  /** Tentativas ADICIONAIS depois da primeira (0 = sem retry). */
  maxRetries: number;
  /** Base do backoff exponencial (default 1s → 1s, 2s, 4s…). */
  baseDelayMs?: number;
  /** Teto de espera por tentativa. Acima disso o retry é abandonado. */
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export interface RetryResult<T> {
  value: T;
  /** Tentativas gastas (1 = acertou de primeira). */
  attempts: number;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
/**
 * Teto de espera POR TENTATIVA. O bloqueio do backend é de 5 minutos: dormir
 * isso dentro de um comando trava o agente muito além de qualquer timeout útil.
 * Acima do teto, preferimos ABORTAR e devolver `retryAfterSeconds` para quem
 * chamou decidir quando voltar.
 */
const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;

/**
 * Executa `task` com backoff exponencial. Devolve também quantas tentativas
 * foram gastas — o lote reporta isso por payload, para o agente enxergar que a
 * API estava reclamando mesmo quando o item no fim deu certo.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries));
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await task(attempt), attempts: attempt };
    } catch (error) {
      const exhausted = attempt > maxRetries;
      if (exhausted || !shouldRetry(error)) {
        throw error;
      }
      const delayMs = retryAfterMs(error) ?? baseDelayMs * 2 ** (attempt - 1);
      if (delayMs > maxDelayMs) {
        // Esperar mais que o teto é pior que devolver o erro: quem chamou tem
        // o `retryAfterSeconds` e decide (o lote aborta e reporta o bloqueio).
        throw error;
      }
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
