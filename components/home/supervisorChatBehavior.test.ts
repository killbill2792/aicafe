import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { activeOwnerQuestionMessageId, beginOptimisticOwner, sendKey, visibleConversationMessages,
  hasInsertedHistoryPage, isTranscriptNearBottom, transcriptScrollTarget } from "./supervisorChatBehavior";

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
  it("bottom-anchors opening history, optimistic sends and streamed growth", () => {
    expect(transcriptScrollTarget({
      scrollTop: 0, scrollHeight: 2400, clientHeight: 500,
      previousScrollHeight: null, pinned: true,
    })).toBe(1900);
    expect(transcriptScrollTarget({
      scrollTop: 1900, scrollHeight: 2520, clientHeight: 500,
      previousScrollHeight: null, pinned: true,
    })).toBe(2020);
    expect(transcriptScrollTarget({
      scrollTop: 0, scrollHeight: 400, clientHeight: 500,
      previousScrollHeight: null, pinned: true,
    })).toBe(0);
  });
  it("does not hijack the reader when scrolled up, but detects return to the bottom", () => {
    expect(isTranscriptNearBottom({ scrollTop: 1450, scrollHeight: 2000, clientHeight: 500 })).toBe(true);
    expect(isTranscriptNearBottom({ scrollTop: 1350, scrollHeight: 2000, clientHeight: 500 })).toBe(false);
    expect(transcriptScrollTarget({
      scrollTop: 350, scrollHeight: 2500, clientHeight: 500,
      previousScrollHeight: null, pinned: false,
    })).toBeNull();
  });
  it("does not spend the history anchor on intermediate streaming updates", () => {
    let committed = 0;
    let applied = 0;
    const pendingHeight = 1000;
    const streamed = { scrollTop: 165, scrollHeight: 1100, clientHeight: 500 };
    expect(hasInsertedHistoryPage(committed, applied)).toBe(false);
    expect(transcriptScrollTarget({
      ...streamed, previousScrollHeight: null, pinned: false,
    })).toBeNull();

    // Only the history page commit advances this version. Stream deltas do not.
    committed++;
    expect(hasInsertedHistoryPage(committed, applied)).toBe(true);
    expect(transcriptScrollTarget({
      scrollTop: streamed.scrollTop, scrollHeight: 1550,
      clientHeight: 500, previousScrollHeight: pendingHeight, pinned: false,
    })).toBe(715);
    applied = committed;
    expect(hasInsertedHistoryPage(committed, applied)).toBe(false);
  });
  it("preserves viewport when older messages are prepended without snapping to latest", () => {
    expect(transcriptScrollTarget({
      scrollTop: 165, scrollHeight: 1450, clientHeight: 500,
      previousScrollHeight: 1000, pinned: false,
    })).toBe(615);
    expect(transcriptScrollTarget({
      scrollTop: 165, scrollHeight: 1450, clientHeight: 500,
      previousScrollHeight: 1000, pinned: true,
    })).toBe(615);
  });
  it("only the latest pending card remains interactive after a new reply, cancel or newer owner message",()=>{
    const oldQuestion={...answer,id:"q-old",blocks:[{type:"owner_question",questionId:"q1"}]};
    const confirmation={...answer,id:"q-confirm",blocks:[{type:"owner_question",questionId:"q2"}]};
    expect(activeOwnerQuestionMessageId([owner,oldQuestion])).toBe("q-old");
    expect(activeOwnerQuestionMessageId([owner,oldQuestion,{...owner,id:"typed"}])).toBeNull();
    expect(activeOwnerQuestionMessageId([owner,oldQuestion,{...owner,id:"typed"},confirmation]))
      .toBe("q-confirm");
    expect(activeOwnerQuestionMessageId([owner,oldQuestion,{...owner,id:"typed"},confirmation,
      {...owner,id:"confirmed"},answer])).toBeNull();
    expect(activeOwnerQuestionMessageId([owner,oldQuestion,answer])).toBeNull();
  });
  it("uses original retry key and bounds post-answer whitespace", () => {
    expect(sendKey("original-key", "different-key", () => "random")).toBe("original-key");
    expect(sendKey(undefined, "pending-key", () => "random")).toBe("pending-key");
    expect(sendKey(undefined, null, () => "new-id")).toBe("new-id");

  });
});
