import { isFromDotenv } from "../utils/env.js";

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
function positiveIntFromEnv(names: string[], options: { processOnly?: boolean } = {}): string | undefined {
  for (const name of names) {
    if (options.processOnly && isFromDotenv(name)) continue;
    const raw = process.env[name];
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return String(n);
  }
  return undefined;
}

/**
 * Card do run em execução (RUNNER_CARD_ID → CANGE_CARD_ID). `processOnly`: só o
 * ambiente do processo conta, nunca o `.env` do diretório (dono do artefato: o
 * runner tira o cartão do ambiente no chat sem cartão, e um `.env` no workspace
 * do agente não pode recolocá-lo).
 */
export function envCardId(options: { processOnly?: boolean } = {}): string | undefined {
  return positiveIntFromEnv(["RUNNER_CARD_ID", "CANGE_CARD_ID"], options);
}

/** Flow do card do run (RUNNER_FLOW_ID → CANGE_CARD_FLOW_ID → CANGE_FLOW_ID). */
export function envFlowId(): string | undefined {
  return positiveIntFromEnv(["RUNNER_FLOW_ID", "CANGE_CARD_FLOW_ID", "CANGE_FLOW_ID"]);
}

/**
 * Conversa (agent_session) do run de chat (RUNNER_CHAT_SESSION_ID). O runner
 * injeta em todo run de chat, com ou sem cartão em foco. Três consumidores:
 *  - `artifact publish`: só quando não há cartão (flag ou env), artefato de conversa;
 *  - `access request` e `agent head propose`: decidem a situação da continuação do
 *    `--then` (sem a env = "sem conversa", sem promessa; com a env, ainda é preciso o
 *    eco `continuation` do back para dizer "combinada").
 * Mudar a injeção ou o `processOnly` muda as três saídas. Só o ambiente do processo
 * conta (o `.env` do diretório não define a conversa).
 */
export function envChatSessionId(): string | undefined {
  return positiveIntFromEnv(["RUNNER_CHAT_SESSION_ID"], { processOnly: true });
}
