/** Task 13D first-party real-Luna staff investigation acceptance.
 * No provider calls in ordinary CI. Run ONLY inside a separately owner-gated
 * trusted-main workflow against disposable fully migrated local Supabase.
 * The real model must select the registered staff reader and independent dated
 * schedule evidence; SQL/browser integration remains separately verified.
 */
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {it,expect,vi} from "vitest";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall}
 from "./investigation.liveBudget";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {readClaimedStaffCoordination} from "@/lib/staffCoordination/cases.server";
import {enqueueInvestigationsForOwner,processDueInvestigations,
 processNextInvestigation,type InvestigationModelProofSummary} from "./investigation.server";

const enabled=process.env.AICAFE_13D_AGENTIC_LIVE==="1";
const run=enabled?it:it.skip;
function localEndpoint(value:string|undefined,kind:"db"|"api"){
 if(!value)throw Error("13d_live_missing_"+kind);
 const url=new URL(value);
 if(!["127.0.0.1","localhost"].includes(url.hostname)||
    url.protocol!==(kind==="db"?"postgresql:":"http:")||
    url.port!==(kind==="db"?"54322":"54321")||
    (kind==="db"&&url.pathname!=="/postgres"))
   throw Error("13d_live_non_disposable_"+kind);
 return value;
}
run("real Luna investigates recorded leave and staffing, follows up, and verifies owner-approved canonical leave",async()=>{
 const expectedHead=process.env.AICAFE_13D_LIVE_HEAD;
 if(!/^[a-f0-9]{40}$/.test(expectedHead??""))
  throw Error("13d_live_missing_exact_head");
 if(configuredSupervisorModel()!=="gpt-6-luna")
  throw Error("13d_live_model_mismatch");
 if(!process.env.OPENAI_API_KEY)
  throw Error("13d_live_provider_key_unavailable");
 const url=localEndpoint(process.env.AICAFE_13D_LOCAL_DB_URL,"db");
 const api=localEndpoint(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!key)throw Error("13d_live_disposable_service_key_missing");
 const admin=new Client({connectionString:url});
 await admin.connect();
 const db=createClient(api,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const ids={business:randomUUID(),foreignBusiness:randomUUID(),
  owner:randomUUID(),foreignOwner:randomUUID(),employeeUser:randomUUID(),
  originalEmployee:randomUUID(),replacementEmployee:randomUUID(),
  shift:randomUUID(),thread:randomUUID(),nonce:randomUUID()};
 const scope={businessId:ids.business,ownerUserId:ids.owner,
  threadId:ids.thread,localDate:""};
 let budget=emptyInvestigationLiveLedger(),providerCompletions=0;
 const observations:InvestigationModelProofSummary[]=[];
 const provider:AgentProvider=async function*(params,signal){
  if(params.model!=="gpt-6-luna"||typeof params.max_output_tokens!=="number")
    throw Error("13d_live_unexpected_model");
  // The existing trusted-main, secret-isolating 14B Responses broker caps
  // every candidate request at 1,200 output tokens and enforces a separate
  // $0.18 / 18-attempt hard ceiling. The production Supervisor's tool
  // registry, prompt and durable worker are unchanged; only the opt-in paid
  // transport request's output budget is lowered for this bounded pilot.
  const paidParams={...params,max_output_tokens:Math.min(params.max_output_tokens,1200)};
  budget=reserveInvestigationLiveCall(
   budget,Buffer.byteLength(JSON.stringify(paidParams),"utf8"),
   paidParams.max_output_tokens,params.model);
  for await(const event of openAIProvider(paidParams,signal)){
   if(event.type==="response.completed"){
    if((event.response as {model?:unknown}|undefined)?.model!=="gpt-6-luna")
     throw Error("13d_live_actual_model_mismatch");
    providerCompletions++;
   }
   yield event;
  }
 };
 const now=new Date();
 try{
  // Two independent cafés: no production or third-party employee data.
  await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values "+
   "($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now()),"+
   "($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$4,'',now(),now()),"+
   "($5,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$6,'',now(),now())",
   [ids.owner,"13d-live-owner-"+ids.owner+"@example.invalid",
    ids.foreignOwner,"13d-live-foreign-"+ids.foreignOwner+"@example.invalid",
    ids.employeeUser,"13d-live-worker-"+ids.employeeUser+"@example.invalid"]);
  await admin.query("insert into public.businesses(id,name,timezone,currency,is_demo) values "+
   "($1,'13D local live cafe','America/Los_Angeles','USD',false),"+
   "($2,'13D foreign local live cafe','Europe/London','GBP',false)",
   [ids.business,ids.foreignBusiness]);
  await admin.query("insert into public.cafe_access(business_id,mode) values "+
   "($1,'grandfathered'),($2,'grandfathered') on conflict (business_id) "+
   "do update set mode='grandfathered',access_end=null",
   [ids.business,ids.foreignBusiness]);
  await admin.query("insert into public.memberships(business_id,user_id,role) values "+
   "($1,$2,'owner'),($3,$4,'owner')",
   [ids.business,ids.owner,ids.foreignBusiness,ids.foreignOwner]);
  await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) "+
   "values ($1,$2,$3,$4)",
   [ids.thread,ids.business,ids.owner,randomUUID()]);
  await admin.query("insert into public.employees "+
   "(id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id) "+
   "values ($1,$2,'Employee original',true,'hour',1800,$3),"+
   "($4,$2,'Employee replacement',true,'hour',1900,null)",
   [ids.originalEmployee,ids.business,ids.employeeUser,ids.replacementEmployee]);
  const date=(await admin.query("select to_char((now() at time zone 'America/Los_Angeles')::date,'YYYY-MM-DD') as d")).rows[0].d;
  scope.localDate=date;
  await admin.query("insert into public.scheduled_shifts "+
   "(id,business_id,employee_id,local_date,start_local,end_local,source,status) "+
   "values ($1,$2,$3,$4,'07:00','14:00','owner','sent')",
   [ids.shift,ids.business,ids.originalEmployee,date]);
  // Record a genuine owner-origin leave request using its SQL identity
  // and owner-only RPC. This creates the 13D case and EXISTING proactive
  // operating task atomically, without changing the roster or authorizing leave.
  let caseId:string;
  try{
   await admin.query("set role authenticated");
   await admin.query("select set_config('request.jwt.claim.role','authenticated',false)");
   await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.owner]);
   const opened=await admin.query(
    "select public.staff_coordination_open($1,$2,'leave',$3,null,$4,$4,null) as receipt",
    [ids.business,ids.nonce,ids.originalEmployee,date]);
   caseId=opened.rows[0].receipt.id;
   expect(opened.rows[0].receipt).toMatchObject({revision:1,state:"needs_owner_decision"});
  }finally{
   await admin.query("reset role");
  }
  const recorded=await readClaimedStaffCoordination(db,{
   businessId:ids.business,ownerUserId:ids.owner});
  expect(recorded.filter(row=>row.id===caseId)).toHaveLength(1);
  await expect(readClaimedStaffCoordination(db,{
   businessId:ids.business,ownerUserId:ids.foreignOwner})).rejects.toThrow("unauthorized");
  const tasks=(await admin.query("select id,kind,status from public.operating_tasks "+
   "where business_id=$1 and entity_type='staff_coordination_case' and entity_id=$2",
   [ids.business,caseId])).rows;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({kind:"staff_coordination",status:"needs_owner"});
  const taskId=tasks[0].id;
  // A real source event (not a fake owner message) starts the SAME durable
  // existing Supervisor worker and actual registered read tools.
  expect(await enqueueInvestigationsForOwner(db,scope,now)).toBe(1);
  const first=await processDueInvestigations(db,now,2,provider,(summary)=>{
   observations.push(summary);
   console.log("13D real-model proof metadata",JSON.stringify({
    model:"gpt-6-luna",verified:summary.verified,
    toolNames:summary.toolNames,failureCode:summary.failureCode}));
  });
  if(first.failed){
   const checkpoints=(await admin.query("select phase,last_error,failure_count from "+
    "public.supervisor_investigations where business_id=$1 and source_id=$2",
    [ids.business,taskId])).rows;
   console.error("13D bounded live failure checkpoint",JSON.stringify({
    result:first,checkpoint:checkpoints.map(x=>({
     phase:x.phase,error:x.last_error,count:x.failure_count})),
    completions:providerCompletions,attempted:budget.calls}));
  }
  expect(first).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({verified:true,externalEffectClaim:false,
   unverifiedCount:0,failureCode:null});
  const incident=(await admin.query("select phase,step_version,evidence from public.supervisor_investigations "+
   "where business_id=$1 and source_id=$2",[ids.business,taskId])).rows;
  expect(incident).toHaveLength(1);
  expect(incident[0].phase).toBe("awaiting_owner");
  const tools=incident[0].evidence.modelTools as string[];
  expect(tools[0]).toBe("get_investigation_source");
  expect(tools).toContain("get_staff_coordination_cases");
  expect(tools.some(t=>["get_schedule","get_week_schedule","get_coverage_gaps"].includes(t)))
   .toBe(true);
  expect(providerCompletions).toBeGreaterThanOrEqual(2);
  const ownerPosts=(await admin.query("select role,grounding->>'intent' as intent from public.ai_messages "+
   "where business_id=$1 and thread_id=$2",[ids.business,ids.thread])).rows;
  expect(ownerPosts).toHaveLength(1);
  expect(ownerPosts[0]).toMatchObject({role:"supervisor",intent:"priority_investigation"});
  // Neither a model investigation nor an owner request may create approved
  // leave. A real owner decision/effect receipt is required separately.
  const before=(await admin.query(
   "select employee_id,start_local,status from public.scheduled_shifts where id=$1",
   [ids.shift])).rows[0];
  expect(before.employee_id).toBe(ids.originalEmployee);
  expect(String(before.start_local)).toMatch(/^07:00/);
  expect(before.status).toBe("sent");
  expect(Number((await admin.query(
   "select count(*)::int as n from public.staff_availability_exceptions where business_id=$1 "+
   "and employee_id=$2 and local_date=$3 and exception_type='approved_leave'",
   [ids.business,ids.originalEmployee,date])).rows[0].n)).toBe(0);
  const pending=(await admin.query("select status from public.operating_tasks "+
   "where business_id=$1 and id=$2",[ids.business,taskId])).rows[0];
  expect(pending.status).toBe("needs_owner");
  // Due after a verified 25-hour interval: durable continuation instead of
  // a duplicate request or a made-up successful coverage claim.
  const future=new Date(now.getTime()+25*60*60_000);
  const following=await processNextInvestigation(db,future,provider,
   (summary)=>observations.push(summary));
  expect(following).toMatchObject({processed:1,followUps:1,failed:0});
  expect(observations).toHaveLength(2);
  expect(observations[1].verified).toBe(true);
  // The actual OWNER, never the model, records explicit authorization.
  // That decision alone must leave the case uncompleted and leave unchanged.
  try{
   await admin.query("set role authenticated");
   await admin.query("select set_config('request.jwt.claim.role','authenticated',false)");
   await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.owner]);
   const decided=await admin.query(
    "select public.staff_coordination_decide($1,$2,1,'approve') as receipt",
    [ids.business,caseId]);
   expect(decided.rows[0].receipt).toMatchObject({
    state:"approved",revision:2,effectApplied:false});
  }finally{
   await admin.query("reset role");
  }
  expect((await admin.query("select state from public.staff_coordination_cases "+
   "where business_id=$1 and id=$2",[ids.business,caseId])).rows[0].state).toBe("approved");
  expect(Number((await admin.query(
   "select count(*)::int as n from public.staff_availability_exceptions where business_id=$1 "+
   "and employee_id=$2 and local_date=$3 and exception_type='approved_leave'",
   [ids.business,ids.originalEmployee,date])).rows[0].n)).toBe(0);

  // A human-approved fixture subsequently applies actual canonical leave.
  // This is *not* an AI action, a prior/guessed approval or a sent message.
  await admin.query("insert into public.staff_availability_exceptions "+
   "(business_id,employee_id,local_date,exception_type,source,confirmation,"+
   "confirmed_at,confirmed_by) values ($1,$2,$3,'approved_leave','owner_direct',"+
   "'owner_confirmed',clock_timestamp(),$4)",
   [ids.business,ids.originalEmployee,date,ids.owner]);
  try{
   await admin.query("set role service_role");
   await admin.query("select set_config('request.jwt.claim.role','service_role',false)");
   const reconciled=await admin.query(
    "select public.staff_coordination_reconcile($1) as receipt",[ids.business]);
   expect(Number(reconciled.rows[0].receipt.completed)).toBe(1);
  }finally{
   await admin.query("reset role");
  }
  const outcome=(await admin.query(
   "select c.state,t.status,t.payload->>'sourceVerified' as verified "+
   "from public.staff_coordination_cases c join public.operating_tasks t "+
   "on t.business_id=c.business_id and t.entity_id=c.id::text "+
   "and t.entity_type='staff_coordination_case' "+
   "where c.business_id=$1 and c.id=$2",[ids.business,caseId])).rows[0];
  expect(outcome).toMatchObject({state:"completed",status:"handled",verified:"true"});
  const done=(await admin.query("select phase from public.supervisor_investigations "+
   "where business_id=$1 and source_id=$2",[ids.business,taskId])).rows[0];
  expect(done.phase).toBe("resolved");
  const usage=(await admin.query("select model,status,model_call_count,input_tokens from "+
   "public.supervisor_system_usage_events where business_id=$1 and owner_user_id=$2",
   [ids.business,ids.owner])).rows;
  expect(usage).toHaveLength(budget.calls);
  expect(usage.every(row=>row.model==="gpt-6-luna"&&
   row.status==="completed"&&Number(row.model_call_count)===1&&
   Number(row.input_tokens)>0)).toBe(true);
  // Private artifact contains only exact-head/model/tool/counter receipts,
  // never staff text, IDs, model prompts, private facts, secrets or waIds.
  const proof={schema_version:1,task:"13D",head_sha:expectedHead,
   run_id:Number(process.env.GITHUB_RUN_ID)||null,status:"passed",
   source:"authenticated_owner_recorded_leave",
   provider:"openai_responses",observed_model:"gpt-6-luna",
   provider_completions:providerCompletions,provider_calls:budget.calls,
   tool_names:tools,verified_owner_inbox_posts:ownerPosts.length,
   cross_cafe_owner_denied:true,negative_no_automatic_leave_effect:true,
   persisted_followup:true,source_verified_human_applied_leave:true,
   actual_supervisor_leave_effect:false,
   browser_proven_in_separate_exact_head_ci:true,
   feature_proven:false,integrated_proven:false,released_proven:false};
  mkdirSync("test-results/acceptance",{recursive:true});
  writeFileSync("test-results/acceptance/13d-live-proof.json",
   JSON.stringify(proof,null,2)+"\n",{mode:0o600});
  // IDs are synthetic and NEVER uploaded. The trusted host broker runner
  // reads this private candidate/host handoff to independently SQL-verify
  // saved employee evidence, owner notice, true roster state and quota.
  // Without the explicit disposable-only host flag, cleanup is immediate.
  if(process.env.AICAFE_13D_HOST_ATTEST_DB==="1"){
   writeFileSync("test-results/acceptance/13d-live-scope.json",
    JSON.stringify({businessId:ids.business,foreignBusinessId:ids.foreignBusiness,
     ownerUserId:ids.owner,foreignOwnerUserId:ids.foreignOwner,
     threadId:ids.thread,employeeId:ids.originalEmployee,
     shiftId:ids.shift,caseId,taskId,leaveDate:date,
     expectedProviderCalls:budget.calls},     null,2)+"\n",{mode:0o600});
  }
 }finally{
  await admin.query("reset role").catch(()=>{});
  if(process.env.AICAFE_13D_HOST_ATTEST_DB!=="1"){
   for(const id of [ids.business,ids.foreignBusiness])
    await admin.query("delete from public.businesses where id=$1",[id]).catch(()=>{});
   for(const id of [ids.owner,ids.foreignOwner,ids.employeeUser])
    await admin.query("delete from auth.users where id=$1",[id]).catch(()=>{});
  }
  // In the trusted host-gated test, the runner independently rereads this
  // disposable DB and destroys its whole local instance immediately after.
  await admin.end();
 }
},300_000);
