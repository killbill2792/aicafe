/** U4 owner-gated real Luna objective acceptance.
 * This is NOT a no-provider unit test and never executes during normal CI.
 * A trusted shared-Luna host alone authorizes the provider/cost ceiling and
 * independently inspects the unchanged disposable Postgres source, owner
 * report, budget and cross-café isolation after this test finishes.
 */
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall}
  from "./investigation.liveBudget";
import {createOwnerRoutine,claimRoutineOccurrence} from "./repository.server";
import {executeClaimedObjective} from "./objective.server";

const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&
  process.env.AICAFE_SHARED_LUNA_SCENARIO==="u4-autonomous-objectives";
const live=enabled?it:it.skip;
const guard=(raw:string|undefined,kind:"postgres"|"api")=>{
  if(!raw)throw Error("u4_live_endpoint_missing");
  const u=new URL(raw);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.protocol!==(kind==="postgres"?"postgresql:":"http:")||
    u.port!==(kind==="postgres"?"54322":"54321")||
    (kind==="postgres"&&u.pathname!=="/postgres"))
    throw Error("u4_live_non_disposable_endpoint");
  return raw;
};

live("real Luna executes an authenticated full café goal through existing scheduled work",async()=>{
  const env=process.env;
  if(env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||
    env.AI_CAFE_LIVE_ACCEPTANCE!=="OWNER_APPROVED_LOCAL_ONLY"||
    !/^[0-9a-f]{40}$/u.test(env.AICAFE_SHARED_LUNA_HEAD??"")||
    !env.OPENAI_API_KEY||!env.SUPABASE_SERVICE_ROLE_KEY)
    throw Error("u4_live_trusted_owner_gate_required");
  if(configuredSupervisorModel()!=="gpt-6-luna")
    throw Error("u4_live_real_luna_required");
  const dbURL=guard(env.ACCEPTANCE_DATABASE_URL,"postgres");
  const apiURL=guard(env.NEXT_PUBLIC_SUPABASE_URL,"api");
  vi.stubEnv("SUPERVISOR_U4_ENABLED","true");
  const pg=new Client({connectionString:dbURL});
  const db=createClient(apiURL,env.SUPABASE_SERVICE_ROLE_KEY!,{
    auth:{persistSession:false,autoRefreshToken:false},
  });
  let connected=false,providerCompletions=0;
  let budget=emptyInvestigationLiveLedger();
  const threadId=randomUUID(),ownerMessageId=randomUUID();
  let routineId="";
  const originalGoal="Every morning review the café's actual recent sales and "+
    "inventory. Independently read both relevant sources, explain important "+
    "changes and missing coverage, and recommend the next owner action if "+
    "warranted. Do not spend, message, schedule or change anything.";
  const provider:AgentProvider=async function*(params,signal){
    if(params.model!=="gpt-6-luna")throw Error("u4_live_wrong_model");
    const requested=typeof params.max_output_tokens==="number"?
      params.max_output_tokens:1200;
    const paid={...params,max_output_tokens:Math.min(requested,1200)};
    budget=reserveInvestigationLiveCall(budget,
      Buffer.byteLength(JSON.stringify(paid),"utf8"),
      paid.max_output_tokens,"gpt-6-luna");
    for await(const event of openAIProvider(paid,signal)){
      if(event.type==="response.completed"){
        if((event.response as {model?:unknown})?.model!=="gpt-6-luna")
          throw Error("u4_live_model_receipt_wrong");
        providerCompletions++;
      }
      yield event;
    }
  };
  try{
    await pg.connect();connected=true;
    const cafes=(await pg.query("select b.id,b.timezone,m.user_id from public.businesses b "+
      "join public.memberships m on m.business_id=b.id and m.role='owner' "+
      "join public.cafe_access a on a.business_id=b.id "+
      "where a.mode='grandfathered' order by b.id limit 2")).rows;
    if(cafes.length<2||cafes[0].id===cafes[1].id)
      throw Error("u4_live_requires_two_disposable_cafes");
    const [own,foreign]=cafes;
    const businessId=String(own.id),ownerUserId=String(own.user_id);
    const foreignBusinessId=String(foreign.id);
    const sourceCounts=await pg.query(
      "select (select count(*)::int from public.daily_rollups where business_id=$1) sales,"+
      "(select count(*)::int from public.ingredients where business_id=$1) stock",
      [businessId]);
    if(sourceCounts.rows[0].sales<1||sourceCounts.rows[0].stock<1)
      throw Error("u4_live_independent_sales_stock_seed_missing");
    await pg.query("insert into public.ai_threads "+
      "(id,business_id,owner_user_id,client_request_id,title) values "+
      "($1,$2,$3,$4,'U4 actual saved autonomous objective')",
      [threadId,businessId,ownerUserId,randomUUID()]);
    await pg.query("insert into public.ai_messages "+
      "(id,business_id,owner_user_id,thread_id,author_user_id,role,"+
      "content_type,text_content,client_message_id) values "+
      "($1,$2,$3,$4,$3,'owner','text',$5,$6)",
      [ownerMessageId,businessId,ownerUserId,threadId,originalGoal,randomUUID()]);
    const due=(await pg.query("select "+
      "to_char((now()-interval '1 hour') at time zone $1,'YYYY-MM-DD') day,"+
      "to_char((now()-interval '1 hour') at time zone $1,'HH24:MI') local_time,"+
      "(now()-interval '1 hour')::timestamptz scheduled",
      [own.timezone])).rows[0];
    const routine=await createOwnerRoutine({
      title:"Real cross-domain daily review",cadence:"daily",
      weekdays:[],localTime:due.local_time,
    },{scope:{businessId,ownerUserId},threadId,ownerMessageId,client:db});
    routineId=routine.id;
    expect(routine).toMatchObject({executionMode:"objective",
      objectiveText:originalGoal,objectiveSourceMessageId:ownerMessageId});
    // The schedule was genuinely recorded above; simulate time passing in
    // this disposable DB before its scheduled occurrence was due. Never
    // manipulate the production clock or an actual owner's objective.
    await pg.query("update public.supervisor_routines set updated_at=now()-interval '2 hours' "+
      "where business_id=$1 and id=$2",[businessId,routineId]);
    const leased=await claimRoutineOccurrence(db,{
      businessId,routineId,revision:routine.revision,
      localDate:due.day,dueAt:new Date(due.scheduled),
      now:new Date(),
    });
    if(!leased)throw Error("u4_live_unable_to_claim_real_occurrence");
    const result=await executeClaimedObjective(db,{
      routine,lease:leased,localDate:due.day,provider,
    });
    expect(result.attention).toBe("attention");
    expect(result.sourceCount).toBeGreaterThanOrEqual(2);
    expect(result.observedToolNames).toContain("get_sales");
    expect(result.observedToolNames).toContain("get_inventory");
    expect(providerCompletions).toBe(budget.calls);
    expect(providerCompletions).toBeGreaterThanOrEqual(2);
    const occurrence=(await pg.query("select state,receipt_ref,u4_result from "+
      "public.supervisor_routine_occurrences where business_id=$1 and run_id=$2",
      [businessId,leased.runId])).rows;
    expect(occurrence).toHaveLength(1);
    expect(occurrence[0].state).toBe("completed");
    expect(occurrence[0].receipt_ref).toBe("u4-verified:"+leased.runId);
    expect(occurrence[0].u4_result?.proof?.sourceCount).toBeGreaterThanOrEqual(2);
    const posts=(await pg.query("select id,grounding,structured_content from "+
      "public.ai_messages where business_id=$1 and thread_id=$2 "+
      "and role='supervisor' and grounding->>'intent'='u4_routine'",
      [businessId,threadId])).rows;
    expect(posts).toHaveLength(1);
    expect(posts[0].grounding?.agentMetadata?.runId).toBe(leased.runId);
    expect(posts[0].structured_content?.filter((x:{type:string})=>x.type==="text")
      .map((x:{text:string})=>x.text).join("")).toBe(result.report);
    // No owner requested this second task. The service-created daily Watch
    // uses the SAME occurrence identity, registered model/tool loop, quota
    // and fenced receipt contract, but the original owner message is NULL.
    const watchCreated=await db.rpc("u4_ensure_watch_routine",{
      p_business_id:businessId,p_owner_user_id:ownerUserId,
      p_thread_id:threadId,p_local_time:due.local_time,
    });
    if(watchCreated.error||typeof watchCreated.data!=="string")
      throw Error("u4_live_system_watch_not_created");
    const watchRoutineId=watchCreated.data;
    const watchRows=(await pg.query("select * from public.supervisor_routines "+
      "where business_id=$1 and id=$2",
      [businessId,watchRoutineId])).rows;
    expect(watchRows).toHaveLength(1);
    const wr=watchRows[0];
    expect(wr).toMatchObject({execution_mode:"watch",
      objective_source_message_id:null});
    await pg.query("update public.supervisor_routines set updated_at=now()-interval '2 hours' "+
      "where business_id=$1 and id=$2",[businessId,watchRoutineId]);
    const watchLease=await claimRoutineOccurrence(db,{
      businessId,routineId:watchRoutineId,revision:Number(wr.revision),
      localDate:due.day,dueAt:new Date(due.scheduled),now:new Date(),
    });
    if(!watchLease)throw Error("u4_live_watch_claim_unavailable");
    const watchOutcome=await executeClaimedObjective(db,{
      routine:{
        id:watchRoutineId,businessId,ownerUserId,threadId,title:wr.title,
        cadence:"daily",weekdays:[],localTime:String(wr.local_time).slice(0,5),
        timezone:wr.timezone,status:"active",revision:Number(wr.revision),
        createdAt:String(wr.created_at),updatedAt:String(wr.updated_at),
        executionMode:"watch",objectiveText:wr.objective_text,
        objectiveSourceMessageId:null,objectiveUpdates:[],
      },lease:watchLease,localDate:due.day,provider,
    });
    expect(["attention","none"]).toContain(watchOutcome.attention);
    expect(watchOutcome.sourceCount).toBeGreaterThanOrEqual(1);
    const watchReceipt=(await pg.query("select state,receipt_ref,u4_result "+
      "from public.supervisor_routine_occurrences where business_id=$1 and run_id=$2",
      [businessId,watchLease.runId])).rows;
    expect(watchReceipt).toHaveLength(1);
    expect(watchReceipt[0].state).toBe("completed");
    expect(watchReceipt[0].receipt_ref).toBe("u4-verified:"+watchLease.runId);
    expect(watchReceipt[0].u4_result?.attention).toBe(watchOutcome.attention);
    expect(providerCompletions).toBe(budget.calls);
    const spend=(await pg.query("select model,status,model_call_count "+
      "from public.supervisor_system_usage_events where business_id=$1 "+
      "and owner_user_id=$2 and source_type='routine' and source_id=any($3::text[])",
      [businessId,ownerUserId,[leased.runId,watchLease.runId]])).rows;
    expect(spend).toHaveLength(budget.calls);
    expect(spend.every(x=>x.model==="gpt-6-luna"&&x.status==="completed"&&
      Number(x.model_call_count)===1)).toBe(true);
    const proposals=(await pg.query("select count(*)::int n from public.supervisor_proposals "+
      "where business_id=$1 and thread_id=$2",[businessId,threadId])).rows[0].n;
    expect(proposals).toBe(0);
    const proof={schema_version:1,id:"u4-autonomous-objectives",
      head_sha:env.AICAFE_SHARED_LUNA_HEAD,status:"passed",
      observed_model:"gpt-6-luna",observed_model_calls:providerCompletions,
      selected_sources:[...new Set([...result.observedToolNames,...watchOutcome.observedToolNames])],
      unprompted_watch_persisted:true,watch_significance:watchOutcome.attention,
      original_goal_preserved:true,no_unauthorized_effect:true,
      persisted_lease_and_report:true,cross_domain_source_count:result.sourceCount,
      integrated_proven:false,released_proven:false};
    mkdirSync("test-results/acceptance",{recursive:true});
    writeFileSync("test-results/acceptance/u4-autonomous-objectives-proof.json",
      JSON.stringify(proof,null,2)+"\n",{mode:0o600});
    writeFileSync("test-results/acceptance/u4-autonomous-objectives-scope.json",
      JSON.stringify({
        businessId,foreignBusinessId,ownerUserId,threadId,ownerMessageId,
        routineId,runId:leased.runId,replyId:posts[0].id,
        watchRoutineId,watchRunId:watchLease.runId,
        expectedProviderCalls:budget.calls,
      },null,2)+"\n",{mode:0o600});
  }finally{
    if(connected)await pg.end();
    vi.unstubAllEnvs();
  }
},300_000);
