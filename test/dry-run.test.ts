import { describe, expect, it } from "vitest";

import { createDryRunResult } from "../src/utils/dryRun.js";

describe("dry-run", () => {
  it("returns non-executed mutation payload", () => {
    const result = createDryRunResult({ flowId: 192, cardId: 7 });
    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.payload).toEqual({ flowId: 192, cardId: 7 });
  });
});
