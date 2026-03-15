import { z } from "zod";

import type { CangeAuthSource, CangeResolvedConfig } from "./config.js";
import { CangeAuthError } from "./errors.js";
import type { CangeClient } from "./http.js";

const loginSchema = z.object({
  email: z.string().email(),
  apikey: z.string().min(1)
});

export interface LoginWithApiKeyInput {
  email: string;
  apikey: string;
}

export interface AuthResult {
  token: string;
  source: CangeAuthSource;
  raw?: unknown;
}

export async function loginWithApiKey(
  client: CangeClient,
  input: LoginWithApiKeyInput
): Promise<AuthResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    throw new CangeAuthError("Parâmetros inválidos para autenticação por /session.", {
      details: parsed.error.format()
    });
  }

  const raw = await client.post<unknown>("/session", {
    body: {
      email: parsed.data.email,
      apikey: parsed.data.apikey
    },
    skipAuth: true,
    retry: false
  });

  const token = extractToken(raw);
  if (!token) {
    throw new CangeAuthError("A API retornou sucesso, mas nenhum token foi encontrado em /session.", {
      endpoint: "/session",
      method: "POST",
      details: raw
    });
  }

  client.setAccessToken(token);
  return {
    token,
    source: "session-login",
    raw
  };
}

export async function authenticate(client: CangeClient, config: CangeResolvedConfig): Promise<AuthResult> {
  if (config.accessToken) {
    client.setAccessToken(config.accessToken);
    return {
      token: config.accessToken,
      source: "access-token-env"
    };
  }

  if (config.email && config.apikey) {
    return loginWithApiKey(client, {
      email: config.email,
      apikey: config.apikey
    });
  }

  throw new CangeAuthError(
    "Não foi possível autenticar. Defina CANGE_ACCESS_TOKEN ou CANGE_EMAIL e CANGE_APIKEY."
  );
}

function extractToken(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const token = findToken(raw as Record<string, unknown>, 0);
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return undefined;
}

function findToken(value: Record<string, unknown>, depth: number): unknown {
  if (depth > 4) {
    return undefined;
  }

  const directCandidates = [
    value.token,
    value.access_token,
    value.accessToken,
    value.jwt,
    value.bearer
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nestedToken = findToken(child as Record<string, unknown>, depth + 1);
      if (nestedToken) {
        return nestedToken;
      }
    }
  }

  return undefined;
}
