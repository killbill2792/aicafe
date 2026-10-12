import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { beginOptimisticOwner, sendKey, visibleConversationMessages,
  transcriptScrollTarget, responsiveTailSpace } from "./supervisorChatBehavior";

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
  it("anchors a newly sent question near transcript top, without forcing replies to bottom", () => {
    expect(transcriptScrollTarget({
      scrollTop: 180, scrollHeight: 1200, previousScrollHeight: null,
      anchorDelta: 320, userScrolled: false, openNewest: false,
    })).toBe(488);
    expect(transcriptScrollTarget({
      scrollTop: 488, scrollHeight: 1500, previousScrollHeight: null,
      anchorDelta: null, userScrolled: false, openNewest: false,
    })).toBeNull();
    expect(transcriptScrollTarget({
      scrollTop: 200, scrollHeight: 1500, previousScrollHeight: null,
      anchorDelta: 300, userScrolled: true, openNewest: false,
    })).toBeNull();
  });
  it("restores scroll offset after older messages are prepended and opens existing history newest", () => {
    expect(transcriptScrollTarget({
      scrollTop: 165, scrollHeight: 1450, previousScrollHeight: 1000,
      anchorDelta: 100, userScrolled: false, openNewest: false,
    })).toBe(615);
    expect(transcriptScrollTarget({
      scrollTop: 0, scrollHeight: 2000, previousScrollHeight: null,
      anchorDelta: null, userScrolled: false, openNewest: true,
    })).toBe(2000);
  });
  it("uses original retry key and bounds post-answer whitespace", () => {
    expect(sendKey("original-key", "different-key", () => "random")).toBe("original-key");
    expect(sendKey(undefined, "pending-key", () => "random")).toBe("pending-key");
    expect(sendKey(undefined, null, () => "new-id")).toBe("new-id");
    expect(responsiveTailSpace(640, 35, true)).toBe(593);
    expect(responsiveTailSpace(640, 35, false)).toBeLessThanOrEqual(77);
    expect(responsiveTailSpace(640, 630, false)).toBe(0);
  });
});
