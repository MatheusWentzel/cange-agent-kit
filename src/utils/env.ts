import dotenv from "dotenv";

let loaded = false;

/** Variáveis que o `.env` do diretório criou (não existiam no ambiente do processo), com o valor que ele pôs. */
const fromDotenv = new Map<string, string>();

export function loadEnv(path?: string): void {
  if (loaded) {
    return;
  }
  const before = new Set(Object.keys(process.env));
  dotenv.config(path ? { path } : undefined);
  for (const [key, value] of Object.entries(process.env)) {
    if (!before.has(key) && value !== undefined) fromDotenv.set(key, value);
  }
  loaded = true;
}

/**
 * A variável veio do `.env` do diretório, e não do ambiente de quem chamou o kit?
 * O dono do `artifact publish` só vale do ambiente do processo (o runner injeta):
 * um `.env` gravado no workspace do agente não pode escolher o cartão.
 */
export function isFromDotenv(name: string): boolean {
  const value = fromDotenv.get(name);
  return value !== undefined && process.env[name] === value;
}
