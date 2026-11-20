import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { clarifyCardState, activeOwnerQuestionMessageId, beginOptimisticOwner, sendKey, visibleConversationMessages,
  hasInsertedHistoryPage, isTranscriptNearBottom, transcriptScrollTarget, isDuplicateLinkedExperimentCard, mergeLatestConversationPage, prependConversationPage, loadedSavedReports, conversationLocation } from "./supervisorChatBehavior";

const owner: ConversationMessage = {
  id: "stored-owner", threadId: "thread", role: "owner", contentType: "text",
  text: "Staff costs?", blocks: null, grounding: null, createdAt: "2026-10-11", clientMessageId: "old-key",
};
const answer: ConversationMessage = {
  ...owner, id: "reply", role: "supervisor", clientMessageId: null, text: null,
  contentType: "blocks", blocks: [{ type: "text", text: "Recorded answer" }],
};

describe("Supervisor chat turn and scroll behavior", () => {
  it("suppresses only the exact experiment already opened by its deep link",()=>{
    const card={type:"experiment_card",proposalId:"proposal-A"};
    expect(isDuplicateLinkedExperimentCard(card,"thread-A","thread-A","proposal-A")).toBe(true);
    expect(isDuplicateLinkedExperimentCard(card,"thread-A","thread-A","proposal-B")).toBe(false);
    expect(isDuplicateLinkedExperimentCard(card,"thread-B","thread-A","proposal-A")).toBe(false);
    expect(isDuplicateLinkedExperimentCard(card,"thread-A",undefined,"proposal-A")).toBe(false);
    expect(isDuplicateLinkedExperimentCard({type:"proposal_card",proposalId:"proposal-A"},
      "thread-A","thread-A","proposal-A")).toBe(false);
    expect(isDuplicateLinkedExperimentCard(null,"thread-A","thread-A","proposal-A")).toBe(false);
  });
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
      clientHeight: 500, previousScrollHeight: streamed.scrollHeight, pinned: false,
    })).toBe(615);
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

it("keeps a durable question active across unrelated messages and consumes only the exact saved answer",()=>{const question={...answer,id:"q",grounding:{durableQuestionId:"q"},blocks:[{type:"clarify",question:"Which day?"}]};const unrelated={...owner,id:"other"};const matched={...owner,id:"matched",text:"Tomorrow",ownerInputResponse:{questionId:"q",action:"supply" as const}};expect(clarifyCardState([question,unrelated],0,new Set(["q"]))).toEqual({state:"active",choice:null});expect(clarifyCardState([question,unrelated,matched],0,new Set())).toEqual({state:"chosen",choice:"Tomorrow"});expect(clarifyCardState([question,unrelated],0,new Set())).toEqual({state:"skipped",choice:null});});

describe("same-thread refresh with older history already loaded",()=>{
  const message=(id:string)=>({...owner,id,clientMessageId:id});
  it("preserves the contiguous older prefix, refreshes overlapping content and advances the offset",()=>{
    const older=[message("a"),message("b"),message("c"),message("d")];
    const fresh=[{...message("c"),text:"Current saved answer"},message("d"),message("e")];
    const merged=mergeLatestConversationPage({items:older,nextOffset:4},{items:fresh,nextOffset:3});
    expect(merged.items.map(m=>m.id)).toEqual(["a","b","c","d","e"]);
    expect(merged.items[2].text).toBe("Current saved answer");
    expect(merged.nextOffset).toBe(5);
    expect(mergeLatestConversationPage({items:older,nextOffset:null},{items:fresh,nextOffset:3}).nextOffset).toBeNull();
  });
  it("does not combine unrelated or nonoverlapping pages or keep deleted rows from a full read",()=>{
    const old={items:[message("a"),message("b")],nextOffset:2};
    const recent={items:[message("x"),message("y")],nextOffset:2};
    expect(mergeLatestConversationPage(old,recent)).toEqual(recent);
    const other={items:[{...message("b"),threadId:"other"}],nextOffset:1};
    expect(mergeLatestConversationPage(old,other)).toEqual(other);
    const full={items:[message("b")],nextOffset:null};
    expect(mergeLatestConversationPage(old,full)).toEqual(full);
  });
});

describe("saved report indexing",()=>{
  const presentation={type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],report:true};
  it("indexes only supported same-thread persisted supervisor reports, once per source message",()=>{
    const report={...answer,blocks:[...answer.blocks!,presentation,presentation]};
    expect(loadedSavedReports([report,{...report,id:"foreign",threadId:"foreign"},{...report,id:"unknown",blocks:[{...presentation,version:2}]},{...owner,blocks:[presentation]}],"thread")).toEqual([{id:"reply",createdAt:answer.createdAt,title:null}]);
    expect(loadedSavedReports([report],null)).toEqual([]);
    expect(loadedSavedReports([report],"foreign")).toEqual([]);
  });
});

describe("conversation URL state",()=>{
  it("preserves the current period and locale and drops stale experiment when switching conversations",()=>{
    expect(conversationLocation("https://cafe.invalid/en?period=week&thread=old&experiment=old-proposal","selected")).toBe("/en?period=week&thread=selected");
    expect(conversationLocation("https://cafe.invalid/en?period=week&thread=old&experiment=old-proposal",null)).toBe("/en?period=week&newChat=1");
    expect(conversationLocation("https://cafe.invalid/es?newChat=1","saved")).toBe("/es?thread=saved");
  });
});

describe("authorized older page concurrency",()=>{
  const m=(id:string)=>({...owner,id,clientMessageId:id});
  it("merges a repeated boundary after a newer message arrives without skipping the next row",()=>{
    const current={items:[m("c"),m("d"),m("e")],nextOffset:3};
    const older={items:[m("b"),m("c")],nextOffset:4};
    expect(prependConversationPage(current,older,"thread")).toEqual({items:[m("b"),m("c"),m("d"),m("e")],nextOffset:4});
    expect(prependConversationPage(current,{items:[m("a"),m("b")],nextOffset:null},"thread").nextOffset).toBeNull();
  });
  it("never reintroduces rows after a denied or foreign conversation",()=>{
    const denied={items:[],nextOffset:null};
    expect(prependConversationPage(denied,{items:[m("b")],nextOffset:1},"thread")).toEqual(denied);
    const current={items:[m("c")],nextOffset:1};
    expect(prependConversationPage(current,{items:[{...m("b"),threadId:"other"}],nextOffset:null},"thread")).toEqual(current);
  });
});
