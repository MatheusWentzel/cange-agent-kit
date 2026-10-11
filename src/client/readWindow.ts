/**
 * REG-F1 (07/10/2026): os GETs de cada credencial, para quem precisa caber no teto de leitura do back.
 *
 * O teto do back (`apiRateLimiter`: 10 GET por segundo por chave, numa janela fixa que começa na
 * primeira leitura que CHEGA; a 11ª bloqueia a chave por 5 minutos) conta todas as leituras, e o mover
 * já faz várias antes de conferir o que a tela resolve. O cliente HTTP anota aqui cada tentativa de GET
 * (o retry também conta): o início e o fim (a resposta ou o erro). Quem precisa caber no teto consulta
 * antes de ler (`createReadWindowPacer`), em vez de supor um ritmo fixo que não sabe o que veio antes.
 *
 * O back conta a leitura quando ela chega, em algum instante entre o início e o fim do GET, e a
 * primeira conexão demora mais para chegar que as seguintes. Contando pelo início, a janela do back
 * chegou a 10 no cartão 921055 (os 3 GETs paralelos do começo chegaram depois de sair do kit, e 2
 * leituras que saíram 1 s depois do início deles caíram na mesma janela). Por isso um GET só deixa de
 * contar `windowMs` depois do FIM dele, e o que está em voo conta sempre: duas leituras que o back pode
 * pôr na mesma janela nunca escapam da conta.
 *
 * N-1 (2ª rodada do code review do Alex, 10/10/2026): um registro POR CREDENCIAL, não por processo.
 * O teto do back é por chave, e o MCP remoto monta um kit por requisição, com a credencial de cada
 * usuário, todos no mesmo processo: com um registro só, todos os usuários dividiriam as 7 leituras
 * por segundo. A credencial entra no registro como hash (`credentialKey`), nunca o token cru. O
 * mesmo token em vários clientes (o CLI, ou o kit que o MCP monta a cada requisição do mesmo usuário)
 * cai no mesmo registro, como no back. Registro parado (sem GET em voo nem no histórico) sai do mapa.
 */
import { createHash } from "node:crypto";

interface ReadMark {
  start: number;
  /** Fim (resposta ou erro); sem ele, o GET está em voo. */
  end?: number;
}

/** Quanto do histórico guardar depois do fim (folga sobre a janela de 1 s do back). */
const KEEP_MS = 5_000;
/** GET em voo há mais que isto (o timeout do cliente é 15 s) não segura mais a janela. */
const STALE_IN_FLIGHT_MS = 60_000;
/** De quanto em quanto tempo os registros parados de outras credenciais saem do mapa. */
const SWEEP_EVERY_MS = 10_000;

/** Os GETs de uma credencial. */
export interface ReadWindow {
  /** Anota o início de um GET; devolve quem anota o fim (o cliente HTTP chama ao receber a resposta ou o erro). */
  noteRead(at?: number): (endAt?: number) => void;
  /**
   * Até quando cada GET ainda pode cair na mesma janela de `windowMs` que uma leitura que comece em
   * `at`: o fim mais a janela, ou `Infinity` se está em voo. Só os que ainda seguram a janela, em ordem.
   */
  readsHoldingWindow(windowMs: number, at?: number): number[];
  /** Alguém espera vaga para ler com esta credencial: o registro não sai do mapa até `release`. */
  hold(): () => void;
  /** Sem GET em voo, nem no histórico, nem esperando vaga. */
  isIdle(at?: number): boolean;
  /** Zera o histórico (teste). */
  reset(): void;
}

export function createReadWindow(): ReadWindow {
  const marks: ReadMark[] = [];
  let holders = 0;

  function prune(at: number): void {
    for (let index = marks.length - 1; index >= 0; index -= 1) {
      const mark = marks[index]!;
      const done = mark.end !== undefined ? mark.end <= at - KEEP_MS : mark.start <= at - STALE_IN_FLIGHT_MS;
      if (done) marks.splice(index, 1);
    }
  }

  return {
    noteRead(at: number = Date.now()) {
      const mark: ReadMark = { start: at };
      marks.push(mark);
      prune(at);
      return (endAt: number = Date.now()) => {
        mark.end = Math.max(endAt, mark.start);
      };
    },
    readsHoldingWindow(windowMs: number, at: number = Date.now()) {
      prune(at);
      return marks
        .filter((mark) => mark.start <= at)
        .map((mark) => (mark.end === undefined ? (mark.start > at - STALE_IN_FLIGHT_MS ? Infinity : 0) : mark.end + windowMs))
        .filter((until) => until > at)
        .sort((a, b) => a - b);
    },
    hold() {
      holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
      };
    },
    isIdle(at: number = Date.now()) {
      prune(at);
      return holders === 0 && marks.length === 0;
    },
    reset() {
      marks.length = 0;
      holders = 0;
    }
  };
}

/** Sem credencial (antes do login, `skipAuth`) e as funções soltas abaixo: nunca sai do mapa. */
const anonymousWindow = createReadWindow();
const windows = new Map<string, ReadWindow>();
let lastSweepAt = 0;

/** Chave do registro: hash curto do token (o token cru não fica em memória de diagnóstico nem em log). */
export function credentialKey(accessToken: string | undefined): string | undefined {
  if (!accessToken) return undefined;
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
}

/** O registro de leituras da credencial (`undefined` = sem credencial). */
export function readWindowFor(accessToken: string | undefined): ReadWindow {
  const key = credentialKey(accessToken);
  if (key === undefined) return anonymousWindow;
  sweepIdle(Date.now());
  let window = windows.get(key);
  if (!window) {
    window = createReadWindow();
    windows.set(key, window);
  }
  return window;
}

/** Quantas credenciais têm registro agora (teste). */
export function readWindowCount(): number {
  return windows.size;
}

function sweepIdle(at: number): void {
  if (at - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = at;
  for (const [key, window] of windows) {
    if (window.isIdle(at)) windows.delete(key);
  }
}

/** Anota um GET sem credencial (o registro anônimo). */
export function noteRead(at: number = Date.now()): (endAt?: number) => void {
  return anonymousWindow.noteRead(at);
}

/** `readsHoldingWindow` do registro anônimo (o default do `createReadWindowPacer`). */
export function readsHoldingWindow(windowMs: number, at: number = Date.now()): number[] {
  return anonymousWindow.readsHoldingWindow(windowMs, at);
}

/** Zera todos os registros (teste). */
export function resetReadWindow(): void {
  anonymousWindow.reset();
  windows.clear();
  lastSweepAt = 0;
}
