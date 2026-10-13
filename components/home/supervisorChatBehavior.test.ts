import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { beginOptimisticOwner, sendKey, visibleConversationMessages,
  transcriptScrollTarget } from "./supervisorChatBehavior";

const owner: ConversationMessage = {
  id: "stored-owner", threadId: "thread", role: "owner", contentType: "text",
  text: "Staff costs?", blocks: null, grounding: null, createdAt: "2026-10-11", clientMessageId: "old-key",
};
const answer: ConversationMessage = {
  ...owner, id: "reply", role: "supervisor", clientMessageId: null, text: null,
  contentType: "blocks", blocks: [{ type: "text", text: "Recorded answer" }],
};

describe("Supervisor chat turn and scroll behavior", () => {
  it("shows the optimistic owner turn while server response is pending; reply replaces it without duplicates", () => {
    const optimistic = beginOptimisticOwner("Products so far?", "new-key");
    const before = visibleConversationMessages([owner, answer], optimistic, "thread", "2026-10-11");
    expect(before.map(m => m.role)).toEqual(["owner", "supervisor", "owner"]);
    expect(before.at(-1)).toMatchObject({ id: "pending:new-key", text: "Products so far?", clientMessageId: "new-key" });
    // Composer renders its sending indicator below visibleConversationMessages.
    expect(before.at(-1)?.role).toBe("owner");
    const stored = { ...owner, id: "server-owner", text: "Products so far?", clientMessageId: "new-key" };
    const after = visibleConversationMessages([owner, answer, stored, { ...answer, id: "server-answer" }],
      optimistic, "thread", "2026-10-11");
    expect(after.filter(m => m.clientMessageId === "new-key")).toHaveLength(1);
    expect(after.at(-1)?.role).toBe("supervisor");
  });
  it("opens an existing conversation at top and follows new sends to latest",()=>{
    expect(transcriptScrollTarget({
      scrollTop: 100, scrollHeight: 2400, previousScrollHeight: null,
      openAtTop: true, followLatest: false,
    })).toBe(0);
    expect(transcriptScrollTarget({
      scrollTop: 100, scrollHeight: 2400, previousScrollHeight: null,
      openAtTop: false, followLatest: true,
    })).toBe(2400);
    expect(transcriptScrollTarget({
      scrollTop: 400, scrollHeight: 2600, previousScrollHeight: null,
      openAtTop: false, followLatest: false,
    })).toBeNull();
  });
  it("preserves offset when older messages are prepended, without jumping to bottom",()=>{
    expect(transcriptScrollTarget({
      scrollTop: 165, scrollHeight: 1450, previousScrollHeight: 1000,
      openAtTop: false, followLatest: false,
    })).toBe(615);
    expect(transcriptScrollTarget({
      scrollTop: 165, scrollHeight: 1450, previousScrollHeight: 1000,
      openAtTop: true, followLatest: false,
    })).toBe(615);
  });
  it("uses original retry key and bounds post-answer whitespace", () => {
    expect(sendKey("original-key", "different-key", () => "random")).toBe("original-key");
    expect(sendKey(undefined, "pending-key", () => "random")).toBe("pending-key");
    expect(sendKey(undefined, null, () => "new-id")).toBe("new-id");

  });
});
