import {describe,it,expect} from "vitest";
import {adaptReviewedClarifications} from "./clarifications";
import type {GroundedSupervisorReply} from "@/lib/ai/conversations/contracts";
const reply:GroundedSupervisorReply={intent:"unknown",status:"insufficient_evidence",evidence:[],
  blocks:[{type:"text",text:"Which Latte should I use?"}]};
const answer={paragraphs:[{kind:"clarification" as const,
  text:"Which Latte should I use?",citations:[]}]};
const candidates=(n:number)=>Array.from({length:n},(_,i)=>({
  id:"drink-"+i,label:{en:"Latte "+i,es:"Latte "+i,ar:"لاتيه "+i},
}));
describe("reviewed known-record clarification cards",()=>{
  it("adapts two canonical names as tappable rows",()=>{
    const adapted=adaptReviewedClarifications(reply,answer,"en",candidates(2));
    expect(adapted.blocks).toMatchObject([{type:"owner_question",
      input:{kind:"options",options:[{id:"drink-0"},{id:"drink-1"}]}}]);
  });
  it("keeps every one of eight verified candidates",()=>{
    const adapted=adaptReviewedClarifications(reply,answer,"en",candidates(8));
    const card=adapted.blocks[0];
    expect(card.type).toBe("owner_question");
    if(card.type==="owner_question"&&card.input.kind==="options")
      expect(card.input.options).toHaveLength(8);
    else throw Error("Expected options");
  });
  it("uses a free-response card for an unenumerated clarification",()=>{
    const adapted=adaptReviewedClarifications(reply,answer,"es");
    expect(adapted.blocks).toMatchObject([{type:"owner_question",
      input:{kind:"free_text"}}]);
  });
  it("cannot convert ordinary advice or unsupported-action claims into selectable cards",()=>{
    const unchanged=adaptReviewedClarifications(reply,{paragraphs:[
      {kind:"advice",text:"Which Latte should I use?",citations:[]},
    ]},"en",candidates(2));
    expect(unchanged).toEqual(reply);
  });
});
