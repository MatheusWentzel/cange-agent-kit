import { afterEach, describe, expect, it } from "vitest";

import { noteRead, readsHoldingWindow, resetReadWindow } from "../src/client/readWindow.js";
import { createReadWindowPacer, ReadBudgetExceededError } from "../src/utils/rateLimit.js";

/**
 * REG-F1 (revisão final do lote F2-F6, 07/10/2026): o ritmo fixo de 2 leituras por segundo levava
 * 22 s no mover do cartão 921055 (43 anexos) e estourava o prazo de 15 s da conferência do gate.
 * O pacer novo lê no ritmo do teto do back (contando os GETs de antes) e tem prazo.
 */

/** Relógio virtual: o sleep avança o tempo (o pacer é serial, então a conta fecha). */
function virtualClock() {
  let time = 0;
  const slept: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      slept.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    slept
  };
}

/** A janela fixa do `apiRateLimiter` do back: começa na 1ª leitura e zera 1 s depois; a 11ª bloqueia. */
function backPeak(starts: number[]): number {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  let peak = 0;
  for (const at of starts) {
    if (at - windowStart >= 1000) {
      windowStart = at;
      count = 0;
    }
    count += 1;
    peak = Math.max(peak, count);
  }
  return peak;
}

/** Maior número de inícios em qualquer janela `(t - 1000, t]`. */
function rollingPeak(starts: number[]): number {
  return Math.max(...starts.map((at) => starts.filter((other) => other > at - 1000 && other <= at).length));
}

function setup(options: { deadlineAt?: number; maxPerWindow?: number } = {}) {
  const clock = virtualClock();
  const starts: number[] = [];
  const ends: number[] = [];
  /** Um GET de 5 ms. */
  const get = async (): Promise<number> => {
    starts.push(clock.now());
    clock.advance(5);
    ends.push(clock.now());
    return starts.length;
  };
  const pacer = createReadWindowPacer({
    maxPerWindow: options.maxPerWindow ?? 8,
    // Como o `readsHoldingWindow`: o GET segura a janela até 1 s depois do fim.
    holding: (windowMs, at) => ends.map((end) => end + windowMs).filter((until) => until > at).sort((a, b) => a - b),
    now: clock.now,
    sleep: clock.sleep,
    ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {})
  });
  return { clock, starts, get, pacer };
}

afterEach(() => {
  resetReadWindow();
});

describe("REG-F1: createReadWindowPacer", () => {
  it("921055 (4 GETs do mover e 43 anexos): conta os de antes, nunca passa do teto do back e termina em uns 5 s", async () => {
    const { clock, starts, get, pacer } = setup();
    // O mover leu fluxo, campos, cartão e pré-resposta antes de conferir os anexos.
    for (let index = 0; index < 4; index += 1) await get();

    await Promise.all(Array.from({ length: 43 }, () => pacer.run(get)));

    expect(starts).toHaveLength(47);
    expect(rollingPeak(starts)).toBeLessThanOrEqual(8);
    expect(backPeak(starts)).toBeLessThanOrEqual(10);
    // Só 4 vagas sobravam na 1ª janela: a 5ª leitura do pacer espera 1 s depois do FIM do 1º GET do mover.
    expect(starts.slice(4, 8)).toEqual([20, 25, 30, 35]);
    expect(starts[8]).toBe(1005);
    // 47 GETs a 8 por janela de 1 s: uns 5 s (o ritmo fixo de 2/s dava 21,5 s, acima dos 15 s do gate).
    expect(clock.now()).toBeLessThan(6000);
  });

  it("uma leitura por vez, e a que falha não trava as próximas", async () => {
    const { pacer } = setup({ maxPerWindow: 1000 });
    let inFlight = 0;
    let peak = 0;
    const task = (fail: boolean) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (fail) throw new Error("404");
      return "ok";
    };

    const results = await Promise.allSettled([pacer.run(task(false)), pacer.run(task(true)), pacer.run(task(false))]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(peak).toBe(1);
  });

  it("com prazo: a leitura que não começaria a tempo rejeita sem esperar, e as seguintes também", async () => {
    const { clock, starts, get, pacer } = setup({ deadlineAt: 1500 });

    const results = await Promise.allSettled(Array.from({ length: 43 }, () => pacer.run(get)));

    // 8 na 1ª janela, 8 na 2ª; a 17ª só começaria em 2010, depois do prazo: nem espera.
    expect(starts).toHaveLength(16);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(27);
    for (const result of rejected) expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ReadBudgetExceededError);
    expect(clock.now()).toBeLessThan(1500);
    expect(clock.slept.every((ms) => ms < 1500)).toBe(true);
  });

  it("prazo zerado: nenhuma leitura começa", async () => {
    const { starts, get, pacer } = setup({ deadlineAt: 0 });

    await expect(pacer.run(get)).rejects.toBeInstanceOf(ReadBudgetExceededError);
    expect(starts).toEqual([]);
  });
});

describe("REG-F1: readWindow (os GETs que o cliente HTTP anota)", () => {
  it("o GET segura a janela do início até 1 s depois do fim; em voo, segura sempre", () => {
    const first = noteRead(1000);
    first(1050);
    const second = noteRead(1500);

    expect(readsHoldingWindow(1000, 1500)).toEqual([2050, Infinity]);
    second(1600);
    expect(readsHoldingWindow(1000, 2049)).toEqual([2050, 2600]);
    // Exatamente 1 s depois do fim já não segura.
    expect(readsHoldingWindow(1000, 2050)).toEqual([2600]);
    expect(readsHoldingWindow(1000, 2600)).toEqual([]);
  });

  it("o que começa depois do instante pedido não conta, e o histórico velho é descartado", () => {
    noteRead(0)(5);
    noteRead(10_000)(10_010);

    expect(readsHoldingWindow(1000, 9_000)).toEqual([]);
    expect(readsHoldingWindow(1000, 10_005)).toEqual([11_010]);
    expect(readsHoldingWindow(20_000, 10_005)).toEqual([30_010]);
  });

  it("GET em voo há mais de 1 min (perdido) não trava a janela", () => {
    noteRead(0);

    expect(readsHoldingWindow(1000, 59_999)).toEqual([Infinity]);
    expect(readsHoldingWindow(1000, 60_000)).toEqual([]);
  });
});
