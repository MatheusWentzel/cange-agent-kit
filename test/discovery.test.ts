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
  it("summarizes flows, registers, tasks and notifications", async () => {
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
      })
      .mockResolvedValueOnce({
        items: [
          {
            id_card: 400,
            title: "Follow up cliente",
            flow_id: 1,
            company_id: 67,
            flow_step_id: 33,
            user_id: 8805,
            dt_created: "2026-03-15T09:00:00.000Z",
            dt_due: "2026-03-15T10:00:00.000Z",
            complete: "N",
            status_dt_due: 4,
            flow: { id_flow: 1, name: "Tarefas", hash: "flow-hash" },
            flow_step: { id_step: 33, name: "A Fazer" },
            user: { id_user: 8805, name: "Bot - Maggie" }
          }
        ]
      })
      .mockResolvedValueOnce({
        results: [
          {
            id_notification: 12,
            type: "comment_mention",
            dt_created: "2026-03-15T03:07:38.000Z",
            archived: null,
            card_comment_id: 195773,
            card_comment: {
              id_card_comment: 195773,
              card_id: 400,
              description: "@[Bot - Maggie](8805) Heyyyy",
              user: { id_user: 76, name: "Matheus Wentzel" }
            },
            card: {
              id_card: 400,
              title: "Follow up cliente",
              flow_id: 1,
              flow_step_id: 33,
              user_id: 8805,
              user: { id_user: 8805, name: "Bot - Maggie" },
              flow: { id_flow: 1, name: "Tarefas" },
              flow_step: { id_step: 33, name: "A Fazer" }
            }
          }
        ]
      });

    const discovery = createDiscoveryContracts({
      client,
      config
    });

    const flows = await discovery.getMyFlows();
    const registers = await discovery.getMyRegisters();
    const tasks = await discovery.getMyTasks();
    const notifications = await discovery.getNotificationsByUser();

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
    expect(tasks.summaries[0]).toMatchObject({
      cardId: 400,
      title: "Follow up cliente",
      flowId: 1,
      flowName: "Tarefas",
      flowHash: "flow-hash",
      companyId: 67,
      currentStepId: 33,
      stepName: "A Fazer",
      createdAt: "2026-03-15T09:00:00.000Z",
      dueDate: "2026-03-15T10:00:00.000Z",
      responsibleUserId: 8805,
      responsibleName: "Bot - Maggie",
      statusDue: 4,
      complete: false
    });
    expect(notifications.summaries[0]).toMatchObject({
      id: 12,
      type: "comment_mention",
      createdAt: "2026-03-15T03:07:38.000Z",
      cardId: 400,
      cardTitle: "Follow up cliente",
      flowId: 1,
      flowName: "Tarefas",
      currentStepId: 33,
      stepName: "A Fazer",
      responsibleUserId: 8805,
      responsibleName: "Bot - Maggie",
      commentId: 195773,
      commentText: "@[Bot - Maggie](8805) Heyyyy",
      commentAuthorId: 76,
      commentAuthorName: "Matheus Wentzel"
    });

    expect(client.get).toHaveBeenNthCalledWith(1, "/flow/my-flows");
    expect(client.get).toHaveBeenNthCalledWith(2, "/register/my-registers");
    expect(client.get).toHaveBeenNthCalledWith(3, "/card/my-tasks");
    expect(client.get).toHaveBeenNthCalledWith(4, "/notification/by-user", {
      query: { isArchived: "N" }
    });
  });
});
