import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_READS_PER_SECOND, createCangeClient } from "../src/client/http.js";
import { resetReadWindow } from "../src/client/readWindow.js";

/**
 * K-03 (code review do Alex, lote v9): o back permite 10 GET/s por chave e a 11ª bloqueia a chave
 * por 5 minutos. Só a conferência do `screen-refs` passava pelo pacer; agora todo GET do cliente
 * HTTP passa, com teto de 7 por segundo (folga para o processo vizinho: gate e execução real).
 * Relógio real: a rajada leva uns 2 s.
 */

const envBackup = { ...process.env };

beforeEach(() => {
  delete process.env.CANGE_READS_PER_SECOND;
  resetReadWindow();
});

afterEach(() => {
  process.env = { ...envBackup };
  resetReadWindow();
});

/** Maior número de inícios em qualquer janela de 1 s. */
function rollingPeak(starts: number[]): number {
  return Math.max(...starts.map((at) => starts.filter((other) => other >= at && other < at + 1000).length));
}

describe("K-03: teto de leitura do cliente HTTP", () => {
  it("rajada de 15 GETs simultâneos: nunca mais de 7 numa janela de 1 s, e eles seguem em paralelo", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const client = createCangeClient({
      baseUrl: "https://api.teste.local",
      appOrigin: "https://app.teste.local",
      accessToken: "token",
      fetchFn: (async () => {
        starts.push(Date.now());
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });

    await Promise.all(Array.from({ length: 15 }, (_, index) => client.get(`/item/${index}`)));

    expect(DEFAULT_READS_PER_SECOND).toBe(7);
    expect(starts).toHaveLength(15);
    expect(rollingPeak(starts)).toBeLessThanOrEqual(7);
    // Só a admissão é serial: os 7 de uma janela saem juntos, sem esperar a resposta um do outro.
    expect(peakInFlight).toBeGreaterThan(1);
  }, 15_000);

  it("escrita não entra no teto de leitura", async () => {
    const starts: number[] = [];
    const client = createCangeClient({
      baseUrl: "https://api.teste.local",
      appOrigin: "https://app.teste.local",
      accessToken: "token",
      fetchFn: (async () => {
        starts.push(Date.now());
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });

    const begin = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => client.post("/item", { body: {} })));

    expect(starts).toHaveLength(10);
    expect(Date.now() - begin).toBeLessThan(900);
  });
});
