import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { answeredOwnerQuestion, activeOwnerQuestionMessageId, beginOptimisticOwner, sendKey, visibleConversationMessages,
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
  it("resolves supplied values but keeps a later same-ID confirmation actionable",()=>{
    const id="11111111-1111-4111-8111-111111111111";
    const question={...answer,id:"prompt",blocks:[{type:"owner_question",questionId:id}]};
    const supplied={...owner,id:"supplied",ownerInputResponse:{
      questionId:id,action:"supply" as const,value:"10 cents"}};
    const copy={en:"Confirm",es:"Confirmar",ar:"تأكيد"};
    const confirmation={...answer,id:"confirm-prompt",blocks:[{type:"owner_question",questionId:id}],
      grounding:{ownerInput:{version:1,questionId:id,stage:"confirm",businessId:id,
        originalText:"Set ingredient cost",readCapabilityId:"menu.price.v1",readInputJson:"{}",
        request:{fieldId:"ingredient.cost",writeCapabilityId:"menu.price.v1",
          writeContext:{},question:copy,input:{kind:"free_text",hint:copy}},
        answer:"10 cents",summary:copy}}};
    expect(answeredOwnerQuestion([question,supplied,confirmation],question,id)?.id).toBe("supplied");
    expect(answeredOwnerQuestion([question,supplied,confirmation],confirmation,id)).toBeNull();
    const confirmed={...owner,id:"confirmed",ownerInputResponse:{
      questionId:id,action:"confirm" as const}};
    expect(answeredOwnerQuestion([question,supplied,confirmation,confirmed],confirmation,id)?.id)
      .toBe("confirmed");
  });
  it("does not close a reissued prompt using an older same-ID answer",()=>{
    const id="11111111-1111-4111-8111-111111111111";
    const question={...answer,id:"initial",blocks:[{type:"owner_question",questionId:id}]};
    const reissued={...question,id:"reissued"};
    const supplied={...owner,id:"supply",ownerInputResponse:{
      questionId:id,action:"supply" as const,value:"16 ounces"}};
    expect(answeredOwnerQuestion([question,reissued,supplied],question,id)).toBeNull();
    expect(answeredOwnerQuestion([question,reissued,supplied],reissued,id)?.id).toBe("supply");
  });
  it("uses original retry key and bounds post-answer whitespace", () => {
    expect(sendKey("original-key", "different-key", () => "random")).toBe("original-key");
    expect(sendKey(undefined, "pending-key", () => "random")).toBe("pending-key");
    expect(sendKey(undefined, null, () => "new-id")).toBe("new-id");

  });
});
