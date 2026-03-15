import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createAttachmentsContracts } from "../src/contracts/attachments.js";
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

describe("attachments contracts", () => {
  it("uploads and links attachment with correct endpoints", async () => {
    const client = createMockClient();
    vi.mocked(client.post)
      .mockResolvedValueOnce({ id_attachment: 10 })
      .mockResolvedValueOnce({ linked: true });

    const contracts = createAttachmentsContracts(client);

    const filePath = join(tmpdir(), `cange-agent-kit-test-${Date.now()}.txt`);
    await writeFile(filePath, "test-content", "utf8");

    try {
      await contracts.uploadAttachment({ filePath });
      await contracts.linkAttachmentToCard({
        attachmentId: 10,
        cardId: 55,
        flowId: 99
      });
    } finally {
      await unlink(filePath);
    }

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/attachment",
      expect.objectContaining({
        contentType: "multipart"
      })
    );
    expect(client.post).toHaveBeenNthCalledWith(2, "/attachment/card", {
      body: {
        attachment_id: 10,
        card_id: 55,
        flow_id: 99
      }
    });
  });
});
