import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333"};
const employeeId="44444444-4444-4444-8444-444444444444";
const state=vi.hoisted(()=>({mode:"ok" as "ok"|"conflict"|"offline",attempts:0}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
 authenticatedConversationContext:async()=>({scope,
   service:{getThread:async(id:string)=>({id})}})
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:async()=>{}}));
vi.mock("@/lib/data/schedulingDraftInputs.server",()=>({
 readSchedulingDraftInputs:async()=>({
  available:true,value:{timezone:"America/Los_Angeles",employees:[{
   id:employeeId,wage_period:"hour",wage_amount_cents:2000,
   default_hourly_wage_cents:2000}],schedules:[],availability:[],preferences:[],
   openHours:{mon:[["09:00","12:00"]]},city:null,region:null,countryCode:null},
  quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}
 })
}));
vi.mock("@/lib/supabase/server",()=>({
 createServerSupabaseClient:async()=>{
  const query={
   select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,is:()=>query,
   limit:async()=>({data:[],error:null})
  };
  return {from:()=>query};
 }
}));
vi.mock("@/lib/calc/scheduling/draftWeek",()=>({
 businessLocalDate:()=>"2026-10-25",
 draftWeekWithStaffIds:()=>({missing:[],days:[{
  date:"2026-10-26",shifts:[{employeeId,start:"09:00",end:"12:00",paidHours:3}]
 }],totals:{costIsPartial:false},estimated:[]})
}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({supervisorLoopRegistry:{}}));
vi.mock("@/lib/ai/supervisor/loop/staffProposals.server",()=>({
 staffCapabilityId:()=>"olivia.staff_propose_schedule.v2"
}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
 SupabaseLoopRepository:class{}
}));
vi.mock("@/lib/ai/supervisor/loop/engine",async(importOriginal)=>{
 const actual=await importOriginal<typeof import("@/lib/ai/supervisor/loop/engine")>();
 return {...actual,proposeLoop:async()=>{
  state.attempts++;
  if(state.mode==="conflict")throw new actual.ProposalRequestConflictError();
  if(state.mode==="offline")throw new Error("Temporary server failure");
  return {id:"55555555-5555-4555-8555-555555555555",revision:1,
   canonicalEffectPayload:{preview:[{field:"schedule:2026-10-26",before:null,
     after:{kind:"text",text:"Shift"}}]}}
 }};
});
import {draftStaffWeekInPlace} from "./staffDraftInPlace";
const input={week:"2026-10-26",threadId:"33333333-3333-4333-8333-333333333333",
 requestKey:"66666666-6666-4666-8666-666666666666",locale:"en"};

beforeEach(()=>{state.mode="ok";state.attempts=0;});
describe("owner staff draft idempotent retry",()=>{
 it("returns the exact shift preview for a safely created inert proposal",async()=>{
  const result=await draftStaffWeekInPlace(input);
  expect(result).toMatchObject({ok:true,
   proposalId:"55555555-5555-4555-8555-555555555555",revision:1,
   shifts:[{employee_id:employeeId,date:"2026-10-26",
    start:"09:00",end:"12:00",break_minutes:0}]});
  expect(state.attempts).toBe(1);
 });
 it("releases a conflicting idempotency key so the owner can start a fresh draft",async()=>{
  state.mode="conflict";
  expect(await draftStaffWeekInPlace(input)).toEqual({ok:false,error:"week_changed"});
  expect(state.attempts).toBe(1);
 });
 it("does not mislabel an ordinary transient backend failure as changed scheduling data",async()=>{
  state.mode="offline";
  expect(await draftStaffWeekInPlace(input)).toEqual({ok:false,error:"unavailable"});
  expect(state.attempts).toBe(1);
 });
});
