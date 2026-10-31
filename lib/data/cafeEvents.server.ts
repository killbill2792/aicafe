import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readOwnerProposals,readOwnerReports,type OwnerScope} from "@/lib/ai/supervisor/loop/reads.server";

export type CafeEvent={
 id:string;name:string;kind:string;startDate:string;endDate:string;
 startTime:string|null;endTime:string|null;venue:string|null;
 venueAddress:string|null;areaLabel:string|null;sourceUrl:string|null;
 status:"found"|"cancelled"|"moved";foundAt:string;lastCheckedAt:string;
 lastAttemptedAt?:string|null;lastVerifiedAt?:string|null;verificationFailedAt?:string|null;
 verificationDetails?:unknown;
};
export type EventChecklistTick={actionIndex:number;state:"done"|"dismissed"};
export type SavedEventTimeline={
 events:CafeEvent[];
 plans:Array<{proposalId:string;threadId:string;status:string;revision:number;
   startDate:string;endDate:string;eventIds?:string[];summary:string;actions:unknown;expectedBusyHours:unknown;
   factsHash:string;importance?:"high"|"medium"|"low"|null;
   reportStatus:string|null;report:unknown|null}>;
};

function assertRange(from:string,to:string){
 const day=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&
   !Number.isNaN(Date.parse(value+"T00:00:00Z"))&&
   new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
 if(!day(from)||!day(to)||from>to||
   Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z")>90*86400000)
   throw new Error("Invalid café event range");
}

/** One owner-scoped source for saved event facts. Never performs web searches. */
export async function readCafeEvents(db:SupabaseClient,businessId:string,
  from:string,to:string):Promise<CafeEvent[]>{
 assertRange(from,to);
 const {data,error}=await db.from("cafe_events")
   .select("id,name,kind,start_date,end_date,start_time,end_time,venue,venue_address,area_label,source_url,status,found_at,last_checked_at,last_verification_attempt_at,last_verified_at,verification_failed_at,verification_details")
   .eq("business_id",businessId).lte("start_date",to).gte("end_date",from)
   .order("start_date",{ascending:true}).order("id",{ascending:true}).limit(500);
 if(error)throw error;
 return (data??[]).map(row=>({
   id:row.id,name:row.name,kind:row.kind,startDate:row.start_date,endDate:row.end_date,
   startTime:row.start_time,endTime:row.end_time,venue:row.venue,
   venueAddress:row.venue_address,areaLabel:row.area_label,sourceUrl:row.source_url,
   status:row.status as CafeEvent["status"],foundAt:row.found_at,lastCheckedAt:row.last_checked_at,
   lastAttemptedAt:row.last_verification_attempt_at,lastVerifiedAt:row.last_verified_at,
   verificationFailedAt:row.verification_failed_at,verificationDetails:row.verification_details,
 }));
}
export async function readEventChecklist(db:SupabaseClient,businessId:string,
 proposalId:string):Promise<EventChecklistTick[]>{
 const {data,error}=await db.from("cafe_event_checklist").select("action_index,state")
   .eq("business_id",businessId).eq("proposal_id",proposalId).order("action_index");
 if(error)throw error;
 return (data??[]).map(row=>({actionIndex:row.action_index,state:row.state as EventChecklistTick["state"]}));
}

/** Both Supervisor chat and the future event panel use this saved-data view.
 * Plans/reports are read from the EXISTING Supervisor ledger, never copied. */
export async function readSavedEventTimeline(db:SupabaseClient,scope:OwnerScope,
  from:string,to:string):Promise<SavedEventTimeline>{
 assertRange(from,to);
 const [events,proposals]=await Promise.all([
   readCafeEvents(db,scope.businessId,from,to),
   readOwnerProposals(db,scope,{capabilityId:"alex.event_readiness.v1",limit:200}),
 ]);
 const plans=proposals.flatMap(p=>{
   const effect=p.canonical_effect_payload as Record<string,unknown>|null;
   if(!effect||typeof effect.startDate!=="string"||typeof effect.endDate!=="string"||
     effect.startDate>to||effect.endDate<from)return [];
   return [{p,effect}];
 });
 const reports=await readOwnerReports(db,scope,plans.map(x=>x.p.id),{limit:200});
 const byProposal=new Map(reports.map(r=>[r.proposal_id,r]));
 return {events,plans:plans.map(({p,effect})=>{
   const report=byProposal.get(p.id);
   return {proposalId:p.id,threadId:p.thread_id,status:p.status,revision:p.revision,
     startDate:String(effect.startDate),endDate:String(effect.endDate),
     // Preserve identity from the existing owner-scoped Supervisor proposal.
     // A legacy day-only plan without event IDs must never be assigned to an event.
     eventIds:Array.isArray(effect.eventIds)?effect.eventIds.filter(
       (id):id is string=>typeof id==="string"):[],
     summary:typeof effect.summary==="string"?effect.summary:"",
     actions:effect.actions??[],expectedBusyHours:effect.expectedBusyHours??[],
     factsHash:typeof effect.factsHash==="string"?effect.factsHash:"",
     // Optional metadata from B; old proposals remain readable without an invented rank.
     importance:effect.importance==="high"||effect.importance==="medium"||effect.importance==="low"
       ?effect.importance:null,
     reportStatus:report?.status??null,report:report?.report??null};
 })};
}
