import { describe, expect, it, vi } from "vitest";

import { createDiscoveryContracts } from "../src/contracts/discovery.js";
import type { CangeResolvedConfig } from "../src/client/config.js";
import type { CangeClient } from "../src/client/http.js";

const config: CangeResolvedConfig = {
  baseUrl: "https://api.cange.me",
  appOrigin: "https://app.cange.me",
  output: "pretty",
  timeoutMs: 1000,
  maxRetries: 0,
  retryDelayMs: 0
};

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

describe("discovery contracts", () => {
  it("summarizes flows and registers", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        data: [
          { id: 1, hash: "f1", title: "Flow 1", form_init_id: 662 }
        ]
      })
      .mockResolvedValueOnce({
        items: [
          { id_register: 9, hash: "r1", name: "Register 1", form_id: 700 }
        ]
      });

    const discovery = createDiscoveryContracts({
      client,
      config
    });

    const flows = await discovery.getMyFlows();
    const registers = await discovery.getMyRegisters();

    expect(flows.summaries[0]).toMatchObject({
      id: 1,
      hash: "f1",
      title: "Flow 1",
      formInitId: 662
    });
    expect(registers.summaries[0]).toMatchObject({
      id: 9,
      hash: "r1",
      title: "Register 1",
      formId: 700
    });
  });
});
