/**
 * Defaults de contexto vindos do AMBIENTE do runner.
 *
 * Em runs de automação o runner injeta o card/flow do disparo no env do agente
 * (`RUNNER_CARD_ID`, `RUNNER_FLOW_ID`, `CANGE_CARD_FLOW_ID`). Os comandos de
 * leitura usam esses valores como default quando a flag é omitida — o modelo
 * não precisa redigitar ids que o ambiente já conhece (cada omissão virava
 * `CangeCliUsageError` e queimava um turno; caso real dos runs 90-97).
 * Precedência: flag explícita > env. Ausentes ambos → erro claro do chamador.
 */
function positiveIntFromEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return String(n);
  }
  return undefined;
}

/** Card do run em execução (RUNNER_CARD_ID → CANGE_CARD_ID). */
export function envCardId(): string | undefined {
  return positiveIntFromEnv("RUNNER_CARD_ID", "CANGE_CARD_ID");
}

/** Flow do card do run (RUNNER_FLOW_ID → CANGE_CARD_FLOW_ID → CANGE_FLOW_ID). */
export function envFlowId(): string | undefined {
  return positiveIntFromEnv("RUNNER_FLOW_ID", "CANGE_CARD_FLOW_ID", "CANGE_FLOW_ID");
}
