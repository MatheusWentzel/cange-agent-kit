import { describe, expect, it } from "vitest";

import { resolveConfigFromEnv } from "../src/client/config.js";

describe("resolveConfigFromEnv", () => {
  it("uses token when provided", () => {
    const config = resolveConfigFromEnv({
      CANGE_ACCESS_TOKEN: "abc",
      CANGE_OUTPUT: "json"
    } as NodeJS.ProcessEnv);

    expect(config.accessToken).toBe("abc");
    expect(config.output).toBe("json");
    expect(config.baseUrl).toBe("https://api.cange.me");
  });

  it("keeps email/apikey when token is absent", () => {
    const config = resolveConfigFromEnv({
      CANGE_EMAIL: "ops@example.com",
      CANGE_APIKEY: "secret-key"
    } as NodeJS.ProcessEnv);

    expect(config.accessToken).toBeUndefined();
    expect(config.email).toBe("ops@example.com");
    expect(config.apikey).toBe("secret-key");
  });
});
