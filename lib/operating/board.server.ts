import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {buildOperatingBoard,type BoardProposalRow,type BoardReportRow,type OperatingBoard} from "./board";

/** Reads with the owner's own session: row level security limits rows to the
 * owner's experiments in this café. A failed read shows an empty board, never
 * another café's rows. */
export async function readOperatingBoard(db:SupabaseClient,businessId:string,today:string):Promise<OperatingBoard>{
  const [proposals,reports]=await Promise.all([
    db.from("supervisor_proposals")
      .select("id,thread_id,status,capability_id,canonical_effect_payload,monitor_spec,monitoring_start_date")
      .eq("business_id",businessId).in("status",["manual_pending","manual_confirmed","committed","monitored"])
      .order("created_at",{ascending:false}).limit(30),
    db.from("supervisor_reports").select("proposal_id,status,report,generated_at")
      .eq("business_id",businessId).in("status",["complete","insufficient_evidence"])
      .order("generated_at",{ascending:false}).limit(10),
  ]);
  if(proposals.error||reports.error)return {running:[],recentReports:[]};
  return buildOperatingBoard((proposals.data??[]) as BoardProposalRow[],(reports.data??[]) as BoardReportRow[],today);
}
