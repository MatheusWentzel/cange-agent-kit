import { authenticate } from "./client/auth.js";
import {
  type CangeConfigOverrides,
  type CangeResolvedConfig,
  assertHasAuthInput,
  resolveConfigFromEnv
} from "./client/config.js";
import {
  CangeApiError,
  CangeAuthError,
  CangeCliUsageError,
  CangeError,
  CangeValidationError
} from "./client/errors.js";
import { createCangeClient, type CangeClient, type CangeClientConfig } from "./client/http.js";
import { createContracts, type CangeContracts } from "./contracts/index.js";
import { loadEnv } from "./utils/env.js";

export interface CreateCangeAgentKitOptions {
  envPath?: string;
  skipEnvLoad?: boolean;
  configOverrides?: CangeConfigOverrides;
  clientOverrides?: Pick<CangeClientConfig, "fetchFn" | "logger" | "timeoutMs" | "maxRetries" | "retryDelayMs">;
}

export interface CangeAgentKit {
  config: CangeResolvedConfig;
  client: CangeClient;
  contracts: CangeContracts;
}

export function createCangeAgentKit(options: CreateCangeAgentKitOptions = {}): CangeAgentKit {
  if (!options.skipEnvLoad) {
    loadEnv(options.envPath);
  }

  const config = resolveConfigFromEnv(process.env, options.configOverrides);
  const client = createCangeClient({
    baseUrl: config.baseUrl,
    appOrigin: config.appOrigin,
    accessToken: config.accessToken,
    timeoutMs: options.clientOverrides?.timeoutMs ?? config.timeoutMs,
    maxRetries: options.clientOverrides?.maxRetries ?? config.maxRetries,
    retryDelayMs: options.clientOverrides?.retryDelayMs ?? config.retryDelayMs,
    fetchFn: options.clientOverrides?.fetchFn,
    logger: options.clientOverrides?.logger
  });

  const contracts = createContracts({
    client,
    config
  });

  return {
    config,
    client,
    contracts
  };
}

export async function authenticateKit(kit: CangeAgentKit): Promise<{
  token: string;
  source: "access-token-env" | "session-login";
  raw?: unknown;
}> {
  assertHasAuthInput(kit.config);
  return authenticate(kit.client, kit.config);
}

export {
  CangeError,
  CangeApiError,
  CangeAuthError,
  CangeValidationError,
  CangeCliUsageError,
  assertHasAuthInput,
  resolveConfigFromEnv,
  createCangeClient
};

export type { CangeClient, CangeClientConfig, CangeResolvedConfig, CangeContracts };
