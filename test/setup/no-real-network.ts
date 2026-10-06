import { afterEach } from "vitest";

/**
 * Nenhum teste fala com a rede de verdade (o padrão do kit é api.cange.me, produção).
 * O fetch "real" deste processo vira um bloqueio: quem precisa de HTTP mocka com
 * `vi.spyOn(globalThis, "fetch")` ou injeta `fetchFn` no cliente. Chamada que
 * escapa do mock falha o teste, com a URL na mensagem.
 */
const escaped: string[] = [];

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
