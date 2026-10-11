import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const message = { id: "owner-msg", role: "owner", contentType: "text",
    threadId: "a1989b23-e2b8-412e-a08f-46fb2726eedc", text: "are there any issues, staff issues right now",
    clientMessageId: "5106fd7b-1d80-486c-a026-dc1f39911f4c" };
  return {
    message,
    planner: vi.fn(),
    summary: vi.fn(),
    team: vi.fn(),
    persist: vi.fn(),
    getExisting: vi.fn(),
    getThread: vi.fn(async () => ({ title: "Staff checks" })),
    addOwner: vi.fn(async () => message),
    listMessages: vi.fn(),
  };
});
vi.mock("next-intl/server", () => ({ getTranslations: async () =>
  (key: string, params?: Record<string, string | number>) => {
    if (key === "staffIssuesSummary") return `${params?.needs} need attention, ${params?.watching} watched; Team tasks only.`;
    return key;
  },
}));
vi.mock("@/lib/ai/conversations/enabled.server", () => ({ isSupervisorChatConfigured: () => true }));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
  authenticatedConversationContext: async () => ({
    scope: { businessId: "cafe-1", ownerUserId: "owner-1" },
    service: { getThread: mocks.getThread, addOwnerMessage: mocks.addOwner,
      listMessages: mocks.listMessages },
  }),
}));
vi.mock("@/lib/ai/cafeTools.server", () => ({ createAuthenticatedCafeTools: async () => ({
  getCafeSummary: mocks.summary, getTeamTasks: mocks.team,
}) }));
vi.mock("@/lib/ai/conversations/planner.server", () => ({
  planSupervisorQuestion: mocks.planner,
}));
vi.mock("@/lib/ai/conversations/usage.server", () => ({
  labelSupervisorThread: async () => {}, recordSupervisorUsage: async () => {},
}));
vi.mock("@/lib/ai/policies/auth.server", () => ({
  authenticatedTeamRulesService: async () => ({ listActiveRules: async () => [] }),
}));
vi.mock("@/lib/ai/conversations/replyWriter.server", () => ({
  getExistingSupervisorReply: mocks.getExisting,
  persistGroundedSupervisorReply: mocks.persist,
}));
import { POST } from "./route";

const quality = { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] };
function request(text: string) {
  return new Request("https://cafe.test/api/ai/threads/" + mocks.message.threadId + "/messages", {
    method: "POST", headers: { origin: "https://cafe.test", "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId: mocks.message.clientMessageId, text, locale: "en" }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExisting.mockResolvedValue(null);
  mocks.team.mockResolvedValue({ available: true, value: [], quality });
  mocks.summary.mockRejectedValue(new Error("General snapshot unavailable"));
  mocks.planner.mockRejectedValue(new Error("AI provider unavailable"));
  mocks.persist.mockImplementation(async (_scope, _message, reply) => ({
    ...mocks.message, id: "reply-1", role: "supervisor", blocks: reply.blocks,
    grounding: { ownerMessageId: mocks.message.id },
  }));
});
describe("POST staff status in mobile or desktop chat", () => {
  it("answers staff issues without OpenAI or a failing general café snapshot", async () => {
    const response = await POST(request(mocks.message.text), {
      params: Promise.resolve({ threadId: mocks.message.threadId }),
    });
    expect(response.status).toBe(201);
    expect(mocks.team).toHaveBeenCalledTimes(1);
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.planner).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.replyStatus).toBe("complete");
    expect(body.reply.blocks[0].text).toBe("staffIssuesNone");
  });
  it("returns existing reply on retry without duplicate reads or writes", async () => {
    mocks.getExisting.mockResolvedValue({ id: "existing-reply" });
    const response = await POST(request(mocks.message.text), {
      params: Promise.resolve({ threadId: mocks.message.threadId }),
    });
    expect(response.status).toBe(200);
    expect(mocks.team).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
