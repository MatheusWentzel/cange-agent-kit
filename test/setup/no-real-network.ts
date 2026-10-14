import { afterEach } from "vitest";

/**
 * Nenhum teste fala com a rede de verdade (o padrão do kit é api.cange.me, produção).
 * O fetch "real" deste processo vira um bloqueio: quem precisa de HTTP mocka com
 * `vi.spyOn(globalThis, "fetch")` ou injeta `fetchFn` no cliente. Chamada que
 * escapa do mock falha o teste, com a URL na mensagem.
 */
const escaped: string[] = [];

/**
 * K-03: todo GET do cliente passa pelo teto de leitura do processo (7 por segundo, relógio real).
 * Com o fetch mockado, as dezenas de GETs de um arquivo de teste esperariam o relógio (e os testes
 * com relógio falso travariam): aqui o teto sobe. O teste do teto (`k03-teto-leitura`) tira a
 * variável e confere o padrão de 7.
 */
process.env.CANGE_READS_PER_SECOND ??= "1000";

globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const call = `${(init?.method ?? "GET").toUpperCase()} ${String(input)}`;
  escaped.push(call);
  throw new Error(`Rede real bloqueada nos testes: ${call}. Mocke o fetch.`);
}) as typeof fetch;

afterEach(() => {
  if (escaped.length === 0) return;
  const calls = escaped.splice(0);
  throw new Error(`O teste chamou a rede real (sem mock): ${calls.join(", ")}`);
});
