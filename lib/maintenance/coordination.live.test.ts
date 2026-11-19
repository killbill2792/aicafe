/** Task 15B shared-runner investigation checkpoint (NOT full outreach/repair acceptance).
 * The trusted main workflow gates provider access and independently attests
 * disposable SQL receipts. Ordinary PR CI never spends provider tokens.
 */
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
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

const live=process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_SCENARIO==="15b"?it:it.skip;
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
  if(process.env.AI_CAFE_LIVE_ACCEPTANCE!=="OWNER_APPROVED_LOCAL_ONLY"||process.env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
    throw new Error("15b_live_separate_owner_authorization_missing");
  if(!process.env.OPENAI_API_KEY||!process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("15b_live_trusted_credentials_missing");
  if(configuredSupervisorModel()!=="gpt-6-luna")
    throw new Error("15b_live_model_not_luna");
  const head=process.env.AICAFE_SHARED_LUNA_HEAD;
  if(!/^[a-f0-9]{40}$/u.test(head??""))
    throw new Error("15b_live_exact_head_required");
  const dbUrl=local(process.env.ACCEPTANCE_DATABASE_URL,"db");
  const apiUrl=local(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
  const admin=new Client({connectionString:dbUrl});
  const db=createClient(apiUrl,process.env.SUPABASE_SERVICE_ROLE_KEY!,{
    auth:{persistSession:false,autoRefreshToken:false},
  });
  const scope={businessId:randomUUID(),ownerUserId:randomUUID(),
    threadId:randomUUID(),localDate:""};
  const foreignCafeId=randomUUID(),foreignOwnerId=randomUUID(),employeeId=randomUUID();
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
      "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now()),"+
      "($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$4,'',now(),now())",
      [scope.ownerUserId,"15b-live-"+scope.ownerUserId+"@example.invalid",foreignOwnerId,"15b-other-"+foreignOwnerId+"@example.invalid"]);
    await admin.query("insert into public.businesses(id,name,timezone,currency,is_demo) "+
      "values ($1,'Disposable repair verification cafe','America/Los_Angeles','USD',false),"+
      "($2,'Disposable unrelated cafe','Europe/London','GBP',false)",[scope.businessId,foreignCafeId]);
    await admin.query("insert into public.cafe_access(business_id,mode) "+
      "values ($1,'grandfathered'),($2,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",
      [scope.businessId,foreignCafeId]);
    await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')",
      [scope.businessId,scope.ownerUserId,foreignCafeId,foreignOwnerId]);
    await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) "+
      "values ($1,$2,$3,$4)",[scope.threadId,scope.businessId,scope.ownerUserId,randomUUID()]);
    scope.localDate=(await admin.query("select to_char((now() at time zone 'America/Los_Angeles')::date,'YYYY-MM-DD') as d")).rows[0].d;
    // Two independent recorded operational facts, not model-suggested or diagnostic POS data.
    await admin.query("insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents) "+
      "values ($1,$2,'Scheduled barista',true,'hour',1800)",[employeeId,scope.businessId]);
    await admin.query("insert into public.scheduled_shifts(id,business_id,employee_id,local_date,start_local,end_local,source,status) "+
      "values ($1,$2,$3,$4,'07:00','14:00','owner','sent')",[randomUUID(),scope.businessId,employeeId,scope.localDate]);
    await admin.query("insert into public.expenses(business_id,spent_on,amount_cents,vendor,category_code,source,status,dedupe_key) "+
      "values ($1,$2,9500,'Previous service technician','repairs','manual','actual',$3)",[scope.businessId,scope.localDate,randomUUID()]);
    try{
      await admin.query("set role authenticated");
      await admin.query("select set_config('request.jwt.claim.role','authenticated',false)");
      await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[scope.ownerUserId]);
      const args=[scope.businessId,id,"Test espresso machine","Owner reports boiler is not heating; staff cannot make hot drinks.",now.toISOString()];
      const report="select public.maintenance_report_case($1,$2,$3,$4,'high',$5) as id";
      expect((await admin.query(report,args)).rows[0].id).toBe(taskId);
      expect((await admin.query(report,args)).rows[0].id).toBe(taskId);
      await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[foreignOwnerId]);
      expect((await admin.query("select id from public.operating_tasks where business_id=$1 and id=$2",[scope.businessId,taskId])).rowCount).toBe(0);
      expect((await admin.query("select id from public.maintenance_case_events where business_id=$1 and task_id=$2",[scope.businessId,taskId])).rowCount).toBe(0);
      await expect(admin.query(report,args)).rejects.toMatchObject({code:"42501"});
    }finally{await admin.query("reset role");}
    const tick=new Date();
    expect(await enqueueInvestigationsForOwner(db,scope,tick)).toBe(1);
    const turn=await processDueInvestigations(db,tick,2,provider,p=>proof.push(p));
    if(turn.failed){
      const failure=await admin.query("select phase,last_error from public.supervisor_investigations "+
        "where business_id=$1 and source_id=$2",[scope.businessId,taskId]);
      console.error("15b_live_failed_stage",JSON.stringify({
        head,phase:failure.rows[0]?.phase==="awaiting_owner"?"awaiting_owner":"incomplete",
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
    expect(providerCompletions).toBe(ledger.calls);
    expect(proof[0].toolNames).toContain("get_expenses");
    const saved=await admin.query("select status,resolved_at,payload from public.operating_tasks "+
      "where business_id=$1 and id=$2",[scope.businessId,taskId]);
    expect(saved.rows[0]).toMatchObject({status:"needs_owner",resolved_at:null});
    expect(saved.rows[0].payload).toMatchObject({externalSent:false,repairVerified:false});
    const receipts=await admin.query("select kind from public.maintenance_case_events "+
      "where business_id=$1 and task_id=$2",[scope.businessId,taskId]);
    expect(receipts.rows.map(r=>r.kind)).toEqual(["report"]);
    const owner=await admin.query("select role,grounding->>'intent' intent from public.ai_messages "+
      "where business_id=$1 and thread_id=$2",[scope.businessId,scope.threadId]);
    expect(owner.rows).toEqual([{role:"supervisor",intent:"priority_investigation"}]);
    expect((await admin.query("select phase from public.supervisor_investigations where business_id=$1 and source_id=$2",[scope.businessId,taskId])).rows).toEqual([{phase:"awaiting_owner"}]);
    mkdirSync("test-results/acceptance",{recursive:true});
    writeFileSync("test-results/acceptance/15b-proof.json",JSON.stringify({head_sha:head,observed_model:"gpt-6-luna",status:"passed",scope:"investigation_only",feature_proven:false,external_effect_proven:false,cross_cafe_owner_denied:true}),{mode:0o600,flag:"wx"});
    writeFileSync("test-results/acceptance/15b-scope.json",JSON.stringify({businessId:scope.businessId,otherCafeId:foreignCafeId,ownerUserId:scope.ownerUserId,threadId:scope.threadId,taskId,expectedProviderCalls:ledger.calls}),{mode:0o600,flag:"wx"});
    console.log("15b_live_source_model_notice_verified",JSON.stringify({
      head,model:"gpt-6-luna",providerCompletions,toolNames:proof[0].toolNames,
      source:"maintenance_case_events",effect:"none_without_owner_approval",
    }));
  }finally{
    if(connected){
      await admin.query("rollback").catch(()=>{});
      // Disposable rows remain for the trusted host, which destroys the DB.
      await admin.end().catch(()=>{});
    }
  }
},300_000);
