export type CangeHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CangeErrorContext {
  status?: number;
  endpoint?: string;
  method?: CangeHttpMethod;
  details?: unknown;
  cause?: unknown;
  code?: string;
}

interface CangeErrorSerialized {
  name: string;
  message: string;
  status?: number;
  endpoint?: string;
  method?: CangeHttpMethod;
  code?: string;
  details?: unknown;
}

export class CangeError extends Error {
  public readonly status?: number;
  public readonly endpoint?: string;
  public readonly method?: CangeHttpMethod;
  public readonly details?: unknown;
  public readonly code?: string;

  public constructor(message: string, context: CangeErrorContext = {}) {
    super(message, context.cause ? { cause: context.cause } : undefined);
    this.name = this.constructor.name;
    this.status = context.status;
    this.endpoint = context.endpoint;
    this.method = context.method;
    this.details = sanitizeSensitive(context.details);
    this.code = context.code;
  }

  public toJSON(): CangeErrorSerialized {
    const out: CangeErrorSerialized = { name: this.name, message: this.message };
    if (this.status !== undefined) out.status = this.status;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.method !== undefined) out.method = this.method;
    if (this.code !== undefined) out.code = this.code;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export class CangeApiError extends CangeError {}
export class CangeAuthError extends CangeError {}
export class CangeValidationError extends CangeError {}
export class CangeCliUsageError extends CangeError {}

const SENSITIVE_KEYS = ["token", "apikey", "authorization", "access_token"];

export function sanitizeSensitive(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

function sanitizeValue(value: unknown, visited: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (visited.has(value as object)) {
    return "[Circular]";
  }
  visited.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, visited));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = maskSecret(item);
      continue;
    }
    output[key] = sanitizeValue(item, visited);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((token) => lower.includes(token));
}

function maskSecret(value: unknown): string {
  if (typeof value !== "string") {
    return "[REDACTED]";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}
