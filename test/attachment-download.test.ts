import { describe, expect, it } from "vitest";

import { downloadAttachmentsByCardParamsSchema } from "../src/schemas/attachments.js";

describe("attachment download — schema", () => {
  it("aceita ids como número ou string (idLike) + withBase64 opcional", () => {
    expect(downloadAttachmentsByCardParamsSchema.safeParse({ flowId: 21760, cardId: 1120665 }).success).toBe(true);
    expect(downloadAttachmentsByCardParamsSchema.safeParse({ flowId: "21760", cardId: "1120665" }).success).toBe(true);
    expect(
      downloadAttachmentsByCardParamsSchema.safeParse({ flowId: 1, cardId: 2, withBase64: true }).success
    ).toBe(true);
  });

  it("rejeita quando falta flowId ou cardId", () => {
    expect(downloadAttachmentsByCardParamsSchema.safeParse({ cardId: 1 }).success).toBe(false);
    expect(downloadAttachmentsByCardParamsSchema.safeParse({ flowId: 1 }).success).toBe(false);
    expect(downloadAttachmentsByCardParamsSchema.safeParse({}).success).toBe(false);
  });

  it("rejeita withBase64 não-booleano", () => {
    expect(
      downloadAttachmentsByCardParamsSchema.safeParse({ flowId: 1, cardId: 2, withBase64: "sim" }).success
    ).toBe(false);
  });
});
