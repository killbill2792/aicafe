import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {gmailCapabilityId,readMaintenanceCase,type GmailProposalInput} from "./gmail.server";
import {gmailRead,gmailSearch,gmailReadThread} from "@/lib/connectors/gmail/provider.server";
import {getConnectorAccount,allowsGmail} from "@/lib/connectors/registry.server";
import {proposeLoop,registerLoopCapability,effectHash,type OwnerLoopScope} from "./engine";
import {simulationOwnerReader} from "./simulationOwner.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {SupabaseLoopRepository} from "./supabase.server";
import {proposalRequestKey} from "./requestKeys";

export type MaintenanceVendorRequest={caseId:string;recipient:string;contactMessageId:string|null;
 subject:string;body:string;dueAt:string|null};
export const maintenanceStaffCapabilityId="leo.maintenance_staff_assignment.v1";
export const maintenanceAssignmentInput=z.strictObject({
 maintenanceCaseId:z.string().regex(/^maintenance:[0-9a-f-]{36}$/i),
 employeeId:z.uuid(),prompt:z.string().trim().min(1).max(1200),
 purpose:z.enum(["task","verify_working"]),dueAt:z.iso.datetime({offset:true}).nullable()
});
export const maintenanceAssignmentEffect=maintenanceAssignmentInput.extend({
 maintenanceCaseRevision:z.iso.datetime({offset:true}),employeeName:z.string().min(1).max(200),
 equipmentLabel:z.string().min(1).max(120),
});
export type MaintenanceStaffRequest=z.infer<typeof maintenanceAssignmentInput>;
export const maintenanceStaffCapability=registerLoopCapability({
 id:maintenanceStaffCapabilityId,version:1,inputSchema:maintenanceAssignmentInput,effectSchema:maintenanceAssignmentEffect,
 proposalDescription:"Prepare exact staff task or independent operational check for owner approval, never dispatch automatically.",
 dependencyScope:e=>({maintenanceCaseId:e.maintenanceCaseId,employeeId:e.employeeId,hash:effectHash(e)}),
 simulate:async(scope,input)=>{
  const {client}=await simulationOwnerReader(scope);
  const row=await readMaintenanceCase(scope,client,input.maintenanceCaseId);
  const employee=await client.from("employees").select("id,display_name,active,staff_auth_user_id")
   .eq("business_id",scope.businessId).eq("id",input.employeeId).maybeSingle();
  if(employee.error||!employee.data?.active||!employee.data.staff_auth_user_id||
     (input.purpose==="verify_working"&&row.payload?.maintenanceStage!=="repair_claimed")||
     (input.dueAt&&Date.parse(input.dueAt)<=Date.now()))throw new Error("maintenance_assignment_source_unavailable");
  const effect={...input,maintenanceCaseRevision:row.updated_at,employeeName:employee.data.display_name,
   equipmentLabel:String(row.payload?.equipmentLabel??"Equipment")};
  return {effect,baseline:{source:"maintenance_staff_assignment",employeeName:effect.employeeName},
   monitorSpec:{durationDays:1,metricScope:"maintenance_staff_receipt"}};
 },
 commit:async(scope,effect,proposalId)=>{
  if(!proposalId)throw new Error("maintenance_assignment_proposal_required");
  const {data,error}=await createAdminSupabaseClient().rpc("maintenance_commit_staff_assignment",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(error?.code==="40001"){
   const stale=new Error("maintenance_case_changed");stale.name="StaleProposalError";throw stale;
  }
  if(error||typeof data?.id!=="string")throw new Error("maintenance_assignment_not_verified");
  return {status:"verified",evidenceSource:"staff_communication_requests"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{assignmentReceiptOnly:true,repairVerified:false},
  recommendation:"keep",source:"staff_communication_requests"}),
});
export type MaintenanceLease={caseId:string;token:string;revisionHash:string};
type MaintenanceContextOptions={lease?:MaintenanceLease;ownerMessage?:{id:string;text:string}};
/** Exact mailbox, no display-name guesses, header lists or embedded commands. */
export function singleMailbox(raw:string|undefined):string|null{
 if(!raw||/[\r\n]/u.test(raw))return null;
 const bracket=raw.match(/^[^<>,;]*<([^<>]+)>\s*$/u);
 const email=(bracket?.[1]??raw).trim().toLowerCase();
 if(!z.email().safeParse(email).success)return null;
 return email;
}
async function assertLease(db:SupabaseClient,scope:OwnerLoopScope,lease:MaintenanceLease,caseId:string){
 if(lease.caseId!==caseId)throw new Error("maintenance_case_scope_mismatch");
 const r=await db.from("supervisor_investigations").select("lease_token")
  .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
  .eq("thread_id",scope.threadId).eq("source_type","operating_task").eq("source_id",caseId)
  .eq("lease_token",lease.token).eq("revision_hash",lease.revisionHash)
  .gt("lease_until",new Date().toISOString()).maybeSingle();
 if(r.error||!r.data)throw new Error("maintenance_lease_unavailable");
}
export function maintenanceContext(db:SupabaseClient,scope:OwnerLoopScope,options:MaintenanceContextOptions){
 const check=async(id:string)=>{
  if(options.lease)await assertLease(db,scope,options.lease,id);
  return readMaintenanceCase(scope,db,id);
 };
 return {
  staff:async(caseId:string)=>{
   await check(caseId);
   const rows=await db.from("employees").select("id,display_name").eq("business_id",scope.businessId)
    .eq("active",true).not("staff_auth_user_id","is",null).order("display_name").limit(51);
   if(rows.error)throw rows.error;
   await check(caseId);
   return {employees:(rows.data??[]).slice(0,50).map(e=>({id:e.id,name:e.display_name})),
    truncated:(rows.data??[]).length>50};
  },
  proposeStaff:async(input:MaintenanceStaffRequest)=>{
   await check(input.maintenanceCaseId);
   const {supervisorLoopRegistry}=await import("./priceExperiment.server");
   const key=proposalRequestKey(scope.threadId,JSON.stringify(options.lease?
    {maintenance:input.maintenanceCaseId,revision:options.lease.revisionHash,kind:"staff"}:
    {maintenance:input.maintenanceCaseId,ownerMessageId:options.ownerMessage?.id,kind:"staff",input}));
   const p=await proposeLoop(scope,supervisorLoopRegistry,new SupabaseLoopRepository(),maintenanceStaffCapabilityId,input,key);
   if(p.status!=="draft")throw new Error("maintenance_approval_not_draft");
   return {proposalId:p.id,revision:p.revision,caseId:input.maintenanceCaseId};
  },
  recordRepairClaim:async(caseId:string,eventId:string)=>{
   if(!options.lease)throw new Error("maintenance_worker_only");
   await check(caseId);
   const {data,error}=await db.rpc("maintenance_record_evidence_claim",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
    p_task_id:caseId,p_lease_token:options.lease.token,p_event_id:eventId
   });
   if(error||data!==true)throw new Error("maintenance_claim_unavailable");
   return {caseId,repairClaimRecorded:true,repairVerified:false};
  },
  search:async(caseId:string,query:string)=>{
   await check(caseId);
   const result=await gmailSearch(scope,query,5);
   await check(caseId);
   return {...result,caseId,source:"maintenance_vendor_search",evidenceOnly:true};
  },
  propose:async(input:MaintenanceVendorRequest)=>{
   const row=await check(input.caseId);
   const recipient=input.recipient.toLowerCase();
   if(input.contactMessageId){
    const source=await gmailRead(scope,input.contactMessageId);
    if(source.message.id!==input.contactMessageId||
       singleMailbox(source.message.headers.from)!==recipient||
       source.account.toLowerCase()===recipient)
      throw new Error("maintenance_vendor_contact_unverified");
   }else{
    // A system turn never supplies owner text. Only the actual explicit
    // owner turn may name a recipient that has no earlier Gmail evidence.
    const addresses=options.ownerMessage?.text.match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+/gu)??[];
    if(options.lease||!addresses.some(value=>singleMailbox(value.replace(/[.!?]+$/u,""))===recipient))
      throw new Error("maintenance_vendor_contact_unverified");
   }
   const current=await check(input.caseId);
   if(current.updated_at!==row.updated_at)throw new Error("maintenance_case_changed");
   const key=proposalRequestKey(scope.threadId,JSON.stringify(options.lease?
    {maintenance:input.caseId,revision:options.lease.revisionHash,kind:"vendor"}:
    {maintenance:input.caseId,ownerMessageId:options.ownerMessage?.id,kind:"vendor",input}));
   const effect:GmailProposalInput={operation:"send",action:null,to:[recipient],cc:[],bcc:[],
    subject:input.subject,body:input.body,messageId:null,threadId:null,labelId:null,labelName:null,
    maintenanceCaseId:input.caseId,maintenanceCaseRevision:row.updated_at,maintenanceDueAt:input.dueAt};
   const {supervisorLoopRegistry}=await import("./priceExperiment.server");
   const p=await proposeLoop(scope,supervisorLoopRegistry,new SupabaseLoopRepository(),gmailCapabilityId,effect,key);
   if(p.status!=="draft")throw new Error("maintenance_approval_not_draft");
   return {proposalId:p.id,revision:p.revision,caseId:input.caseId};
  }
 };
}
/** Poll only case-bound, already verified send receipts from the existing
 * leased investigation. Gmail text cannot grant an effect or close a repair. */
export async function pollMaintenanceVendorReplies(db:SupabaseClient,scope:OwnerLoopScope,
 lease:MaintenanceLease):Promise<{added:number;missing:string[]}>{
 await assertLease(db,scope,lease,lease.caseId);
 await readMaintenanceCase(scope,db,lease.caseId);
 const rows=await db.from("maintenance_case_events").select("source_id")
  .eq("business_id",scope.businessId).eq("task_id",lease.caseId)
  .eq("kind","vendor_send_verified").order("occurred_at",{ascending:false}).limit(3);
 if(rows.error)throw new Error("maintenance_receipt_unavailable");
 if(!rows.data?.length)return {added:0,missing:[]};
 const account=await getConnectorAccount(scope).catch(()=>null);
 if(!account||!allowsGmail(account,"read"))return {added:0,missing:["maintenance_gmail_read_unavailable"]};
 let added=0;
 const missing=new Set<string>();
 for(const event of rows.data){
  const receipt=await db.from("connector_provider_receipts").select("id,proposal_id,account_id,account_provider_subject,provider_message_id,provider_thread_id,provider_accepted_at")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).eq("id",event.source_id)
   .eq("state","verified").eq("operation","send").maybeSingle();
  const r=receipt.data;
  if(receipt.error||!r||r.account_id!==account.id||
    (r.account_provider_subject&&r.account_provider_subject!==account.provider_subject)||!r.provider_thread_id){
    missing.add("maintenance_gmail_receipt_unavailable");continue;
  }
  const proposal=await db.from("supervisor_proposals").select("canonical_effect_payload")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("id",r.proposal_id).eq("capability_id",gmailCapabilityId).maybeSingle();
  const p=proposal.data?.canonical_effect_payload;
  if(proposal.error||p?.maintenanceCaseId!==lease.caseId||!Array.isArray(p.to)||p.to.length!==1){
    missing.add("maintenance_gmail_receipt_unavailable");continue;
  }
  try{
    await assertLease(db,scope,lease,lease.caseId);
    const result=await gmailReadThread(scope,r.provider_thread_id);
    const live=await getConnectorAccount(scope);
    if(live?.id!==account.id||live.generation!==account.generation||!allowsGmail(live,"read"))
      throw new Error("maintenance_gmail_permission_changed");
    await assertLease(db,scope,lease,lease.caseId);
    for(const message of result.messages){
      const sender=singleMailbox(message.headers.from);
      if(message.id===r.provider_message_id||message.threadId!==r.provider_thread_id||
        sender!==String(p.to[0]).toLowerCase()||!message.receivedAt||
        Date.parse(message.receivedAt)<=Date.parse(r.provider_accepted_at))continue;
      const saved=await db.rpc("maintenance_record_vendor_reply",{
        p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
        p_task_id:lease.caseId,p_lease_token:lease.token,p_receipt_id:r.id,
        p_provider_thread_id:r.provider_thread_id,p_message_id:message.id,p_sender:sender,
        p_received_at:message.receivedAt,p_note:(message.body||message.snippet).slice(0,1200)
      });
      if(saved.error)throw saved.error;
      if(saved.data===true)added++;
    }
    if(result.messages.length===12)missing.add("maintenance_reply_history_bounded");
  }catch{missing.add("maintenance_gmail_read_unavailable");}
 }
 return {added,missing:[...missing]};
}
