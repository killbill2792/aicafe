import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

/** The one reader of Supervisor experiments for the owner: the chat's
 * experiment panel and the Operating Board both use it, so they always list
 * the same proposals and reports. Always scoped to the café and the owner. */
const PROPOSAL_COLUMNS="id,thread_id,capability_id,revision,status,canonical_effect_payload,baseline,"+
  "monitor_spec,monitoring_start_date,created_at";
export type OwnerScope={businessId:string;ownerUserId:string};
export type OwnerProposalRow={id:string;thread_id:string;capability_id:string;revision:number;status:string;
  canonical_effect_payload:unknown;baseline:unknown;monitor_spec:unknown;monitoring_start_date:string|null;created_at:string};
export type OwnerReportRow={proposal_id:string;status:string;report:unknown;generated_at:string};

export async function readOwnerProposals(db:SupabaseClient,scope:OwnerScope,
  filter:{threadId?:string;id?:string;capabilityId?:string;capabilityIds?:readonly string[];statuses?:readonly string[];limit:number;offset?:number}):Promise<OwnerProposalRow[]>{
  let q=db.from("supervisor_proposals").select(PROPOSAL_COLUMNS)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
  if(filter.threadId)q=q.eq("thread_id",filter.threadId);
  if(filter.capabilityId)q=q.eq("capability_id",filter.capabilityId);
  if(filter.capabilityIds)q=q.in("capability_id",[...filter.capabilityIds]);
  if(filter.id)q=q.eq("id",filter.id);
  if(filter.statuses)q=q.in("status",[...filter.statuses]);
  const ordered=q.order("created_at",{ascending:false}).order("id",{ascending:false});
  const {data,error}=await (filter.offset===undefined?ordered.limit(filter.limit):
    ordered.range(filter.offset,filter.offset+filter.limit-1));
  if(error)throw error;
  return (data??[]) as unknown as OwnerProposalRow[];
}

/** Final reports for the given proposals, newest first. Reports are only
 * returned for proposals the caller already read through readOwnerProposals. */
export async function readOwnerReports(db:SupabaseClient,scope:OwnerScope,proposalIds:readonly string[],
  filter:{statuses?:readonly string[];limit:number;offset?:number}):Promise<OwnerReportRow[]>{
  if(!proposalIds.length)return [];
  let q=db.from("supervisor_reports").select("proposal_id,status,report,generated_at")
    .eq("business_id",scope.businessId).in("proposal_id",[...proposalIds]);
  if(filter.statuses)q=q.in("status",[...filter.statuses]);
  const ordered=q.order("generated_at",{ascending:false}).order("proposal_id",{ascending:false});
  const {data,error}=await (filter.offset===undefined?ordered.limit(filter.limit):
    ordered.range(filter.offset,filter.offset+filter.limit-1));
  if(error)throw error;
  return (data??[]) as OwnerReportRow[];
}

/** Paginate the existing owner-scoped proposal reader, restricted to price capabilities
 * and monitoring statuses BEFORE the page limit, so unrelated proposals cannot
 * hide a running price change. No second query implementation. */
export async function readOwnerPriceMonitorProposals(db:SupabaseClient,scope:OwnerScope,
  capabilityIds:readonly string[],statuses:readonly string[]):Promise<OwnerProposalRow[]>{
  const pageSize=100;
  const rows:OwnerProposalRow[]=[];
  for(let offset=0;;offset+=pageSize){
    const page=await readOwnerProposals(db,scope,{capabilityIds,statuses,limit:pageSize,offset});
    rows.push(...page);
    if(page.length<pageSize)return rows;
  }
}

/** The canonical owner report reader, paged by the owner-scoped price proposal IDs.
 * Filter to final reports before each page; do not truncate older monitor results. */
export async function readOwnerPriceMonitorReports(db:SupabaseClient,scope:OwnerScope,
  proposalIds:readonly string[],statuses:readonly string[]):Promise<OwnerReportRow[]>{
  const rows:OwnerReportRow[]=[];
  const pageSize=100;
  // Keep URL/SQL IN lists bounded without losing proposals after the first batch.
  for(let i=0;i<proposalIds.length;i+=pageSize){
    const ids=proposalIds.slice(i,i+pageSize);
    for(let offset=0;;offset+=pageSize){
      const page=await readOwnerReports(db,scope,ids,{statuses,limit:pageSize,offset});
      rows.push(...page);
      if(page.length<pageSize)break;
    }
  }
  return rows;
}
