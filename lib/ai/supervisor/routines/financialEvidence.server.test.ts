/** Explicit disposable-only live acceptance, skipped by ordinary CI. */
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync,mkdtempSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {dispatchRoutinesForBusiness} from "./dispatch.server";
import {enqueueInvestigationsForOwner,processNextInvestigation,type InvestigationModelProofSummary} from "./investigation.server";
const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_SCENARIO==="14e-autonomous-followup"&&process.env.AICAFE_SHARED_LUNA_CANDIDATE==="1"&&process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY";
const marker=process.env.AICAFE_14E_INTERRUPTED;
const options={auth:{persistSession:false,autoRefreshToken:false}};
function local(){
 const api=process.env.NEXT_PUBLIC_SUPABASE_URL,uri=new URL(process.env.ACCEPTANCE_DATABASE_URL??"");
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY,anon=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(api!=="http://127.0.0.1:54321"||!["postgres:","postgresql:"].includes(uri.protocol)||uri.hostname!=="127.0.0.1"||uri.port!=="54322"||uri.pathname!=="/postgres"||uri.search||uri.hash||!key||!anon||configuredSupervisorModel()!=="gpt-6-luna")throw Error("14e_disposable_environment_required");
 return {db:createClient(api,key,options),api,anon,uri:uri.toString()};
}
async function until(check:()=>Promise<boolean>,ms:number){
 const end=Date.now()+ms;
 while(Date.now()<end){if(await check())return;await new Promise<void>(r=>setTimeout(r,250));}
 throw Error("14e_checkpoint_timeout");
}
(enabled&&marker?it:it.skip)("14e interrupted worker",async()=>{
 const {db}=local();
 expect(await processNextInvestigation(db,new Date())).toMatchObject({collected:1,failed:0});
 const interrupted:AgentProvider=()=>({[Symbol.asyncIterator](){return {next:async()=>{
  writeFileSync(marker!+".tmp",String(process.pid),{flag:"wx",mode:0o600});renameSync(marker!+".tmp",marker!);
  return await new Promise<never>((_r,reject)=>setTimeout(()=>reject(Error("14e_expected_kill")),240000));
 }};}});
 await processNextInvestigation(db,new Date(),interrupted);throw Error("14e_interrupted_worker_returned");
},270000);
(enabled&&!marker?it:it.skip)("14e financial review persists through restart and new source",async()=>{
 const {db,api,anon,uri}=local();
 const head=process.env.HEAD_SHA,proofFile=process.env.AICAFE_14E_PROOF,scopeFile=process.env.AICAFE_14E_SCOPE;
 if(!/^[a-f0-9]{40}$/.test(head??"")||!proofFile||!scopeFile||!process.env.OPENAI_API_KEY)throw Error("14e_proof_configuration");
 const sql=new Client({connectionString:uri});await sql.connect();
 const businessId=randomUUID(),otherCafeId=randomUUID(),threadId=randomUUID();
 const read=async(q:string,args:unknown[]=[]) => (await sql.query(q,args)).rows;
 const select=read;
 const calls:InvestigationModelProofSummary[]=[];let completions=0;
 const provider:AgentProvider=async function*(params,signal){
  if(params.model!=="gpt-6-luna")throw Error("14e_model_mismatch");
  for await(const ev of openAIProvider(params,signal)){
   if(ev.type==="response.completed"){if((ev.response as {model?:unknown}|undefined)?.model!=="gpt-6-luna")throw Error("14e_observed_model_mismatch");completions++;}
   yield ev;
  }
 };
 try{
  async function user(prefix:string){
   const email=prefix+"-"+randomUUID()+"@example.invalid",password="Local14e-"+randomUUID();
   const created=await db.auth.admin.createUser({email,password,email_confirm:true});
   if(created.error||!created.data.user)throw Error("14e_fixture_user_failed");
   const client=createClient(api,anon,options);const logged=await client.auth.signInWithPassword({email,password});
   if(logged.error||logged.data.user?.id!==created.data.user.id)throw Error("14e_fixture_login_failed");
   return {id:created.data.user.id,client};
  }
  const owner=await user("finance-owner"),foreign=await user("finance-foreign");
  await sql.query("insert into public.businesses(id,name,timezone,currency,is_demo) values ($1,'14E disposable finance','UTC','CAD',false),($2,'14E foreign cafe','UTC','CAD',false)",[businessId,otherCafeId]);
  await sql.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered'),($2,'grandfathered') on conflict(business_id) do update set mode='grandfathered',access_end=null",[businessId,otherCafeId]);
  await sql.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[businessId,owner.id,otherCafeId,foreign.id]);
  await sql.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,owner.id,randomUUID()]);
  const date=(n:number)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  await sql.query("insert into public.recurring_costs(business_id,category_code,label,amount_cents,frequency,is_estimate,active_from,due_day) values($1,'rent','Monthly rent',20000,'monthly',false,$2,1)",[businessId,date(-90)]);
  const capture=async(from:string,to:string,opening:number,closing:number)=>{
   const rows=[{i:0,date:from,amountCents:100,balanceCents:opening+100},{i:1,date:to,amountCents:closing-opening-100,balanceCents:closing}];
   const {data,error}=await db.rpc("supervisor_record_statement_evidence",{p_business_id:businessId,p_owner_user_id:owner.id,p_source_sha256:createHash("sha256").update(JSON.stringify(rows)).digest("hex"),p_account_key:"b".repeat(64),p_currency:"CAD",p_from:from,p_to:to,p_opening_cents:opening,p_closing_cents:closing,p_transactions:rows});
   if(error||typeof data!=="string")throw Error("14e_statement_capture_failed:"+error?.code);return data;
  };
  const firstUploadId=await capture(date(-4),date(-3),10100,10000),taskId="financial-review:"+owner.id;
  const dispatch=()=>dispatchRoutinesForBusiness(db,businessId,"UTC",new Date(),enqueueInvestigationsForOwner);
  expect((await dispatch()).investigationsQueued).toBeGreaterThanOrEqual(1);
  const checkpoint=async()=> (await read("select episode_id,phase,step_version,lease_token,evidence,lease_until<=clock_timestamp() expired from public.supervisor_investigations where business_id=$1 and source_id=$2",[businessId,taskId]))[0];
  const episode=(await checkpoint()).episode_id;
  const count=async(table:"ai_messages"|"expenses"|"connector_provider_receipts"|"supervisor_proposals",extra="")=>Number((await read("select count(*)::int n from public."+table+" where business_id=$1 "+extra,[businessId]))[0].n);
  expect(await count("ai_messages","and role='owner'")).toBe(0);
  const dir=mkdtempSync(join(tmpdir(),"14e-worker-")),file=join(dir,"held");
  const child=spawn(process.execPath,["node_modules/vitest/vitest.mjs","run","lib/ai/supervisor/routines/financialEvidence.server.test.ts","--pool=threads","--maxWorkers=1"],{detached:true,stdio:"ignore",env:{...process.env,AICAFE_14E_INTERRUPTED:file}});
  const exit=once(child,"exit");void exit.catch(()=>{});
  try{
   await until(async()=>{
    if(child.exitCode!==null||child.signalCode!==null)throw Error("14e_worker_exited_before_claim");
    return existsSync(file);
   },45000);
   const held=await checkpoint();
   expect(held).toMatchObject({episode_id:episode,phase:"investigate"});
   expect(held.lease_token).toBeTruthy();
   expect((await select("select count(*)::int n from public.supervisor_system_usage_events where business_id=$1 and status='attempted'",[businessId]))[0].n).toBe(1);
   if(!child.pid)throw Error("14e_child_pid_missing");
   process.kill(-child.pid,"SIGKILL");
   expect(await exit).toEqual([null,"SIGKILL"]);
   await until(async()=>{
    const row=await checkpoint();
    if(row.lease_token!==held.lease_token)throw Error("14e_lease_changed_before_recovery");
    return row.expired===true;
   },195000);
  }finally{
   if(child.pid&&child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,"SIGKILL");await exit;}
   rmSync(dir,{recursive:true,force:true});
  }

  expect(await processNextInvestigation(db,new Date(),provider,x=>calls.push(x))).toMatchObject({investigated:1,failed:0});
  const pending=await checkpoint();expect(pending).toMatchObject({episode_id:episode,phase:"awaiting_owner"});
  expect(pending.evidence.modelTools).toEqual(expect.arrayContaining(["get_investigation_source","get_cashflow_evidence","get_bills"]));
  expect(calls[0]?.verified).toBe(true);
  expect((await dispatch()).investigationsQueued).toBe(0);
  const before=await count("ai_messages","and role='supervisor'");
  const secondUploadId=await capture(date(-2),date(-1),10000,30000);await dispatch();
  for(let i=0;i<4&&calls.length<2;i++){
   const tick=await processNextInvestigation(db,new Date(),provider,x=>calls.push(x));
   expect(tick.failed).toBe(0);if(!tick.processed)throw Error("14e_changed_source_not_due");
  }
  const after=await checkpoint();expect(after.episode_id).toBe(episode);expect(after.phase).toBe("awaiting_owner");
  expect(after.evidence.modelTools).toEqual(expect.arrayContaining(["get_investigation_source","get_cashflow_evidence","get_bills"]));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.every(x=>x.verified&&!x.externalEffectClaim&&x.unverifiedCount===0)).toBe(true);
  expect(await count("ai_messages","and role='supervisor'")).toBeGreaterThan(before);
  const notice=(await read("select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' order by created_at desc limit 1",[businessId,threadId]))[0];expect(notice?.id).toBeTruthy();
  expect(await count("ai_messages","and role='owner'")).toBe(0);expect(await count("expenses")).toBe(0);expect(await count("connector_provider_receipts")).toBe(0);expect(await count("supervisor_proposals")).toBe(0);
  const hidden=await foreign.client.from("uploads").select("id").eq("business_id",businessId).eq("id",secondUploadId);expect(hidden.error).toBeNull();expect(hidden.data).toEqual([]);
  const usage=await read("select model,status,input_tokens from public.supervisor_system_usage_events where business_id=$1",[businessId]);
  expect(usage.filter(r=>r.status==="attempted")).toHaveLength(1);
  const completed=usage.filter(r=>r.status==="completed");expect(completed).toHaveLength(completions);expect(completions).toBeGreaterThanOrEqual(4);expect(completed.every(r=>r.model==="gpt-6-luna"&&Number(r.input_tokens)>0)).toBe(true);
  writeFileSync(proofFile,JSON.stringify({schema_version:1,id:"14e-autonomous-followup",head_sha:head,status:"passed",observed_model:"gpt-6-luna",modelCalls:completions,actualWorkerKilled:true,actualLeaseExpiry:true,sourceChanged:true,wholeCafeCashRemainsUnknown:true},null,2)+"\n",{flag:"wx",mode:0o600});
  writeFileSync(scopeFile,JSON.stringify({businessId,otherCafeId,ownerUserId:owner.id,threadId,taskId,episodeId:episode,firstUploadId,secondUploadId,ownerNoticeId:notice.id,expectedProviderCalls:completions},null,2)+"\n",{flag:"wx",mode:0o600});
 }finally{await sql.end();}
},480000);
