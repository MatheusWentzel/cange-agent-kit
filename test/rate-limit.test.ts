import { describe, expect, it } from "vitest";

import { CangeApiError, CangeValidationError } from "../src/client/errors.js";
import { parseRetryAfter } from "../src/client/http.js";
import {
  createThrottle,
  isRateLimitError,
  isRetryableError,
  mapWithThrottle,
  withRetry
} from "../src/utils/rateLimit.js";

/**
 * Relógio congelado + sleep instantâneo: as tarefas se comportam como se
 * TODAS chegassem no mesmo instante (é o caso do lote), e o teste inspeciona
 * quanto cada uma teria dormido — sem gastar tempo de verdade.
 */
function fakeClock() {
  const slept: number[] = [];
  return {
    now: () => 0,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    slept
  };
}

function apiError(status: number, extra: Record<string, unknown> = {}): CangeApiError {
  return new CangeApiError(`status ${status}`, { status, ...extra });
}

describe("throttle", () => {
  it("espaça os inícios pelo rps (5 tarefas a 10/s = 4 esperas de 100ms)", async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ rps: 10, concurrency: 5, now: clock.now, sleep: clock.sleep });

    await Promise.all(
      Array.from({ length: 5 }, () => throttle.run(async () => undefined))
    );

    expect(clock.slept).toEqual([100, 200, 300, 400]);
  });

it("limita as tarefas em voo ao teto de concorrência", async () => {
    const throttle = createThrottle({ rps: 1000, concurrency: 2 });

    let inFlight = 0;
    let peak = 0;
    const pending: Array<() => void> = [];

    const runs = Array.from({ length: 6 }, () =>
      throttle.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => pending.push(resolve));
        inFlight -= 1;
      })
    );

    // Libera em ondas: se a concorrência vazasse, o pico passaria de 2.
    for (let wave = 0; wave < 4; wave += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      for (const resolve of pending.splice(0)) {
        resolve();
      }
    }
    await Promise.all(runs);

    expect(peak).toBe(2);
  });

  it("preserva a ordem do input no mapWithThrottle", async () => {
    const clock = fakeClock();
    const out = await mapWithThrottle(
      [1, 2, 3, 4],
      { rps: 1000, concurrency: 2, now: clock.now, sleep: clock.sleep },
      async (item) => item * 10
    );
    expect(out).toEqual([10, 20, 30, 40]);
  });
});

describe("classificação de erro", () => {
  it("429 é rate limit e é retryable", () => {
    expect(isRateLimitError(apiError(429))).toBe(true);
    expect(isRetryableError(apiError(429))).toBe(true);
  });

  it("5xx e falha de rede (sem status) são retryable", () => {
    expect(isRetryableError(apiError(503))).toBe(true);
    expect(isRetryableError(new CangeApiError("rede caiu"))).toBe(true);
  });

  it("4xx que não é 429 NÃO é retryable (é problema do payload)", () => {
    expect(isRetryableError(apiError(400))).toBe(false);
    expect(isRetryableError(apiError(404))).toBe(false);
    expect(isRateLimitError(apiError(400))).toBe(false);
    expect(isRetryableError(new CangeValidationError("payload inválido"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("repete com backoff exponencial e devolve as tentativas gastas", async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw apiError(429);
        return "ok";
      },
      { maxRetries: 3, sleep: clock.sleep }
    );

    expect(result).toEqual({ value: "ok", attempts: 3 });
    expect(clock.slept).toEqual([1000, 2000]);
  });

  it("honra o Retry-After da API no lugar do backoff", async () => {
    const clock = fakeClock();
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(429, { retryAfterSeconds: 3 });
        return "ok";
      },
      { maxRetries: 2, sleep: clock.sleep }
    );

    expect(clock.slept).toEqual([3000]);
  });

  it("desiste sem dormir quando a espera passa do teto (bloqueio de 5 min)", async () => {
    const clock = fakeClock();
    const error = apiError(429, { retryAfterSeconds: 300 });

    await expect(
      withRetry(
        async () => {
          throw error;
        },
        { maxRetries: 3, sleep: clock.sleep }
      )
    ).rejects.toBe(error);

    expect(clock.slept).toEqual([]);
  });

  it("não repete erro definitivo", async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw apiError(400);
        },
        { maxRetries: 3, sleep: clock.sleep }
      )
    ).rejects.toBeInstanceOf(CangeApiError);

    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });
});

describe("parseRetryAfter", () => {
  it("lê segundos", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("lê data HTTP", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(50);
  });

  it("ignora ausente/ inválido", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("depois")).toBeUndefined();
  });
});
