/** Task 15B live model acceptance; never run in normal CI.
 * Requires an independent explicit owner authorization and a trusted local-only
 * disposable Supabase. This proves real maintenance investigation, NOT a send.
 * A separate approved Gmail receipt/repair end-to-end test remains mandatory.
 *
 * AICAFE_15B_AGENTIC_LIVE=1 AICAFE_15B_LIVE_OWNER_APPROVED=1
 * AICAFE_15B_LOCAL_DB_URL=postgresql://postgres:...@127.0.0.1:54322/postgres
 * NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 * SUPABASE_SERVICE_ROLE_KEY=<disposable local key> OPENAI_API_KEY=<trusted>
 * AICAFE_15B_LIVE_HEAD=<40 character exact SHA>
 * npx vitest run lib/maintenance/coordination.live.test.ts
 */
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall}
  from "@/lib/ai/supervisor/routines/investigation.liveBudget";
import {enqueueInvestigationsForOwner,processDueInvestigations,
  type InvestigationModelProofSummary}
  from "@/lib/ai/supervisor/routines/investigation.server";

const live=process.env.AICAFE_15B_AGENTIC_LIVE==="1"?it:it.skip;
const local=(raw:string|undefined,kind:"db"|"api")=>{
  if(!raw)throw new Error("15b_live_endpoint_missing");
  const u=new URL(raw);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.protocol!==(kind==="db"?"postgresql:":"http:")||
    u.port!==(kind==="db"?"54322":"54321")||
    (kind==="db"&&u.pathname!=="/postgres"))
    throw new Error("15b_live_refuses_non_disposable_endpoint");
  return raw;
};

live("real gpt-6-luna independently reads saved repair report, plans and notifies without fake effect",async()=>{
  if(process.env.AICAFE_15B_LIVE_OWNER_APPROVED!=="1")
    throw new Error("15b_live_separate_owner_authorization_missing");
  if(!process.env.OPENAI_API_KEY||!process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("15b_live_trusted_credentials_missing");
  if(configuredSupervisorModel()!=="gpt-6-luna")
    throw new Error("15b_live_model_not_luna");
  const head=process.env.AICAFE_15B_LIVE_HEAD;
  if(!/^[a-f0-9]{40}$/u.test(head??""))
    throw new Error("15b_live_exact_head_required");
  const dbUrl=local(process.env.AICAFE_15B_LOCAL_DB_URL,"db");
  const apiUrl=local(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
  const admin=new Client({connectionString:dbUrl});
  const db=createClient(apiUrl,process.env.SUPABASE_SERVICE_ROLE_KEY!,{
    auth:{persistSession:false,autoRefreshToken:false},
  });
  const scope={businessId:randomUUID(),ownerUserId:randomUUID(),
    threadId:randomUUID(),localDate:new Date().toISOString().slice(0,10)};
  const id=randomUUID(),taskId="maintenance:"+id,now=new Date();
  let connected=false,providerCompletions=0;
  let ledger=emptyInvestigationLiveLedger();
  const proof:InvestigationModelProofSummary[]=[];
  const provider:AgentProvider=async function*(params,signal){
    if(params.model!=="gpt-6-luna"||typeof params.max_output_tokens!=="number")
      throw new Error("15b_live_unexpected_model");
    ledger=reserveInvestigationLiveCall(ledger,
      Buffer.byteLength(JSON.stringify(params),"utf8"),
      params.max_output_tokens,params.model);
    for await(const event of openAIProvider(params,signal)){
      if(event.type==="response.completed"){
        if((event.response as {model?:unknown})?.model!=="gpt-6-luna")
          throw new Error("15b_live_response_model_mismatch");
        providerCompletions++;
      }
      yield event;
    }
  };
  try{
    await admin.connect();connected=true;
    await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
      "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
      [scope.ownerUserId,"15b-live-"+scope.ownerUserId+"@example.invalid"]);
    await admin.query("insert into public.businesses(id,name,timezone,is_demo) "+
      "values ($1,'Disposable repair verification cafe','America/Los_Angeles',false)",[scope.businessId]);
    await admin.query("insert into public.cafe_access(business_id,mode) "+
      "values ($1,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",
      [scope.businessId]);
    await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
      [scope.businessId,scope.ownerUserId]);
    await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) "+
      "values ($1,$2,$3,$4)",[scope.threadId,scope.businessId,scope.ownerUserId,randomUUID()]);
    await admin.query("begin");
    await admin.query("select set_config('app.maintenance_case_transition','allowed',true)");
    await admin.query("insert into public.operating_tasks "+
      "(business_id,id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence,owner_user_id) "+
      "values ($1,$2,'leo','maintenance_issue','equipment_report',$3,'needs_owner',$4,'low',$5,$6)",[
        scope.businessId,taskId,id,JSON.stringify({equipmentLabel:"Test espresso machine",
          symptom:"Owner reports the boiler is not heating. Staff cannot make hot drinks.",
          severity:"high",maintenanceStage:"reported",repairVerified:false,
          externalSent:false,reportedAt:now.toISOString()}),
        JSON.stringify([{source:"owner_report",facts:{reported:true,quality:"unverified"}}]),
        scope.ownerUserId,
      ]);
    await admin.query("insert into public.maintenance_case_events "+
      "(business_id,task_id,idempotency_key,kind,actor_kind,actor_user_id,source_kind,source_id,note) "+
      "values ($1,$2,$3,'report','owner',$4,'owner_report',$5,$6)",[
        scope.businessId,taskId,"report:"+id,scope.ownerUserId,id,"Machine not heating",
      ]);
    await admin.query("commit");
    expect(await enqueueInvestigationsForOwner(db,scope,now)).toBe(1);
    const turn=await processDueInvestigations(db,now,2,provider,p=>proof.push(p));
    if(turn.failed){
      const failure=await admin.query("select phase,last_error from public.supervisor_investigations "+
        "where business_id=$1 and source_id=$2",[scope.businessId,taskId]);
      console.error("15b_live_failed_stage",JSON.stringify({
        head,phase:failure.rows[0]?.phase,reason:failure.rows[0]?.last_error,
        calls:ledger.calls,providerCompletions,
      }));
    }
    expect(turn).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({verified:true,externalEffectClaim:false,
      unverifiedCount:0,failureCode:null});
    expect(proof[0].toolNames[0]).toBe("get_investigation_source");
    expect(proof[0].toolNames.length).toBeGreaterThanOrEqual(3);
    expect(providerCompletions).toBeGreaterThanOrEqual(2);
    const saved=await admin.query("select status,resolved_at,payload from public.operating_tasks "+
      "where business_id=$1 and id=$2",[scope.businessId,taskId]);
    expect(saved.rows[0]).toMatchObject({status:"needs_owner",resolved_at:null});
    expect(saved.rows[0].payload).toMatchObject({externalSent:false,repairVerified:false});
    const receipts=await admin.query("select kind from public.maintenance_case_events "+
      "where business_id=$1 and task_id=$2",[scope.businessId,taskId]);
    expect(receipts.rows.map(r=>r.kind)).toEqual(["report"]);
    const owner=await admin.query("select role,grounding->>'intent' intent from public.ai_messages "+
      "where business_id=$1 and thread_id=$2",[scope.businessId,scope.threadId]);
    expect(owner.rows.some(r=>r.role==="supervisor"&&r.intent==="priority_investigation")).toBe(true);
    console.log("15b_live_source_model_notice_verified",JSON.stringify({
      head,model:"gpt-6-luna",providerCompletions,toolNames:proof[0].toolNames,
      source:"maintenance_case_events",effect:"none_without_owner_approval",
    }));
  }finally{
    if(connected){
      await admin.query("rollback").catch(()=>{});
      await admin.query("delete from public.businesses where id=$1",[scope.businessId]).catch(()=>{});
      await admin.query("delete from auth.users where id=$1",[scope.ownerUserId]).catch(()=>{});
      await admin.end().catch(()=>{});
    }
  }
});
