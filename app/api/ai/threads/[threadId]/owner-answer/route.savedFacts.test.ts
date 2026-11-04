import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({save:vi.fn(),forget:vi.fn(),messages:[] as unknown[]}));
vi.mock("@/lib/ownerFacts/store.server",()=>({saveOwnerFactAnswers:m.save,forgetOwnerFact:m.forget}));
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
beforeEach(()=>{m.save.mockReset();m.forget.mockReset();
 m.save.mockImplementation(async(_b:string,a:unknown[])=>a.map(()=>({id:"f",writeThroughApplied:true})));
 m.forget.mockResolvedValue(true);});

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
  expect(m.forget).toHaveBeenCalledWith("cafe-1","supplier");
  expect(await res.json()).toMatchObject({remembered:0,forgotten:1});
 });
 it("refuses a forget the card never offered, and saves nothing",async()=>{
  m.messages=[cardMessage({fields:[text("supplier")]})];
  const res=await post([{fieldKey:"supplier",value:"",forget:true}]);
  expect(res.status).toBe(422);
  expect(m.forget).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
 });
});
