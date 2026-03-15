import { describe, expect, it } from "vitest";

import { CangeCliUsageError } from "../src/client/errors.js";
import { readPayloadFile } from "../src/cli/helpers.js";

describe("payload file helper", () => {
  it("rejects inline json in --payload", async () => {
    await expect(readPayloadFile('{"flowId":19263}')).rejects.toBeInstanceOf(CangeCliUsageError);
    await expect(readPayloadFile('{"flowId":19263}')).rejects.toMatchObject({
      message: expect.stringContaining("caminho de arquivo JSON")
    });
  });
});
