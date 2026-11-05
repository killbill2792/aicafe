import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({save:vi.fn(),change:vi.fn(),messages:[] as unknown[]}));
vi.mock("@/lib/ownerFacts/store.server",()=>({saveOwnerFactAnswers:m.save,changeOwnerFacts:m.change}));
vi.mock("@/lib/ai/conversations/auth.server",async()=>{
 class ConversationApiError extends Error{constructor(public status:number,public code:string){super(code);}}
 return {ConversationApiError,authenticatedConversationContext:async()=>({scope:{businessId:"cafe-1"},
  service:{getThread:async()=>({}),listMessages:async()=>({items:m.messages})}})};
});
import {POST} from "./route";
const thread="11111111-1111-4111-8111-111111111111",questionId="22222222-2222-4222-8222-222222222222";
const cardMessage=(block:Record<string,unknown>)=>({id:"m1",role:"supervisor",createdAt:"2026-11-04T10:00:00Z",
 blocks:[{type:"clarify",kind:"facts",questionId,question:"Q?",...block}]});
const post=(answers:unknown[])=>POST(new Request("https://cafe.test/api/ai/threads/"+thread+"/owner-answer",{method:"POST",
 headers:{origin:"https://cafe.test","content-type":"application/json"},body:JSON.stringify({questionId,locale:"en",answers})}),
 {params:Promise.resolve({threadId:thread})});
const text=(key:string,extra:Record<string,unknown>={})=>({key,label:key,inputType:"text",units:[],defaultUnit:"",...extra});
beforeEach(()=>{m.save.mockReset();m.change.mockReset();
 m.save.mockImplementation(async(_b:string,a:unknown[])=>a.map(()=>({id:"f",writeThroughApplied:true})));
 m.change.mockImplementation(async(_b:string,a:unknown[],f:string[])=>({saved:a.map(()=>({id:"f",writeThroughApplied:true})),forgotten:f.length}));});

describe("answering a question card saves only what should last",()=>{
 it("saves lasting answers and never saves a this-question answer",async()=>{
  m.messages=[cardMessage({fields:[text("supplier"),text("guests_thursday",{remember:"this_question"})]})];
  const res=await post([{fieldKey:"supplier",value:"Mill St"},{fieldKey:"guests_thursday",value:"40"}]);
  expect(res.status).toBe(200);
  expect(m.save).toHaveBeenCalledWith("cafe-1",[expect.objectContaining({fieldKey:"supplier",value:"Mill St"})]);
  expect(await res.json()).toMatchObject({saved:true,remembered:1,forgotten:0});
 });
 it("saves nothing when every answer was for this question only",async()=>{
  m.messages=[cardMessage({fields:[text("guests_thursday",{remember:"this_question"})]})];
  const res=await post([{fieldKey:"guests_thursday",value:"40"}]);
  expect(m.save).not.toHaveBeenCalled();
  expect(await res.json()).toMatchObject({saved:true,remembered:0,forgotten:0});
 });
 it("forgets a saved fact from the owner's change card",async()=>{
  m.messages=[cardMessage({changeSaved:true,fields:[text("supplier",{current:{value:"Mill St",savedOn:"2026-10-30",canForget:true}})]})];
  const res=await post([{fieldKey:"supplier",value:"",forget:true}]);
  expect(m.change).toHaveBeenCalledWith("cafe-1",[],["supplier"]);
  expect(m.save).not.toHaveBeenCalled();
  expect(await res.json()).toMatchObject({remembered:0,forgotten:1});
 });
 it("sends a forget and a new value together, in one save that succeeds or fails whole",async()=>{
  m.messages=[cardMessage({changeSaved:true,fields:[
   text("supplier",{current:{value:"Mill St",savedOn:"2026-10-30",canForget:true}}),
   text("opening_note",{current:{value:"Open 7",savedOn:"2026-10-30",canForget:true}})]})];
  const ok=await post([{fieldKey:"supplier",value:"",forget:true},{fieldKey:"opening_note",value:"Open 6:30"}]);
  expect(m.change).toHaveBeenCalledTimes(1);
  expect(m.change).toHaveBeenCalledWith("cafe-1",[expect.objectContaining({fieldKey:"opening_note",value:"Open 6:30"})],["supplier"]);
  expect(m.save).not.toHaveBeenCalled();
  expect(await ok.json()).toMatchObject({remembered:1,forgotten:1});
  m.change.mockRejectedValueOnce(new Error("owner_facts_write_failed"));
  const failed=await post([{fieldKey:"supplier",value:"",forget:true},{fieldKey:"opening_note",value:"Open 6:30"}]);
  expect(failed.ok).toBe(false);
  expect(m.save).not.toHaveBeenCalled();
 });
 it("refuses a forget the card never offered, and saves nothing",async()=>{
  m.messages=[cardMessage({fields:[text("supplier")]})];
  const res=await post([{fieldKey:"supplier",value:"",forget:true}]);
  expect(res.status).toBe(422);
  expect(m.change).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
 });
});
