/** Task 15B real Luna staged maintenance journey; Gmail transport is disposable and simulated.
 * The trusted main workflow gates provider access and independently attests
 * disposable SQL receipts. Ordinary PR CI never spends provider tokens.
 */
import {randomUUID,randomBytes} from "node:crypto";
import {encryptToken} from "@/lib/security/tokenCrypto";
import {approveLoop,commitLoop} from "@/lib/ai/supervisor/loop/engine";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
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

live("real gpt-6-luna proposes vendor outreach and independently verified staff repair check",async()=>{
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
  const staffUser=randomUUID(),accountId=randomUUID();
  let sent=0,rfc="",replyAt:number|null=null;
  const originalFetch=globalThis.fetch;
  const message=(id:string,subject:string,body:string,at:number)=>({
    id,threadId:id==="fixture-contact"?"fixture-history":"fixture-thread",internalDate:String(at),
    snippet:body,payload:{headers:[{name:"From",value:"Repair technician <repair@example.invalid>"},
      {name:"Subject",value:subject}],mimeType:"text/plain",body:{data:Buffer.from(body).toString("base64url")}}
  });
  // Real application connector/gateway/receipt code; ONLY the external Gmail
  // HTTP transport is simulated. Never forward a Google request to the network.
  vi.stubGlobal("fetch",async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.hostname!=="gmail.googleapis.com"){
      if(url.hostname.endsWith("googleapis.com")||url.hostname.endsWith("google.com"))
        throw new Error("15b_refuses_real_google_transport");
      return originalFetch(input,init);
    }
    if(new Headers(init?.headers).get("authorization")!=="Bearer disposable-maintenance-token")
      throw new Error("15b_refuses_nonfixture_mailbox");
    const path=url.pathname.replace("/gmail/v1/users/me","");
    if(path==="/messages/send"&&init?.method==="POST"){
      const raw=Buffer.from(JSON.parse(String(init.body)).raw,"base64url").toString("utf8");
      expect(raw).toContain("To: repair@example.invalid");
      rfc=raw.match(/Message-ID: (<[^>]+>)/)?.[1]??"";
      expect(rfc).not.toBe("");sent++;
      return Response.json({id:"fixture-sent",threadId:"fixture-thread"});
    }
    if(path==="/messages")return Response.json({messages:[{id:"fixture-contact",threadId:"fixture-history"}]});
    if(path==="/messages/fixture-contact")return Response.json(message("fixture-contact","Espresso boiler service",
      "We are the previous technician for this espresso machine; contact us for a boiler fault.",now.getTime()-86400000));
    if(path==="/messages/fixture-sent")return Response.json({id:"fixture-sent",threadId:"fixture-thread",labelIds:["SENT"],
      payload:{headers:[{name:"Message-ID",value:rfc}]}});
    if(path==="/threads/fixture-thread")return Response.json({id:"fixture-thread",messages:replyAt===null?[]:[
      message("fixture-reply","Boiler repair","Technician reports repair completed. Please have your barista independently test the machine before returning it to service.",replyAt)]});
    throw new Error("15b_unexpected_fixture_mail_request");
  });
  vi.stubEnv("TOKEN_ENCRYPTION_KEY",randomBytes(32).toString("base64"));
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
    await admin.query("insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at) "+
      "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,now(),'',now(),now())",
      [staffUser,staffUser+"@example.invalid"]);
    await admin.query("insert into public.connector_accounts(id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,enabled_operations,status) "+
      "values($1,$2,$3,'gmail','disposable-15b','owner@example.invalid',array['https://www.googleapis.com/auth/gmail.modify'],array['read','send'],'active')",
      [accountId,scope.businessId,scope.ownerUserId]);
    await admin.query("insert into public.connector_credentials(account_id,access_token_enc,refresh_token_enc,token_expires_at,generation) "+
      "values($1,$2,$3,now()+interval '1 hour',1)",[accountId,encryptToken("disposable-maintenance-token"),encryptToken("disposable-refresh-token")]);
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
      const args=[scope.businessId,id,"Test espresso machine","Owner reports boiler is not heating; staff cannot make hot drinks. Machine is isolated for safety. Previous technician has serviced this boiler and should be asked for diagnosis and availability; no staff are authorized to repair it. Owner approval required before contacting technician.",now.toISOString()];
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
    const loopScope={...scope,locale:"en" as const,verifiedReadClient:db};
    const repo=new SupabaseLoopRepository();
    const draft=async(capability:string)=>{
      const rows=await admin.query("select id,revision,canonical_effect_payload from public.supervisor_proposals where business_id=$1 and thread_id=$2 and capability_id=$3 and status='draft'",
        [scope.businessId,scope.threadId,capability]);
      expect(rows.rows).toHaveLength(1);return rows.rows[0];
    };
    const ownerClick=async(p:{id:string;revision:number})=>{
      // Simulated explicit owner click in the disposable database; still uses
      // the real immutable approval, claim, capability commit and finalizer.
      const approved=await approveLoop(loopScope,repo,p.id,p.revision,supervisorLoopRegistry);
      const result=await commitLoop(loopScope,supervisorLoopRegistry,repo,p.id,approved.revision);
      expect(result.proposal.status).toBe("committed");
    };
    const vendor=await draft("alex.gmail_effect.v1");
    expect(vendor.canonical_effect_payload).toMatchObject({maintenanceCaseId:taskId,to:["repair@example.invalid"],operation:"send"});
    expect(proof[0].toolNames).toContain("search_maintenance_vendor");
    expect(proof[0].toolNames).toContain("propose_maintenance_vendor_request");
    expect(sent).toBe(0);
    await expect(commitLoop(loopScope,supervisorLoopRegistry,repo,vendor.id,vendor.revision)).rejects.toThrow();
    expect(sent).toBe(0);
    await ownerClick(vendor);expect(sent).toBe(1);
    const open=await admin.query("select status,payload from public.operating_tasks where business_id=$1 and id=$2",[scope.businessId,taskId]);
    expect(open.rows[0]).toMatchObject({status:"needs_owner",payload:{externalSent:true,repairVerified:false,maintenanceStage:"request_sent"}});
    const verifiedSend=await admin.query("select provider_accepted_at from public.connector_provider_receipts where business_id=$1 and proposal_id=$2 and state='verified'",
      [scope.businessId,vendor.id]);
    expect(verifiedSend.rows).toHaveLength(1);
    // Fixture reports completion after the acknowledged outbound request.
    replyAt=new Date(verifiedSend.rows[0].provider_accepted_at).getTime()+1;
    try{
      await admin.query("set role authenticated");
      await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[scope.ownerUserId]);
      await admin.query("select public.staff_link_existing_login($1,$2,$3)",[scope.businessId,employeeId,staffUser+"@example.invalid"]);
    }finally{await admin.query("reset role");}
    const secondTick=new Date();
    expect(await enqueueInvestigationsForOwner(db,scope,secondTick)).toBe(1);
    expect(await processDueInvestigations(db,secondTick,2,provider,p=>proof.push(p))).toMatchObject({failed:0,investigated:1});
    expect(proof).toHaveLength(2);
    expect(proof[1]).toMatchObject({verified:true,externalEffectClaim:false,unverifiedCount:0,failureCode:null});
    expect(proof[1].toolNames).toContain("record_maintenance_repair_claim");
    expect(proof[1].toolNames).toContain("propose_maintenance_staff_assignment");
    const staff=await draft("leo.maintenance_staff_assignment.v1");
    expect(staff.canonical_effect_payload).toMatchObject({maintenanceCaseId:taskId,employeeId,purpose:"verify_working"});
    expect((await admin.query("select status,payload->>'repairVerified' as verified from public.operating_tasks where business_id=$1 and id=$2",
      [scope.businessId,taskId])).rows).toEqual([{status:"needs_owner",verified:"false"}]);
    expect((await admin.query("select id from public.staff_communication_requests where business_id=$1 and source_id=$2",[scope.businessId,staff.id])).rowCount).toBe(0);
    await ownerClick(staff);
    const request=(await admin.query("select id from public.staff_communication_requests where business_id=$1 and source_id=$2 and source_type='maintenance_verify'",[scope.businessId,staff.id])).rows;
    expect(request).toHaveLength(1);
    try{
      await admin.query("set role authenticated");
      await admin.query("select set_config('request.jwt.claim.sub',$1,false)",[staffUser]);
      const args=[request[0].id,"I physically tested the equipment and confirm it is working.",randomUUID()];
      const submit="select public.staff_channel_submit($1,'complete',$2,$3)";
      await admin.query(submit,args);await admin.query(submit,args);
    }finally{await admin.query("reset role");}
    const saved=await admin.query("select status,resolved_at,payload from public.operating_tasks where business_id=$1 and id=$2",[scope.businessId,taskId]);
    expect(saved.rows[0]).toMatchObject({status:"handled",payload:{externalSent:true,repairVerified:true,maintenanceStage:"verified_repaired"}});
    expect(saved.rows[0].resolved_at).not.toBeNull();
    const receipts=await admin.query("select kind from public.maintenance_case_events where business_id=$1 and task_id=$2",[scope.businessId,taskId]);
    expect(receipts.rows.map(r=>r.kind).sort()).toEqual(["report","vendor_send_verified","vendor_reply","repair_claim","staff_assignment","operational_verification"].sort());
    expect(providerCompletions).toBe(ledger.calls);
    expect(sent).toBe(1);
    mkdirSync("test-results/acceptance",{recursive:true});
    writeFileSync("test-results/acceptance/15b-proof.json",JSON.stringify({head_sha:head,observed_model:"gpt-6-luna",status:"passed",scope:"maintenance_disposable_gmail_transport",feature_proven:false,external_effect_proven:false,cross_cafe_owner_denied:true}),{mode:0o600,flag:"wx"});
    writeFileSync("test-results/acceptance/15b-scope.json",JSON.stringify({businessId:scope.businessId,otherCafeId:foreignCafeId,ownerUserId:scope.ownerUserId,threadId:scope.threadId,taskId,expectedProviderCalls:ledger.calls}),{mode:0o600,flag:"wx"});
    console.log("15b_live_source_model_notice_verified",JSON.stringify({
      head,model:"gpt-6-luna",providerCompletions,toolNames:proof.flatMap(p=>p.toolNames),
      source:"maintenance_case_events",effect:"disposable_transport_only_after_owner_approval",
    }));
  }finally{
    vi.unstubAllGlobals();vi.unstubAllEnvs();
    if(connected){
      await admin.query("rollback").catch(()=>{});
      // Disposable rows remain for the trusted host, which destroys the DB.
      await admin.end().catch(()=>{});
    }
  }
},300_000);
