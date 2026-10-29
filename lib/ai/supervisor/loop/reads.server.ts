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
  filter:{threadId?:string;id?:string;statuses?:readonly string[];limit:number}):Promise<OwnerProposalRow[]>{
  let q=db.from("supervisor_proposals").select(PROPOSAL_COLUMNS)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
  if(filter.threadId)q=q.eq("thread_id",filter.threadId);
  if(filter.id)q=q.eq("id",filter.id);
  if(filter.statuses)q=q.in("status",[...filter.statuses]);
  const {data,error}=await q.order("created_at",{ascending:false}).limit(filter.limit);
  if(error)throw error;
  return (data??[]) as unknown as OwnerProposalRow[];
}

/** Final reports for the given proposals, newest first. Reports are only
 * returned for proposals the caller already read through readOwnerProposals. */
export async function readOwnerReports(db:SupabaseClient,scope:OwnerScope,proposalIds:readonly string[],
  filter:{statuses?:readonly string[];limit:number}):Promise<OwnerReportRow[]>{
  if(!proposalIds.length)return [];
  let q=db.from("supervisor_reports").select("proposal_id,status,report,generated_at")
    .eq("business_id",scope.businessId).in("proposal_id",[...proposalIds]);
  if(filter.statuses)q=q.in("status",[...filter.statuses]);
  const {data,error}=await q.order("generated_at",{ascending:false}).limit(filter.limit);
  if(error)throw error;
  return (data??[]) as OwnerReportRow[];
}
