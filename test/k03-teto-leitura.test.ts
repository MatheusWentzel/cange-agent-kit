import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_READS_PER_SECOND, clientReadsHoldingWindow, createCangeClient } from "../src/client/http.js";
import { credentialKey, readWindowCount, readWindowFor, resetReadWindow } from "../src/client/readWindow.js";

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

/** Cliente com fetch que anota o início de cada GET por token e demora `delayMs` para responder. */
function timedClient(token: string, starts: Map<string, number[]>, delayMs = 30) {
  return createCangeClient({
    baseUrl: "https://api.teste.local",
    appOrigin: "https://app.teste.local",
    accessToken: token,
    fetchFn: (async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const list = starts.get(auth) ?? [];
      list.push(Date.now());
      starts.set(auth, list);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });
}

describe("N-1: o teto de leitura é por credencial, não por processo", () => {
  it("dois clientes com tokens diferentes no mesmo processo não dividem o teto", async () => {
    const starts = new Map<string, number[]>();
    const ana = timedClient("token-ana", starts);
    const bruno = timedClient("token-bruno", starts);

    const begin = Date.now();
    await Promise.all([
      ...Array.from({ length: 7 }, (_, index) => ana.get(`/a/${index}`)),
      ...Array.from({ length: 7 }, (_, index) => bruno.get(`/b/${index}`))
    ]);

    const all = [...starts.get("Bearer token-ana")!, ...starts.get("Bearer token-bruno")!];
    expect(all).toHaveLength(14);
    // Com um teto do processo, os 14 levariam mais de 1 s (7 + espera da janela + 7).
    expect(Math.max(...all) - begin).toBeLessThan(500);
    expect(rollingPeak(all)).toBe(14);
  });

  it("o mesmo token em dois clientes (o MCP monta um por requisição) segue com 7 por segundo", async () => {
    const starts = new Map<string, number[]>();
    const first = timedClient("token-ana", starts);
    const second = timedClient("token-ana", starts);

    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => first.get(`/a/${index}`)),
      ...Array.from({ length: 7 }, (_, index) => second.get(`/b/${index}`))
    ]);

    const all = starts.get("Bearer token-ana")!;
    expect(all).toHaveLength(15);
    expect(rollingPeak(all)).toBeLessThanOrEqual(7);
  }, 15_000);

  it("quem pacea leituras próprias (screen-refs) enxerga as do mesmo cliente e não as de outro token", async () => {
    const starts = new Map<string, number[]>();
    const ana = timedClient("token-ana", starts, 0);
    const bruno = timedClient("token-bruno", starts, 0);

    await Promise.all([ana.get("/a/1"), ana.get("/a/2"), bruno.get("/b/1")]);

    const now = Date.now();
    expect(clientReadsHoldingWindow(ana)(1000, now)).toHaveLength(2);
    expect(clientReadsHoldingWindow(bruno)(1000, now)).toHaveLength(1);
  });

  it("o registro guarda o hash da credencial, não o token, e o parado sai do mapa", () => {
    const key = credentialKey("token-secreto")!;
    expect(key).not.toContain("token-secreto");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(credentialKey(undefined)).toBeUndefined();

    let clock = 1_000_000;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      readWindowFor("token-ana").noteRead(clock)(clock + 10);
      expect(readWindowCount()).toBe(1);
      clock += 20_000;
      readWindowFor("token-bruno");
      // O da Ana estava parado (nada em voo nem nos últimos 5 s): saiu.
      expect(readWindowCount()).toBe(1);
      const waiting = readWindowFor("token-bruno").hold();
      clock += 20_000;
      readWindowFor("token-carla");
      // Quem espera vaga segura o registro.
      expect(readWindowCount()).toBe(2);
      waiting();
    } finally {
      Date.now = realNow;
    }
  });
});
