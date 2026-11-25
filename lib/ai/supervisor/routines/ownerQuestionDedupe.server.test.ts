import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openQuestionAlreadyAsked} from "./ownerQuestionDedupe.server";

function db(open:unknown[],messages:unknown[]){
  const chain=(data:unknown[])=>{const q:Record<string,unknown>={};
    for(const m of ["select","eq","is","not","in"])q[m]=()=>q;
    q.limit=async()=>({data,error:null});return q;};
  return {from:(table:string)=>chain(table==="supervisor_investigations"?open:messages)} as never;
}
const scope={businessId:"b",ownerUserId:"o",sourceType:"alert",sourceId:"mine"};
const card=(question:string)=>({structured_content:[{type:"text",text:"x"},{type:"clarify",question}]});
describe("owner is asked a question once",()=>{
  it("detects the same open question on another investigation, ignoring case and punctuation",async()=>{
    const open=[{source_type:"alert",source_id:"other",pending_question_id:"m1"}];
    expect(await openQuestionAlreadyAsked(db(open,[card("Which supplier sent the delivery on Monday?")]),scope,"which supplier sent the delivery on monday")).toBe(true);
  });
  it("does not count a different question or the investigation's own question",async()=>{
    const other=[{source_type:"alert",source_id:"other",pending_question_id:"m1"}];
    expect(await openQuestionAlreadyAsked(db(other,[card("Who covered the evening shift?")]),scope,"Which supplier sent the delivery on Monday?")).toBe(false);
    const own=[{source_type:"alert",source_id:"mine",pending_question_id:"m2"}];
    expect(await openQuestionAlreadyAsked(db(own,[card("Which supplier sent the delivery on Monday?")]),scope,"Which supplier sent the delivery on Monday?")).toBe(false);
    expect(await openQuestionAlreadyAsked(db([],[]),scope,"Anything?")).toBe(false);
  });
});
