import {beforeEach,describe,expect,it,vi} from "vitest";
import {readApprovedScheduleDelivery} from "./ownerScheduleDelivery.server";

const shared=vi.hoisted(()=>({client:null as unknown}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>shared.client}));
vi.mock("@/lib/scheduling/foundation.server",()=>({requireSchedulingOwner:vi.fn()}));

const proposalId="11111111-1111-4111-8111-111111111111";
const employeeES="22222222-2222-4222-8222-222222222222";
const employeeAR="33333333-3333-4333-8333-333333333333";
const employeeInactive="44444444-4444-4444-8444-444444444444";
const week="2026-11-02",businessId="cafe-one",userId="owner-one";
const shifts=[
 {employee_id:employeeES,date:"2026-11-02",start:"08:00",end:"16:00"},
 {employee_id:employeeAR,date:"2026-11-03",start:"07:00",end:"14:00"},
 {employee_id:employeeInactive,date:"2026-11-04",start:"09:00",end:"15:00"}
];
function adminDb(changed=false){
 const tables:Record<string,Array<Record<string,unknown>>>={
  supervisor_proposals:[{id:proposalId,business_id:businessId,owner_user_id:userId,
   status:"committed",capability_id:"olivia.staff_propose_send_schedule.v2",
   canonical_effect_payload:{payload:{week_start:week}}}],
  staff_schedule_handoff_snapshots:[{business_id:businessId,proposal_id:proposalId,week_start:week,shifts}],
  employees:[
   {business_id:businessId,id:employeeES,display_name:"María",phone_e164:"+14155551234",
    preferred_language:"es",whatsapp_opt_in:true,preferred_schedule_channel:"whatsapp",active:true},
   {business_id:businessId,id:employeeAR,display_name:"Ahmed",phone_e164:"+34612345678",
    preferred_language:"ar",whatsapp_opt_in:false,preferred_schedule_channel:"sms",active:true},
   {business_id:businessId,id:employeeInactive,display_name:"Former",phone_e164:null,
    preferred_language:null,whatsapp_opt_in:false,preferred_schedule_channel:"sms",active:false}
  ],staff_schedule_deliveries:[]
 };
 return {
  from(table:string){
   const filters:Array<(row:Record<string,unknown>)=>boolean>=[];
   const get=()=>tables[table].filter(row=>filters.every(fn=>fn(row)));
   const q={
    select:()=>q,eq:(key:string,value:unknown)=>{filters.push(row=>row[key]===value);return q;},
    in:(key:string,values:unknown[])=>{filters.push(row=>values.includes(row[key]));return q;},
    limit:()=>q,
    maybeSingle:async()=>({data:get()[0]??null,error:null}),
    then:(resolve:(value:{data:Record<string,unknown>[];error:null})=>unknown)=>
     Promise.resolve({data:get(),error:null}).then(resolve)
   };
   return q;
  },
  rpc:async(name:string)=>{
   if(name!=="staff_handoff_week_shifts")throw Error("Unexpected write RPC");
   return {data:changed?shifts.slice(1):shifts,error:null};
  }
 };
}
const auth=(businessId:string,userId:string)=>({businessId,userId}) as
 NonNullable<Parameters<typeof readApprovedScheduleDelivery>[2]>;

describe("owner-approved staff message reads",()=>{
 beforeEach(()=>{shared.client=adminDb();});
 it("uses each employee language, café-local times, and excludes inactive employees",async()=>{
  const data=await readApprovedScheduleDelivery({proposalId},"en",auth(businessId,userId));
  expect(data.recipients).toHaveLength(2);
  const maria=data.recipients.find(p=>p.id===employeeES)!;
  const ahmed=data.recipients.find(p=>p.id===employeeAR)!;
  expect(maria.message).toContain("María");
  expect(maria.message).toMatch(/08:00/);
  expect(maria.message).not.toContain("2026-11-02:");
  expect(ahmed.message).toContain("Ahmed");
  expect(ahmed.message).toContain("مرحب");
  expect(maria.optedIn).toBe(true);
  expect(ahmed.optedIn).toBe(false);
  expect(data.recipients.some(p=>p.id===employeeInactive)).toBe(false);
 });
 it("never reads another business's approved proposal",async()=>{
  await expect(readApprovedScheduleDelivery({proposalId},"en",auth("other-business",userId)))
   .rejects.toMatchObject({code:"not_approved"});
  await expect(readApprovedScheduleDelivery({proposalId},"en",auth(businessId,"other-owner")))
   .rejects.toMatchObject({code:"not_approved"});
 });
 it("rejects a schedule changed after owner approval",async()=>{
  shared.client=adminDb(true);
  await expect(readApprovedScheduleDelivery({proposalId},"en",auth(businessId,userId)))
   .rejects.toMatchObject({code:"schedule_changed"});
 });
});