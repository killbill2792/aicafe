import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { classifyOwnerQuestion,TOPIC_VERSION } from "@/lib/admin/topics";
const BATCH=200;
export type ClassifierStore={
  nextBatch:(version:number,limit:number)=>Promise<{id:string;question:string}[]>;
  apply:(rows:{id:string;topic:string}[])=>Promise<number>;
};
/** Runs at most 10 bounded batches per cron invocation. Each update is idempotent.
 * On a missed day the next run catches up; no owner chat is delayed. */
export async function classifyPendingTurns(store:ClassifierStore,maxBatches=10){
  let processed=0,batches=0;
  for(;batches<maxBatches;batches++){
    const pending=await store.nextBatch(TOPIC_VERSION,BATCH);
    if(!pending.length)break;
    const rows=pending.map(r=>({id:r.id,topic:classifyOwnerQuestion(r.question)}));
    processed+=await store.apply(rows);
    if(pending.length<BATCH){batches++;break;}
  }
  return {processed,batches,remainingPossible:batches>=maxBatches};
}
export function supabaseClassifierStore():ClassifierStore {
  const db=createAdminSupabaseClient();
  return {
    async nextBatch(version,limit){
      const {data,error}=await db.from("agent_turn_logs").select("id,question")
        .lt("topic_version",version).order("started_at",{ascending:true}).limit(limit);
      if(error)throw error;
      return data??[];
    },
    async apply(rows){
      if(!rows.length)return 0;
      const {data,error}=await db.rpc("admin_classify_turns",{p_rows:rows});
      if(error)throw error;
      return Number(data??0);
    },
  };
}
