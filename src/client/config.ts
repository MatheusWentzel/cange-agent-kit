import { z } from "zod";

import { CangeAuthError } from "./errors.js";

export const outputModeSchema = z.enum(["json", "pretty"]);

export interface CangeResolvedConfig {
  baseUrl: string;
  appOrigin: string;
  email?: string;
  apikey?: string;
  accessToken?: string;
  output: z.infer<typeof outputModeSchema>;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface CangeConfigOverrides {
  baseUrl?: string;
  appOrigin?: string;
  email?: string;
  apikey?: string;
  accessToken?: string;
  output?: z.infer<typeof outputModeSchema>;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_BASE_URL = "https://api.cange.me";
const DEFAULT_APP_ORIGIN = "https://app.cange.me";
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY = 300;

export function resolveConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CangeConfigOverrides = {}
): CangeResolvedConfig {
  const outputCandidate = overrides.output ?? env.CANGE_OUTPUT ?? "pretty";
  const outputResult = outputModeSchema.safeParse(outputCandidate);
  const output = outputResult.success ? outputResult.data : "pretty";

  return {
    baseUrl: normalizeUrl(overrides.baseUrl ?? env.CANGE_API_BASE_URL ?? DEFAULT_BASE_URL),
    appOrigin: normalizeUrl(overrides.appOrigin ?? env.CANGE_APP_ORIGIN ?? DEFAULT_APP_ORIGIN),
    email: normalizeOptionalString(overrides.email ?? env.CANGE_EMAIL),
    apikey: normalizeOptionalString(overrides.apikey ?? env.CANGE_APIKEY),
    accessToken: normalizeOptionalString(overrides.accessToken ?? env.CANGE_ACCESS_TOKEN),
    output,
    timeoutMs: normalizeInteger(overrides.timeoutMs, DEFAULT_TIMEOUT),
    maxRetries: normalizeInteger(overrides.maxRetries, DEFAULT_RETRIES),
    retryDelayMs: normalizeInteger(overrides.retryDelayMs, DEFAULT_RETRY_DELAY)
  };
}

export type CangeAuthSource = "access-token-env" | "session-login";

export function assertHasAuthInput(config: CangeResolvedConfig): void {
  if (config.accessToken) {
    return;
  }

  if (config.email && config.apikey) {
    return;
  }

  throw new CangeAuthError(
    "Credenciais ausentes. Defina CANGE_ACCESS_TOKEN ou CANGE_EMAIL + CANGE_APIKEY."
  );
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeInteger(candidate: number | undefined, fallback: number): number {
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
    return Math.trunc(candidate);
  }
  return fallback;
}
