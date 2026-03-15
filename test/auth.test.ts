import { describe, expect, it, vi } from "vitest";

import { authenticate, loginWithApiKey } from "../src/client/auth.js";
import type { CangeResolvedConfig } from "../src/client/config.js";
import type { CangeClient } from "../src/client/http.js";

function createMockClient(): CangeClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    getAccessToken: vi.fn()
  };
}

describe("auth", () => {
  it("extracts token from /session response", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      data: {
        access_token: "session-token"
      }
    });

    const result = await loginWithApiKey(client, {
      email: "test@example.com",
      apikey: "key-123"
    });

    expect(result.token).toBe("session-token");
    expect(result.source).toBe("session-login");
    expect(client.setAccessToken).toHaveBeenCalledWith("session-token");
  });

  it("uses env access token first", async () => {
    const client = createMockClient();
    const config: CangeResolvedConfig = {
      baseUrl: "https://api.cange.me",
      appOrigin: "https://app.cange.me",
      accessToken: "env-token",
      output: "pretty",
      timeoutMs: 1000,
      maxRetries: 0,
      retryDelayMs: 0
    };

    const result = await authenticate(client, config);

    expect(result.source).toBe("access-token-env");
    expect(result.token).toBe("env-token");
    expect(client.setAccessToken).toHaveBeenCalledWith("env-token");
    expect(client.post).not.toHaveBeenCalled();
  });
});
