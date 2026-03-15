import { describe, expect, it, vi } from "vitest";

import { createCardsContracts } from "../src/contracts/cards.js";
import { createNotificationsContracts } from "../src/contracts/notifications.js";
import { createRegistersContracts } from "../src/contracts/registers.js";
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

describe("contracts endpoint mapping", () => {
  it("maps card and register payloads to API shape", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({});
    vi.mocked(client.put).mockResolvedValue({});

    const cards = createCardsContracts(client);
    const notifications = createNotificationsContracts(client);
    const registers = createRegistersContracts(client);

    await cards.createCard({
      idForm: 662,
      flowId: 192,
      origin: "/cange-agent-kit",
      values: { customer_name: "ACME" }
    });

    await cards.moveCardStep({
      flowId: 192,
      cardId: 7,
      fromStepId: 11,
      toStepId: 12,
      complete: "N",
      isFromCurrentStep: true,
      isTestMode: false
    });

    await cards.moveCardStepWithValues({
      flowId: 192,
      cardId: 7,
      fromStepId: 12,
      toStepId: 13,
      idForm: 662,
      values: { customer_name: "ACME 3" },
      complete: "S",
      isFromCurrentStep: true,
      isTestMode: false
    });

    await cards.updateCardValues({
      idForm: 662,
      flowId: 192,
      cardId: 7,
      values: { customer_name: "ACME 2" }
    });

    await notifications.readNotification({
      notificationId: 48107,
      archived: "S"
    });

    await registers.updateRegister({
      idForm: 700,
      registerId: 90,
      values: { doc_name: "Contrato" }
    });

    expect(client.post).toHaveBeenNthCalledWith(1, "/form/new-answer", {
      body: {
        id_form: 662,
        origin: "/cange-agent-kit",
        values: { customer_name: "ACME" },
        flow_id: 192
      }
    });

    expect(client.post).toHaveBeenNthCalledWith(2, "/card/v2/move-step", {
      body: {
        flow_id: 192,
        id_card: 7,
        from_step_id: 11,
        to_step_id: 12,
        complete: "N",
        isFromCurrentStep: true,
        isTestMode: false
      }
    });

    expect(client.post).toHaveBeenNthCalledWith(3, "/card/v2/move-step", {
      body: {
        flow_id: 192,
        id_card: 7,
        from_step_id: 12,
        to_step_id: 13,
        id_form: 662,
        values: { customer_name: "ACME 3" },
        complete: "S",
        isFromCurrentStep: true,
        isTestMode: false
      }
    });

    expect(client.post).toHaveBeenNthCalledWith(4, "/notification", {
      body: {
        id_notification: 48107,
        archived: "S"
      }
    });

    expect(client.put).toHaveBeenNthCalledWith(1, "/form/answer", {
      body: {
        id_form: 662,
        flow_id: 192,
        card_id: 7,
        values: { customer_name: "ACME 2" }
      }
    });

    expect(client.put).toHaveBeenNthCalledWith(2, "/form/answer", {
      body: {
        id_form: 700,
        register_id: 90,
        form_answer_id: undefined,
        values: { doc_name: "Contrato" }
      }
    });
  });
});
