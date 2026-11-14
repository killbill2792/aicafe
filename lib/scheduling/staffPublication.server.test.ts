import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
 admin:vi.fn(),blockers:vi.fn(),send:vi.fn(),owner:vi.fn(),
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
vi.mock("@/lib/scheduling/foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("@/lib/whatsapp/staffScheduleDelivery.server",()=>({
 staffProviderBlockers:mocks.blockers,sendStaffScheduleTemplate:mocks.send,
}));
import {publishApprovedStaffSchedule,recordSignedStaffScheduleStatus,
 followUpStaffPublicationForBusiness} from "./staffPublication.server";
const scope={businessId:"cafe-A",ownerUserId:"owner-A"};
const week="2026-11-23";
const p={id:"publication-A",business_id:"cafe-A",owner_user_id:"owner-A",
 proposal_id:"proposal-A",week_start:week,status:"published",
 snapshot:[{employee_id:"worker-A",date:week,start:"09:00",end:"15:00"}]};
function dbFixture(status="prepared",explicit=true,upcomingPublished=true){
 const operations:Array<Record<string,unknown>>=[];
 const calls:Array<{table:string;column:string;value:unknown}>=[];
 const rpc=vi.fn(async(name:string)=>{
  if(name==="staff_schedule_publish")return {data:{id:p.id,week,state:"published",replayed:true},error:null};
  if(name==="staff_schedule_claim_delivery")return {data:{
   deliveryId:"delivery-A",attemptToken:"token-A",to:"+14155550123"},error:null};
  if(name==="staff_schedule_finish_delivery")return {data:true,error:null};
  if(name==="staff_schedule_can_send")return {data:true,error:null};
  if(name==="staff_schedule_record_provider_status")return {data:true,error:null};
  return {data:null,error:new Error("unexpected rpc "+name)};
 });
 const from=vi.fn((table:string)=>{
  const rows=()=>table==="supervisor_proposals"?
   [{id:"proposal-A",owner_user_id:"owner-A",
     canonical_effect_payload:{payload:{week_start:week,publish_and_notify:explicit}}}]:
   table==="staff_schedule_publications"?[p]:
   table==="staff_schedule_deliveries"?[{id:"delivery-A",employee_id:"worker-A",
     status,recipient_e164:"+14155550123"}]:
   table==="employees"?[{id:"worker-A"}]:
   table==="scheduled_shifts"?[{id:"shift-A"}]:
   table==="memberships"?[{user_id:"owner-A"}]:[];
  const q:Record<string,unknown>={};
  q.select=()=>q;q.eq=(column:string,value:unknown)=>{calls.push({table,column,value});return q;};
  q.gte=()=>q;q.order=()=>q;q.limit=async()=>({data:rows(),error:null});
  q.maybeSingle=async()=>({data:table==="employees"?{
    id:"worker-A",display_name:"Ari",preferred_language:"en",
   }:table==="staff_schedule_publications"&&upcomingPublished?p:null,error:null});
  q.upsert=async(row:Record<string,unknown>)=>{operations.push(row);return {error:null};};
  return q;
 });
 const db={rpc,from} as unknown as SupabaseClient;
 return {db,rpc,from,operations,calls};
}
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.blockers.mockReturnValue([]);
 mocks.send.mockResolvedValue({state:"accepted",wamid:"wamid.worker-a"});
});
describe("Task 13B existing-Supervisor durability and receipt boundary",()=>{
 it("can publish only through a scoped SQL effect claim; a forged response is rejected",async()=>{
  const f=dbFixture();
  mocks.admin.mockReturnValue(f.db);
  const r=await publishApprovedStaffSchedule(scope,"proposal-A");
  expect(r).toMatchObject({state:"published",replayed:true});
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_publish",{
   p_business_id:"cafe-A",p_owner_user_id:"owner-A",p_proposal_id:"proposal-A",
  });
  f.rpc.mockResolvedValueOnce({data:{state:"unverified"},error:null});
  await expect(publishApprovedStaffSchedule(scope,"proposal-A")).rejects.toThrow(
   "staff_publication_storage_unavailable");
 });
 it("records provider outcomes only by wamid and never guesses staff acknowledgement",async()=>{
  const f=dbFixture();mocks.admin.mockReturnValue(f.db);
  await recordSignedStaffScheduleStatus({wamid:"wamid.worker-a",state:"delivered"});
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_record_provider_status",{
   p_wamid:"wamid.worker-a",p_status:"delivered"});
 });
 it("does not ever replay old copy-ready send proposals",async()=>{
  const f=dbFixture("prepared",false);mocks.admin.mockReturnValue(f.db);
  mocks.blockers.mockReturnValue(["WHATSAPP_STAFF_TEMPLATE_APPROVED"]);
  await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
  expect(f.rpc.mock.calls.filter(x=>x[0]==="staff_schedule_publish")).toHaveLength(0);
  expect(mocks.send).not.toHaveBeenCalled();
 });
 it("proactively creates the next-week owner decision before a new chat prompt",async()=>{
  const f=dbFixture("prepared",true,false);mocks.admin.mockReturnValue(f.db);
  mocks.blockers.mockReturnValue(["WHATSAPP_STAFF_TEMPLATE_APPROVED"]);
  await followUpStaffPublicationForBusiness(f.db,"cafe-A","2026-11-21");
  expect(f.operations).toContainEqual(expect.objectContaining({
    kind:"staff_schedule_publication",status:"needs_owner",
    owner_user_id:"owner-A",agent_id:"olivia",
    payload:expect.objectContaining({
      week:"2026-11-23",legalAndCoverageVerification:"not_claimed",
    }),
  }));
  expect(mocks.send).not.toHaveBeenCalled();
 });
 it("withholds all outbound sends when provider/template is off and creates an owner task",async()=>{
  const f=dbFixture();mocks.admin.mockReturnValue(f.db);
  mocks.blockers.mockReturnValue(["WHATSAPP_STAFF_TEMPLATE_APPROVED"]);
  const outcome=await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
  expect(outcome.blocked).toBeGreaterThan(0);
  expect(f.rpc.mock.calls.filter(x=>x[0]==="staff_schedule_claim_delivery")).toHaveLength(0);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(f.operations).toMatchObject([{
   kind:"staff_schedule_delivery",status:"needs_owner",agent_id:"olivia",owner_user_id:"owner-A",
  }]);
 });
 it("sends once from the verified claim, stores accepted as sent, leaves delivery pending",async()=>{
  const f=dbFixture();mocks.admin.mockReturnValue(f.db);
  const outcome=await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
  expect(outcome.attempted).toBe(1);
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_claim_delivery",{
   p_publication_id:"publication-A",p_employee_id:"worker-A"});
  expect(mocks.send).toHaveBeenCalledWith("+14155550123",expect.stringContaining("Ari"));
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_finish_delivery",{
   p_delivery_id:"delivery-A",p_attempt_token:"token-A",p_state:"sent",
   p_wamid:"wamid.worker-a",p_error:null});
  expect(f.operations[0]).toMatchObject({status:"needs_owner"});
 });
 it("a cancelled or opt-out-after-claim result blocks HTTP even when claim was valid",async()=>{
  const f=dbFixture();mocks.admin.mockReturnValue(f.db);
  f.rpc.mockImplementation(async(name:string)=>{
   if(name==="staff_schedule_publish")return {data:{id:p.id,week,state:"published",replayed:true},error:null};
   if(name==="staff_schedule_claim_delivery")return {data:{
     deliveryId:"delivery-A",attemptToken:"token-A",to:"+14155550123"},error:null};
   if(name==="staff_schedule_can_send")return {data:false,error:null};
   if(name==="staff_schedule_finish_delivery")return {data:true,error:null};
   return {data:null,error:null};
  });
  await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_can_send",{
    p_delivery_id:"delivery-A",p_attempt_token:"token-A",
  });
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_finish_delivery",{
    p_delivery_id:"delivery-A",p_attempt_token:"token-A",p_state:"failed",
    p_wamid:null,p_error:"revoked_before_send",
  });
  expect(mocks.send).not.toHaveBeenCalled();
 });
 it("no provider retransmission for a previously accepted or ambiguous receipt",async()=>{
  for(const status of ["sent","uncertain","sending"]){
   const f=dbFixture(status);mocks.admin.mockReturnValue(f.db);
   await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
   expect(f.rpc.mock.calls.filter(x=>x[0]==="staff_schedule_claim_delivery")).toHaveLength(0);
   expect(mocks.send).not.toHaveBeenCalled();
  }
 });
 it("an ambiguous network outcome records uncertain and never fabricates delivery",async()=>{
  const f=dbFixture();mocks.admin.mockReturnValue(f.db);
  mocks.send.mockResolvedValue({state:"uncertain",reason:"network_or_timeout_ambiguous"});
  await followUpStaffPublicationForBusiness(f.db,"cafe-A",week);
  expect(f.rpc).toHaveBeenCalledWith("staff_schedule_finish_delivery",{
   p_delivery_id:"delivery-A",p_attempt_token:"token-A",p_state:"uncertain",
   p_wamid:null,p_error:"network_or_timeout_ambiguous"});
  expect(f.operations[0]).toMatchObject({status:"needs_owner"});
 });
});
