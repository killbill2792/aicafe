import "server-only";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ConversationMessage,ConversationScope} from "@/lib/ai/conversations/contracts";

type HistoricalRoutineReport={
  messageId:string;runId:string;routineId:string;revision:number;
  quality:"verified"|"partial";text:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&
  typeof v==="object"&&!Array.isArray(v);
const reportId=(runId:string)=>{
  const digest=createHash("md5").update("u4-objective-report:"+runId).digest("hex");
  return digest.slice(0,8)+"-"+digest.slice(8,12)+"-"+digest.slice(12,16)+"-"+
    digest.slice(16,20)+"-"+digest.slice(20);
};

/** Marker discovery is NOT enough to trust historical model output. A later
 * scoped occurrence+routine read must prove the same completed DB transaction. */
export function routineReportCandidates(messages:readonly ConversationMessage[],
  threadId:string,ownerCreatedAt:string):HistoricalRoutineReport[]{
  const before=Date.parse(ownerCreatedAt);
  if(!Number.isFinite(before))return [];
  return messages.filter(m=>m.role==="supervisor"&&m.threadId===threadId&&
    m.contentType==="blocks"&&Date.parse(m.createdAt)<=before)
    .slice(-8).flatMap(m=>{
      if(!object(m.grounding)||m.grounding.intent!=="operating_tasks"||
        !["verified","partial"].includes(String(m.grounding.status))||
        !object(m.grounding.agentMetadata)||!Array.isArray(m.blocks))return [];
      const meta=m.grounding.agentMetadata;
      if(typeof meta.runId!=="string"||!uuid.test(meta.runId)||
        typeof meta.routineId!=="string"||!uuid.test(meta.routineId)||
        typeof meta.revision!=="number"||!Number.isSafeInteger(meta.revision)||meta.revision<1||
        !["watch","routine"].includes(String(meta.u4Kind))||
        meta.externalEffects!=="not_attempted"||m.id!==reportId(meta.runId))
        return [];
      // SQL inserts only bounded plain text blocks. Unexpected block types
      // never enter the next model turn as trusted historical context.
      if(!m.blocks.length||!m.blocks.every(b=>object(b)&&b.type==="text"&&
        typeof b.text==="string"&&b.text.length>=1&&b.text.length<=1200))return [];
      const text=m.blocks.map(b=>(b as {text:string}).text).join("");
      if(!text.trim()||text.length>2600)return [];
      return [{messageId:m.id,runId:meta.runId,routineId:meta.routineId,
        revision:Number(meta.revision),quality:m.grounding.status as "verified"|"partial",
        text}];
    });
}

/** Historical context only; never upgrades past claims to live facts, Gmail
 * permissions, numeric evidence, approval or an effect mandate. */
export async function verifiedRoutineReportHistory(db:SupabaseClient,
  scope:ConversationScope,threadId:string,
  candidates:readonly HistoricalRoutineReport[]):Promise<Set<string>>{
  const verified=new Set<string>();
  if(candidates.length===0)return verified;
  const reports=candidates.slice(-8);
  const [routines,occurrences]=await Promise.all([
    db.from("supervisor_routines").select("id,owner_user_id,thread_id,execution_mode")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",threadId)
      .in("id",[...new Set(reports.map(r=>r.routineId))]).limit(8),
    db.from("supervisor_routine_occurrences")
      .select("routine_id,run_id,revision,state,receipt_ref,u4_result")
      .eq("business_id",scope.businessId)
      .in("run_id",[...new Set(reports.map(r=>r.runId))]).limit(8),
  ]);
  if(routines.error||occurrences.error)return verified;
  const scoped=new Set((routines.data??[]).filter(r=>
    r.owner_user_id===scope.ownerUserId&&r.thread_id===threadId&&
    ["objective","watch"].includes(String(r.execution_mode))).map(r=>String(r.id)));
  const rows=(occurrences.data??[]) as Array<Record<string,unknown>>;
  for(const report of reports){
    if(!scoped.has(report.routineId))continue;
    const occurrence=rows.find(o=>o.routine_id===report.routineId&&
      o.run_id===report.runId&&o.revision===report.revision&&
      o.state==="completed"&&o.receipt_ref==="u4-verified:"+report.runId);
    const result=occurrence?.u4_result;
    if(!object(result)||typeof result.summary!=="string"||
      !object(result.proof)||result.proof.quality!==report.quality||
      result.proof.externalEffects!=="not_attempted")continue;
    const summary=result.summary.trim();
    if(!summary||!report.text.startsWith(summary))continue;
    verified.add(report.messageId);
  }
  return verified;
}
