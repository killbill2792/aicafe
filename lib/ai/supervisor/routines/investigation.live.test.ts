/** Task 15A *paid provider* owner acceptance, deliberately separate from mock CI.
 *
 * Opt-in only on a trusted runner with a disposable local Supabase:
 *   AICAFE_15A_AGENTIC_LIVE=1 OPENAI_API_KEY=(trusted secret)
 *   AICAFE_15A_LOCAL_DB_URL=postgresql://postgres:...@127.0.0.1:54322/postgres
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY=(local disposable Supabase service key)
 *   npx vitest run lib/ai/supervisor/routines/investigation.live.test.ts
 *
 * NEVER run against a production database or use real café/customer records.
 * The provider itself is real; the café facts are synthetic and backed by
 * actual migrated PostgreSQL and the production canonical Supervisor tools.
 * No provider call is made unless the above flag and credentials are present.
 *
 * This verifies durable unprompted action and grounded owner follow-up; it
 * does NOT claim competitive parity or an actual approved external POS effect.
 */
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {enqueueInvestigationsForOwner,processDueInvestigations,
  processNextInvestigation} from "./investigation.server";
const enabled=process.env.AICAFE_15A_AGENTIC_LIVE==="1";
const live=enabled?it:it.skip;
const requireLocal=(value:string|undefined,kind:"db"|"api"):string=>{
  if(!value)throw new Error("15A live test requires "+kind+" config");
  const u=new URL(value);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.protocol!==(kind==="db"?"postgresql:":"http:")||
    u.port!==(kind==="db"?"54322":"54321")||
    (kind==="db"&&u.pathname!=="/postgres"))
    throw new Error("15A live test refuses non-local or non-disposable endpoints");
  return value;
};
live("proactive real-model café investigation -> durable owner reply -> follow-up -> verified closure",async()=>{
  if(!process.env.OPENAI_API_KEY)
    throw new Error("LIVE ACCEPTANCE BLOCKED: trusted OpenAI provider credential unavailable");
  const head=process.env.AICAFE_15A_LIVE_HEAD;
  if(!/^[a-f0-9]{40}$/.test(head??""))
    throw new Error("LIVE ACCEPTANCE BLOCKED: exact PR head SHA is required");
  const dbUrl=requireLocal(process.env.AICAFE_15A_LOCAL_DB_URL,"db");
  const apiUrl=requireLocal(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw new Error("LIVE ACCEPTANCE BLOCKED: local Supabase service key unavailable");
  const admin=new Client({connectionString:dbUrl});
  await admin.connect();
  const scope={businessId:randomUUID(),ownerUserId:randomUUID(),
    threadId:randomUUID(),localDate:""};
  const taskId="15a-live-eval:"+randomUUID();
  const db=createClient(apiUrl,key,{auth:{persistSession:false,autoRefreshToken:false}});
  let totalCalls=0,totalBytes=0,providerCompletions=0;
  // A hard preflight guard before every paid call; no cost estimate is
  // mistaken for a provider invoice. Covers both initial and follow-up turns.
  const provider:AgentProvider=async function*(params,signal){
    const bytes=Buffer.byteLength(JSON.stringify(params),"utf8");
    if(totalCalls+1>12||totalBytes+bytes>600_000||
      typeof params.max_output_tokens!=="number"||
      params.max_output_tokens>1200)
      throw new Error("15a_live_provider_budget_exceeded");
    totalCalls++;totalBytes+=bytes;
    for await(const event of openAIProvider(params,signal)){
      if(event.type==="response.completed")providerCompletions++;
      yield event;
    }
  };
  const now=new Date();
  scope.localDate=now.toISOString().slice(0,10);
  try{
    await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
      [scope.ownerUserId,"agentic-15a-"+scope.ownerUserId+"@example.invalid"]);
    await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable agentic acceptance café','America/Los_Angeles',false)",
      [scope.businessId]);
    await admin.query("insert into public.cafe_access(business_id,mode) values ($1,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",
      [scope.businessId]);
    await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
      [scope.businessId,scope.ownerUserId]);
    await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
      [scope.threadId,scope.businessId,scope.ownerUserId,randomUUID()]);
    await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values ($1,$2,'leo','data_quality','needs_owner',$3,'low',$4,$5)",
      [scope.businessId,taskId,JSON.stringify({coverage:"unverified"}),
        JSON.stringify([{source:"pos_import",facts:{coverage:"unverified"}}]),
        scope.ownerUserId]);
    // No synthetic owner message triggers the agent. Existing cron scanner
    // finds the open issue, SQL queues it, and the *real* model uses registered
    // tools with actual disposable café data (including honest missing facts).
    expect(await enqueueInvestigationsForOwner(db,scope,now)).toBe(1);
    const first=await processDueInvestigations(db,now,2,provider);
    expect(first).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
    expect(providerCompletions).toBeGreaterThanOrEqual(2);
    expect(totalCalls).toBeGreaterThanOrEqual(2);
    const record=await admin.query(
      "select phase,step_version,narrative,evidence from public.supervisor_investigations where business_id=$1 and source_id=$2",
      [scope.businessId,taskId]);
    expect(record.rows).toHaveLength(1);
    expect(record.rows[0].phase).toBe("awaiting_owner");
    expect(Number(record.rows[0].step_version)).toBe(2);
    const modelTools=record.rows[0].evidence.modelTools;
    expect(Array.isArray(modelTools)).toBe(true);
    expect(modelTools[0]).toBe("get_investigation_source");
    expect(modelTools.length).toBeGreaterThanOrEqual(3);
    const messages=await admin.query("select role,grounding->>'status' status,grounding->>'intent' intent from public.ai_messages where business_id=$1 and thread_id=$2 order by created_at",
      [scope.businessId,scope.threadId]);
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({role:"supervisor",
      intent:"priority_investigation"});
    expect(["partial","verified"]).toContain(messages.rows[0].status);
    // This is an awaiting-application state, not proof that a requested POS
    // change happened. Monitoring must persist and report revised facts.
    await admin.query("update public.operating_tasks set status='watching' where business_id=$1 and id=$2",
      [scope.businessId,taskId]);
    const awaiting=await admin.query("select phase from public.supervisor_investigations where business_id=$1 and source_id=$2",
      [scope.businessId,taskId]);
    expect(awaiting.rows[0]?.phase).toBe("awaiting_owner");
    const future=new Date(now.getTime()+25*60*60_000);
    const next=await processNextInvestigation(db,future,provider);
    expect(next).toMatchObject({processed:1,followUps:1,failed:0});
    expect(providerCompletions).toBeGreaterThanOrEqual(4);
    // Only a verified source transition may close the incident.
    await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",
      [scope.businessId,taskId]);
    const done=await admin.query("select phase from public.supervisor_investigations where business_id=$1 and source_id=$2",
      [scope.businessId,taskId]);
    expect(done.rows[0]?.phase).toBe("resolved");
    const after=await admin.query("select role,grounding->>'intent' intent from public.ai_messages where business_id=$1 and thread_id=$2",
      [scope.businessId,scope.threadId]);
    expect(after.rows.some(r=>r.intent==="priority_investigation_resolution"&&
      r.role==="supervisor")).toBe(true);
    expect(after.rows.every(r=>r.role==="supervisor")).toBe(true);
    // Report bounded transport counts without printing café facts, model
    // prompts, tool arguments, provider text, identities, or secrets.
    const proof={
      schema_version:1,task:"15A",head_sha:head,
      run_id:Number(process.env.GITHUB_RUN_ID)||null,
      status:"passed",provider:"openai_responses",
      dataset:"disposable_local_migrated_supabase_synthetic_cafe",
      // This is actual provider execution, not a mock. It does not establish
      // real café production or independently measured competitor parity.
      provider_backed:true,production_cafe_proven:false,competitor_parity_proven:false,
      actual_owner_effect_proven:false,
      scenarios:["unprompted_source_detection","exact_incident_multi_domain_tools",
        "persisted_owner_update","unchanged_user_no_impersonation",
        "proactive_25h_follow_up","watching_not_false_resolution",
        "verified_source_closure"],
      tool_names:modelTools,
      provider_completions:providerCompletions,
      paid_calls:totalCalls,serialized_request_bytes:totalBytes,
      supervisor_messages:after.rows.length,
    };
    mkdirSync("test-results/acceptance",{recursive:true});
    writeFileSync("test-results/acceptance/15a-live-proof.json",
      JSON.stringify(proof,null,2)+"\n",{mode:0o600});
    console.log("15A trusted LIVE acceptance: provider completions",providerCompletions,
      "model transport calls",totalCalls,
      "transport request bytes",totalBytes,
      "verified owner messages",after.rows.length);
  }finally{
    await admin.query("delete from public.businesses where id=$1",[scope.businessId])
      .catch(()=>{});
    await admin.query("delete from auth.users where id=$1",[scope.ownerUserId])
      .catch(()=>{});
    await admin.end();
  }
},240_000);
