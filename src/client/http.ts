import { CangeApiError, type CangeHttpMethod, sanitizeSensitive } from "./errors.js";

export interface CangeClientConfig {
  baseUrl: string;
  appOrigin: string;
  accessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchFn?: typeof globalThis.fetch;
  logger?: (message: string, context?: unknown) => void;
}

export interface CangeRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: boolean;
  skipAuth?: boolean;
  contentType?: "json" | "multipart" | "none";
}

export interface CangeClient {
  get<T>(path: string, options?: Omit<CangeRequestOptions, "body">): Promise<T>;
  post<T>(path: string, options?: CangeRequestOptions): Promise<T>;
  put<T>(path: string, options?: CangeRequestOptions): Promise<T>;
  patch<T>(path: string, options?: CangeRequestOptions): Promise<T>;
  delete<T>(path: string, options?: CangeRequestOptions): Promise<T>;
  request<T>(method: CangeHttpMethod, path: string, options?: CangeRequestOptions): Promise<T>;
  setAccessToken(token: string): void;
  clearAccessToken(): void;
  getAccessToken(): string | undefined;
}

export function createCangeClient(config: CangeClientConfig): CangeClient {
  let accessToken = config.accessToken;
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const maxRetries = config.maxRetries ?? 2;
  const retryDelayMs = config.retryDelayMs ?? 300;

  async function request<T>(
    method: CangeHttpMethod,
    path: string,
    options: CangeRequestOptions = {}
  ): Promise<T> {
    const url = buildUrl(config.baseUrl, path, options.query);
    const finalHeaders = new Headers(options.headers);
    finalHeaders.set("Origin", config.appOrigin);

    if (!options.skipAuth && accessToken) {
      finalHeaders.set("Authorization", `Bearer ${accessToken}`);
    }

    const bodyInit = buildBody(method, options, finalHeaders);
    const canRetry = options.retry ?? isRetryMethod(method);
    const effectiveTimeout = options.timeoutMs ?? timeoutMs;

    for (let attempt = 0; ; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), effectiveTimeout);

      try {
        logDebug(config.logger, "HTTP request", {
          method,
          url,
          attempt,
          headers: redactHeadersForLog(finalHeaders),
          hasBody: bodyInit !== undefined
        });

        const response = await fetchFn(url, {
          method,
          headers: finalHeaders,
          body: bodyInit,
          signal: abortController.signal
        });

        const parsedBody = await parseResponseBody(response);
        if (!response.ok) {
          const shouldRetry = canRetry && attempt < maxRetries && isRetryStatus(response.status);
          if (shouldRetry) {
            await sleep(backoffDelay(attempt, retryDelayMs));
            continue;
          }

          throw buildApiError({
            method,
            path,
            status: response.status,
            body: parsedBody
          });
        }

        return parsedBody as T;
      } catch (error) {
        if (error instanceof CangeApiError) {
          throw error;
        }

        const shouldRetry = canRetry && attempt < maxRetries;
        if (shouldRetry) {
          await sleep(backoffDelay(attempt, retryDelayMs));
          continue;
        }

        throw new CangeApiError("Falha de comunicação com a API do Cange.", {
          method,
          endpoint: path,
          cause: error
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return {
    get: <T>(path: string, options?: Omit<CangeRequestOptions, "body">) =>
      request<T>("GET", path, options),
    post: <T>(path: string, options?: CangeRequestOptions) => request<T>("POST", path, options),
    put: <T>(path: string, options?: CangeRequestOptions) => request<T>("PUT", path, options),
    patch: <T>(path: string, options?: CangeRequestOptions) => request<T>("PATCH", path, options),
    delete: <T>(path: string, options?: CangeRequestOptions) =>
      request<T>("DELETE", path, options),
    request,
    setAccessToken(token: string) {
      accessToken = token;
    },
    clearAccessToken() {
      accessToken = undefined;
    },
    getAccessToken() {
      return accessToken;
    }
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: CangeRequestOptions["query"]
): string {
  const url = new URL(path, ensureTrailingSlash(baseUrl));

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildBody(
  method: CangeHttpMethod,
  options: CangeRequestOptions,
  headers: Headers
): BodyInit | undefined {
  if (method === "GET" || method === "DELETE") {
    return undefined;
  }

  if (options.body === undefined) {
    return undefined;
  }

  if (options.contentType === "multipart") {
    return options.body as BodyInit;
  }

  if (options.contentType === "none") {
    return options.body as BodyInit;
  }

  headers.set("Content-Type", "application/json");
  return JSON.stringify(options.body);
}

function isRetryMethod(method: CangeHttpMethod): boolean {
  return method === "GET";
}

function isRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.max(1, attempt + 1);
}

async function parseResponseBody(response: globalThis.Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isJson = contentType.includes("application/json");

  if (isJson) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  const text = await response.text();
  return text.length > 0 ? text : undefined;
}

interface BuildApiErrorInput {
  method: CangeHttpMethod;
  path: string;
  status: number;
  body: unknown;
}

function buildApiError(input: BuildApiErrorInput): CangeApiError {
  const message = extractErrorMessage(input.body) ?? defaultStatusMessage(input.status);
  return new CangeApiError(message, {
    status: input.status,
    method: input.method,
    endpoint: input.path,
    details: sanitizeSensitive(input.body)
  });
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim();
  }

  if (!body || typeof body !== "object") {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const candidates = [record.message, record.error, record.err];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function defaultStatusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "Não autorizado na API do Cange. Revise o token ou credenciais.";
  }
  if (status === 404) {
    return "Recurso não encontrado na API do Cange.";
  }
  if (status === 429) {
    return "Limite de requisições atingido na API do Cange.";
  }
  if (status >= 500) {
    return "Erro interno na API do Cange.";
  }
  return "Falha ao processar requisição na API do Cange.";
}

function logDebug(
  logger: CangeClientConfig["logger"],
  message: string,
  context?: unknown
): void {
  if (!logger) {
    return;
  }
  logger(message, sanitizeSensitive(context));
}

function redactHeadersForLog(headers: Headers): Record<string, string> {
  const authorization = headers.get("authorization");
  return {
    origin: headers.get("origin") ?? "",
    contentType: headers.get("content-type") ?? "",
    authorization: authorization ? "[REDACTED]" : ""
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
