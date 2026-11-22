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
import {dispatchRoutinesForBusiness} from "./dispatch.server";
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
  // This explicit disposable owner-approved scenario alone opts Watch in.
  // Production must not inherit Watch from the general U4 enabled flag.
  vi.stubEnv("SUPERVISOR_U4_WATCH_ENABLED","true");
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
    // Ingredients alone cannot satisfy get_inventory: that registered reader
    // requires a café-local *dated* stock count (or verified Toast receipt).
    // Seed a real row in this disposable PostgreSQL instance, then inspect
    // the SAME canonical cv_inventory view the registered tool will read.
    await pg.query("insert into public.pantry_stock_counts "+
      "(business_id,ingredient_id,count_date,quantity_base,entered_quantity,entered_unit) "+
      "select i.business_id,i.id,(now() at time zone b.timezone)::date, "+
      "0,0,i.base_unit from public.ingredients i "+
      "join public.businesses b on b.id=i.business_id "+
      "where i.business_id=$1 order by i.id limit 1 "+
      "on conflict(business_id,ingredient_id,count_date) do nothing",[businessId]);
    const observedStock=await pg.query(
      "select count(*)::int as n from public.cv_inventory "+
      "where business_id=$1 and business_date=(now() at time zone $2)::date "+
      "and source='app' and data->>'evidence_state'='dated_owner_count'",
      [businessId,own.timezone]);
    if(Number(observedStock.rows[0]?.n)<1)
      throw Error("u4_live_canonical_dated_inventory_missing");
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
      "and role='supervisor' and grounding->'agentMetadata'->>'u4Kind'='routine'",
      [businessId,threadId])).rows;
    expect(posts).toHaveLength(1);
    expect(posts[0].grounding?.agentMetadata?.runId).toBe(leased.runId);
    const receipt=posts[0].structured_content?.filter((x:{type:string})=>x.type==="text")
      .map((x:{text:string})=>x.text).join("") as string;
    expect(receipt).toContain("Open Work");
    expect(receipt).not.toBe(result.report);
    expect(posts[0].structured_content?.some((x:{type:string})=>
      x.type==="task_card")).toBe(true);
    expect(occurrence[0].u4_result?.summary).toBe(result.report);
    const work=(await pg.query("select id,kind,owner_user_id,payload from public.operating_tasks "+
      "where business_id=$1 and id=$2 and kind='u4_report'",
      [businessId,"u4:"+leased.runId])).rows;
    expect(work).toHaveLength(1);
    expect(work[0].owner_user_id).toBe(ownerUserId);
    expect(work[0].payload.runId).toBe(leased.runId);
    expect(work[0].payload.routineId).toBe(routineId);
    // Independent no-chat, no-alert, no-task café. The real refresh-derived
    // scheduler must provision Watch and call the registered Luna loop itself.
    const watchBusinessId=randomUUID(),watchOwnerUserId=randomUUID(),stockId=randomUUID();
    await pg.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
      "values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
      [watchOwnerUserId,"u4-watch-"+watchOwnerUserId+"@example.invalid"]);
    await pg.query("insert into public.businesses(id,name,timezone,currency,is_demo) "+
      "select $1,'Disposable novel Watch café',timezone,currency,false "+
      "from public.businesses where id=$2",[watchBusinessId,businessId]);
    await pg.query("insert into public.cafe_access(business_id,mode) "+
      "values($1,'grandfathered') on conflict(business_id) "+
      "do update set mode='grandfathered',access_end=null",[watchBusinessId]);
    await pg.query("insert into public.memberships(business_id,user_id,role) "+
      "values($1,$2,'owner')",[watchBusinessId,watchOwnerUserId]);
    const clock=(await pg.query("select "+
      "to_char((now() at time zone $1)::date,'YYYY-MM-DD') today,"+
      "to_char(((now() at time zone $1)::date-1),'YYYY-MM-DD') yesterday,"+
      "to_char(date_trunc('hour',now() at time zone $1),'HH24:MI') at_hour",
      [own.timezone])).rows[0] as {today:string;yesterday:string;at_hour:string};
    await pg.query("insert into public.daily_rollups("+
      "business_id,business_date,net_sales_cents,orders_count,drinks_count,"+
      "ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,"+
      "voids_cents,sales_data_status) "+
      "select $1,($2::date-g.n),25000,30,30,5000,0,0,0,0,'actual' "+
      "from generate_series(0,13) g(n)",[watchBusinessId,clock.today]);
    await pg.query("insert into public.ingredients(id,business_id,name,base_unit) "+
      "values($1,$2,'Measured local milk','ml')",[stockId,watchBusinessId]);
    await pg.query("insert into public.pantry_stock_counts("+
      "business_id,ingredient_id,count_date,quantity_base,entered_quantity,entered_unit) "+
      "values($1,$2,$3,500,500,'ml')",[watchBusinessId,stockId,clock.today]);
    const before=(await pg.query("select "+
      "(select count(*)::int from public.ai_threads where business_id=$1) threads,"+
      "(select count(*)::int from public.alerts where business_id=$1) alerts,"+
      "(select count(*)::int from public.operating_tasks where business_id=$1) tasks",
      [watchBusinessId])).rows[0];
    expect(before).toEqual({threads:0,alerts:0,tasks:0});
    vi.stubEnv("SUPERVISOR_U4_WATCH_LOCAL_TIME",clock.at_hour);
    const provision=await dispatchRoutinesForBusiness(db,watchBusinessId,
      String(own.timezone),new Date(),undefined,provider);
    expect(provision.runs).toBe(0);
    const wt=(await pg.query("select id from public.ai_threads "+
      "where business_id=$1 and owner_user_id=$2",
      [watchBusinessId,watchOwnerUserId])).rows;
    expect(wt).toHaveLength(1);
    const watchThreadId=String(wt[0].id);
    const wr=(await pg.query("select id from public.supervisor_routines "+
      "where business_id=$1 and owner_user_id=$2 and execution_mode='watch'",
      [watchBusinessId,watchOwnerUserId])).rows;
    expect(wr).toHaveLength(1);
    const watchRoutineId=String(wr[0].id);
    await pg.query("update public.supervisor_routines "+
      "set updated_at=now()-interval '26 hours' where business_id=$1 and id=$2",
      [watchBusinessId,watchRoutineId]);
    // First genuine model-led Watch sees healthy, unchanged owner counts.
    const quietTick=await dispatchRoutinesForBusiness(db,watchBusinessId,
      String(own.timezone),new Date(),undefined,provider);
    expect(quietTick.runs).toBe(1);
    const first=(await pg.query("select run_id,local_date,state,u4_result "+
      "from public.supervisor_routine_occurrences "+
      "where business_id=$1 and routine_id=$2",
      [watchBusinessId,watchRoutineId])).rows;
    const quiet=first.find(row=>row.local_date===clock.yesterday);
    expect(quiet?.state).toBe("completed");
    expect(quiet?.u4_result?.attention).toBe("none");
    const watchQuietRunId=String(quiet.run_id);
    expect((await pg.query("select count(*)::int n from public.ai_messages "+
      "where business_id=$1 and thread_id=$2 and role='owner'",
      [watchBusinessId,watchThreadId])).rows[0].n).toBe(0);
    // Held-out, independently sourced material change. No alert is inserted,
    // no tool sequence is prescribed, and the same Watch must reassess.
    await pg.query("update public.daily_rollups "+
      "set net_sales_cents=900000,orders_count=900,drinks_count=900 "+
      "where business_id=$1 and business_date=$2",
      [watchBusinessId,clock.yesterday]);
    await pg.query("update public.pantry_stock_counts "+
      "set quantity_base=0,entered_quantity=0 "+
      "where business_id=$1 and ingredient_id=$2 and count_date=$3",
      [watchBusinessId,stockId,clock.today]);
    const oracle=(await pg.query("select "+
      "(select net_sales_cents from public.daily_rollups "+
      "where business_id=$1 and business_date=$2) sale,"+
      "(select quantity from public.cv_inventory "+
      "where business_id=$1 and business_date=$3 and source='app' "+
      "and data->>'evidence_state'='dated_owner_count' limit 1) stock",
      [watchBusinessId,clock.yesterday,clock.today])).rows[0];
    expect(Number(oracle.sale)).toBe(900000);
    expect(Number(oracle.stock)).toBe(0);
    const alertTick=await dispatchRoutinesForBusiness(db,watchBusinessId,
      String(own.timezone),new Date(),undefined,provider);
    expect(alertTick.runs).toBe(1);
    const all=(await pg.query("select run_id,local_date,state,receipt_ref,u4_result "+
      "from public.supervisor_routine_occurrences "+
      "where business_id=$1 and routine_id=$2",
      [watchBusinessId,watchRoutineId])).rows;
    expect(all).toHaveLength(2);
    const attention=all.find(row=>row.local_date===clock.today);
    expect(attention?.state).toBe("completed");
    const watchRunId=String(attention.run_id);
    expect(attention.receipt_ref).toBe("u4-verified:"+watchRunId);
    expect(attention.u4_result?.attention).toBe("attention");
    const sources=(attention.u4_result?.proof?.sources??[]) as
      Array<{identifier:string;domain:string}>;
    const watchToolNames=sources.map(source=>source.identifier);
    const independentlyVerified=new Set(sources.map(source=>source.domain));
    // Neither a mandatory tool name nor a fixed call order is the oracle.
    // Luna may use any admitted reader or U3 canonical view with independently
    // validated sales and stock lineage; one opaque multi-join is not two proofs.
    expect(independentlyVerified.has("recorded_sales")).toBe(true);
    expect(independentlyVerified.has("stock_and_inventory")).toBe(true);
    expect(String(attention.u4_result?.summary)).toMatch(/sales|revenue|orders/iu);
    expect(String(attention.u4_result?.summary)).toMatch(/stock|inventory|ingredient/iu);
    const watchPosts=(await pg.query("select id,grounding from public.ai_messages "+
      "where business_id=$1 and thread_id=$2 and role='supervisor' "+
      "and grounding->'agentMetadata'->>'u4Kind'='watch'",
      [watchBusinessId,watchThreadId])).rows;
    expect(watchPosts).toHaveLength(1);
    const watchReplyId=String(watchPosts[0].id);
    expect(watchPosts[0].grounding.agentMetadata.runId).toBe(watchRunId);
    const replay=await dispatchRoutinesForBusiness(db,watchBusinessId,
      String(own.timezone),new Date(),undefined,provider);
    expect(replay.runs).toBe(0);
    expect(providerCompletions).toBe(budget.calls);
    const spend=(await pg.query("select model,status,model_call_count "+
      "from public.supervisor_system_usage_events where source_type='routine' "+
      "and ((business_id=$1 and owner_user_id=$2 and source_id=$3) or "+
      "(business_id=$4 and owner_user_id=$5 and source_id=any($6::text[])))",
      [businessId,ownerUserId,leased.runId,watchBusinessId,watchOwnerUserId,
        [watchQuietRunId,watchRunId]])).rows;
    expect(spend).toHaveLength(budget.calls);
    expect(spend.every(x=>x.model==="gpt-6-luna"&&x.status==="completed"&&
      Number(x.model_call_count)===1)).toBe(true);
    expect((await pg.query("select count(*)::int n from public.supervisor_proposals "+
      "where business_id=$1",[watchBusinessId])).rows[0].n).toBe(0);
    const proposals=(await pg.query("select count(*)::int n from public.supervisor_proposals "+
      "where business_id=$1 and thread_id=$2",[businessId,threadId])).rows[0].n;
    expect(proposals).toBe(0);
    const proof={schema_version:1,id:"u4-autonomous-objectives",
      head_sha:env.AICAFE_SHARED_LUNA_HEAD,status:"passed",
      observed_model:"gpt-6-luna",observed_model_calls:providerCompletions,
      selected_sources:[...new Set([...result.observedToolNames,...watchToolNames])],
      unprompted_watch_persisted:true,watch_significance:"attention",
      watch_healthy_control:"none",watch_changed_evidence:true,
      watch_no_initial_chat_or_detector:true,
      original_goal_preserved:true,no_unauthorized_effect:true,
      persisted_lease_and_report:true,private_work_pointer:true,
      concise_chat_receipt:true,cross_domain_source_count:result.sourceCount,
      integrated_proven:false,released_proven:false};
    mkdirSync("test-results/acceptance",{recursive:true});
    writeFileSync("test-results/acceptance/u4-autonomous-objectives-proof.json",
      JSON.stringify(proof,null,2)+"\n",{mode:0o600});
    writeFileSync("test-results/acceptance/u4-autonomous-objectives-scope.json",
      JSON.stringify({
        businessId,foreignBusinessId,ownerUserId,threadId,ownerMessageId,
        routineId,runId:leased.runId,replyId:posts[0].id,
        workTaskId:"u4:"+leased.runId,
        watchBusinessId,watchOwnerUserId,watchThreadId,
        watchRoutineId,watchQuietRunId,watchRunId,watchReplyId,
        expectedProviderCalls:budget.calls,
      },null,2)+"\n",{mode:0o600});
  }finally{
    if(connected)await pg.end();
    vi.unstubAllEnvs();
  }
},300_000);
