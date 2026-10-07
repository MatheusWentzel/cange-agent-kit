/**
 * `CANGE_FORCE_DRY_RUN=1`: o kit NUNCA grava, seja qual for o argv.
 *
 * Motivo: o gate do runner roda o MESMO comando do agente para conferir a escrita
 * antes de pedir aprovação. Um argv malformado (ex.: `--text --dry-run`, em que o
 * `--dry-run` vira o VALOR do texto) gravaria de verdade na conferência. Com o env:
 *
 *  1. `createCommandAction` liga `dryRun` em todo comando que tem `--dry-run` e
 *     responde dry-run genérico nas escritas que não têm (ver FORCED_WRITE_COMMANDS);
 *  2. o cliente HTTP recusa POST/PUT/PATCH/DELETE fora das leituras via POST
 *     (rede de segurança: escrita nova esquecida na lista falha, não grava).
 */

export const FORCE_DRY_RUN_ENV = "CANGE_FORCE_DRY_RUN";

const OFF_VALUES = new Set(["", "0", "false", "n", "nao", "não", "no", "off"]);

/** Ligado com qualquer valor que não seja vazio/0/false/n/no/off (ex.: `1`, `true`, `sim`). */
export function isForceDryRun(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[FORCE_DRY_RUN_ENV];
  if (raw === undefined) return false;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

export const FORCED_DRY_RUN_NOTE =
  "Mutação não executada: CANGE_FORCE_DRY_RUN está ativo (o kit não grava nada com ele).";

/**
 * Escritas SEM `--dry-run` próprio: com o env, respondem dry-run sem rodar a ação.
 * `tool call` entra porque invoca a API de terceiros configurada no agente.
 */
export const FORCED_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "access request",
  "attachment upload",
  "tool call"
]);

/**
 * Leituras que o back faz por POST (corpo grande ou READ_VIA_POST). `/session` é o
 * login com e-mail e chave (não grava dado do Cange).
 */
const READ_VIA_POST_PATHS: ReadonlySet<string> = new Set([
  "/session",
  "/flow/v2/query",
  "/flow/v2/aggregations",
  "/register/v2/query",
  "/artifact/validate",
  // Autocompletar de vínculo da tela (só lê o cadastro/cartão apontado; R3-F4 do EXTRA-06).
  "/form/answers/by-register"
]);

/** True quando a chamada HTTP grava (com o env ligado ela é recusada). */
export function isWriteRequest(method: string, path: string): boolean {
  if (method.toUpperCase() === "GET") return false;
  const bare = path.split("?")[0]!.replace(/\/+$/, "") || "/";
  return !READ_VIA_POST_PATHS.has(bare);
}
