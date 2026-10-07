/**
 * REG-F1 (07/10/2026): os GETs deste processo, para quem precisa caber no teto de leitura do back.
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
 * Um registro por processo: o teto é por chave, e o processo do kit fala com uma chave só.
 */

interface ReadMark {
  start: number;
  /** Fim (resposta ou erro); sem ele, o GET está em voo. */
  end?: number;
}

/** Quanto do histórico guardar depois do fim (folga sobre a janela de 1 s do back). */
const KEEP_MS = 5_000;
/** GET em voo há mais que isto (o timeout do cliente é 15 s) não segura mais a janela. */
const STALE_IN_FLIGHT_MS = 60_000;

const marks: ReadMark[] = [];

/** Anota o início de um GET; devolve quem anota o fim (o cliente HTTP chama ao receber a resposta ou o erro). */
export function noteRead(at: number = Date.now()): (endAt?: number) => void {
  const mark: ReadMark = { start: at };
  marks.push(mark);
  prune(at);
  return (endAt: number = Date.now()) => {
    mark.end = Math.max(endAt, mark.start);
  };
}

/**
 * Até quando cada GET ainda pode cair na mesma janela de `windowMs` que uma leitura que comece em
 * `at`: o fim mais a janela, ou `Infinity` se está em voo. Só os que ainda seguram a janela, em ordem.
 */
export function readsHoldingWindow(windowMs: number, at: number = Date.now()): number[] {
  prune(at);
  return marks
    .filter((mark) => mark.start <= at)
    .map((mark) => (mark.end === undefined ? (mark.start > at - STALE_IN_FLIGHT_MS ? Infinity : 0) : mark.end + windowMs))
    .filter((until) => until > at)
    .sort((a, b) => a - b);
}

/** Zera o histórico (teste). */
export function resetReadWindow(): void {
  marks.length = 0;
}

function prune(at: number): void {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]!;
    const done = mark.end !== undefined ? mark.end <= at - KEEP_MS : mark.start <= at - STALE_IN_FLIGHT_MS;
    if (done) marks.splice(index, 1);
  }
}
