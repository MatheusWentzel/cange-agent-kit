import { describe, expect, it } from "vitest";

import { CangeApiError, sanitizeSensitive } from "../src/client/errors.js";
import { createCangeClient } from "../src/client/http.js";

describe("http errors", () => {
  it("normalizes non-2xx errors", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "invalid token" }), {
        status: 401,
        headers: {
          "content-type": "application/json"
        }
      });

    const client = createCangeClient({
      baseUrl: "https://api.cange.me",
      appOrigin: "https://app.cange.me",
      accessToken: "token",
      fetchFn: fetchMock
    });

    await expect(client.get("/my-flows")).rejects.toBeInstanceOf(CangeApiError);
    await expect(client.get("/my-flows")).rejects.toMatchObject({
      status: 401,
      endpoint: "/my-flows",
      method: "GET",
      message: "invalid token"
    });
  });

  it("masks sensitive fields", () => {
    const sanitized = sanitizeSensitive({
      authorization: "Bearer abcdef12345",
      apikey: "secret-xyz"
    }) as Record<string, unknown>;

    expect(sanitized.authorization).toBe("Bea***45");
    expect(sanitized.apikey).toBe("sec***yz");
  });
});
