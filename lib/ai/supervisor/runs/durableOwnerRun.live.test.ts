/** Real registered owner agent and a persisted claim abandoned by SIGKILL.
 * Only the separately approved, secret-isolated disposable Luna runner may execute.
 * No fabricated model output, production access, or browser-proof assertion. */
import {randomUUID} from "node:crypto";
import {fork} from "node:child_process";
import {once} from "node:events";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {authorizedExternalConversation} from "@/lib/ai/conversations/authorizedTurn.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {getExistingSupervisorReply} from "@/lib/ai/conversations/replyWriter.server";
import {admitDurableChat,processDurableRun} from "./worker.server";
import {SupabaseDurableRunRepository} from "./repository.server";

const scenario="6-15c-owner-run";
const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&
 process.env.AICAFE_SHARED_LUNA_SCENARIO===scenario&&
 process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY";
function local(value:string|undefined,port:string,protocol:string){
 if(!value)throw Error("owner_run_missing_disposable_endpoint");
 const u=new URL(value);
 if(!["127.0.0.1","localhost"].includes(u.hostname)||u.port!==port||u.protocol!==protocol||
    (port==="54322"&&u.pathname!=="/postgres"))throw Error("owner_run_non_disposable_endpoint");
 return value;
}
(enabled?it:it.skip)("recovers a killed owner's assignment using the real worker, registered tool and a verified final reply",async()=>{
 const head=process.env.AICAFE_SHARED_LUNA_HEAD;
 if(!/^[a-f0-9]{40}$/.test(head??"")||configuredSupervisorModel()!=="gpt-6-luna"||
    !process.env.OPENAI_API_KEY||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error("owner_run_live_configuration");
 const url=local(process.env.ACCEPTANCE_DATABASE_URL,"54322","postgresql:");
 local(process.env.NEXT_PUBLIC_SUPABASE_URL,"54321","http:");
 const db=new Client({connectionString:url});await db.connect();
 const scope={businessId:randomUUID(),ownerUserId:randomUUID(),threadId:randomUUID()};
 const foreignBusinessId=randomUUID(),foreignOwnerId=randomUUID();
 const {businessId,ownerUserId,threadId}=scope;
 vi.stubEnv("SUPERVISOR_RUN_WORKER_ENABLED","true");
 vi.stubEnv("SUPERVISOR_DURABLE_CHAT_ENABLED","true");
 let child:ReturnType<typeof fork>|undefined;
 try{
  for(const id of [ownerUserId,foreignOwnerId])await db.query(
   "insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
   [id,id+"@example.invalid"]);
  for(const [business,owner] of [[businessId,ownerUserId],[foreignBusinessId,foreignOwnerId]]){
   await db.query("insert into public.businesses(id,name,timezone,currency,is_demo) values ($1,'Disposable owner run cafe','America/Los_Angeles','USD',false)",[business]);
   await db.query("insert into public.cafe_access(business_id,mode) values ($1,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",[business]);
   await db.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[business,owner]);
  }
  await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[threadId,businessId,ownerUserId,randomUUID()]);
  const service=await authorizedExternalConversation(scope,threadId);
  const message=await service.addOwnerMessage(threadId,randomUUID(),"I sold 17 cups in the morning and 23 cups later. Use the calculate tool to add these two owner-provided counts. Tell me the total as cups.");
  const input={locale:"en" as const,attachmentIds:[]};
  const run=await admitDurableChat(scope,message,input);
  expect((await admitDurableChat(scope,message,input)).id).toBe(run.id);
  const repo=new SupabaseDurableRunRepository(),worker=randomUUID();
  const auth=await repo.claim(scope,run.id,worker,30);
  if(auth.kind!=="claimed"||auth.key!=="authorize_owner")throw Error("owner_run_authorization_claim");
  await repo.complete(scope,run.id,auth.key,auth.claimToken,"owner:"+message.id);
  child=fork("scripts/acceptance/task15c-worker-child.mjs",[],{execArgv:[],stdio:["ignore","ignore","ignore","ipc"],
   env:{...process.env,SUPERVISOR_RUN_DB_URL:url,SUPERVISOR_RUN_DB_SANDBOX_ONLY:"1"}});
  const pending=once(child,"message");child.send({operation:"claim",args:[businessId,ownerUserId,threadId,run.id,randomUUID(),5]});
  const [claim]=await pending as [{ok:boolean;result:{kind:string;step:{step_key:string;claim_token:string}}}];
  expect(claim).toMatchObject({ok:true,result:{kind:"claimed",step:{step_key:"owner_turn"}}});
  const exited=once(child,"exit");child.kill("SIGKILL");const [,signal]=await exited;expect(signal).toBe("SIGKILL");child=undefined;
  const deadline=Date.now()+15000;
  for(;;){
   const row=(await db.query("select lease_until<=clock_timestamp() as expired from public.supervisor_run_steps where run_id=$1 and step_key='owner_turn'",[run.id])).rows[0];
   if(row?.expired===true)break;
   if(Date.now()>deadline)throw Error("owner_run_lease_did_not_expire");
   await new Promise<void>(resolve=>setTimeout(resolve,250));
  }
  expect(await processDurableRun(run.id)).toBe("completed");
  expect(await processDurableRun(run.id)).toBe("completed");
  const reply=await getExistingSupervisorReply(scope,message);
  const meta=reply?.grounding?.agentMetadata as {sources?:{source:string}[];usage?:{model?:string;modelCalls:number}}|undefined;
  expect(reply?.grounding?.status).toBe("verified");
  expect(JSON.stringify(reply?.blocks)).toMatch(/\b40\b/);
  expect(meta?.usage?.model).toBe("gpt-6-luna");
  const toolNames=(meta?.sources??[]).map(s=>s.source);
  expect(toolNames).toContain("calculate");
  const state=(await db.query("select status,final_report_ref from public.supervisor_runs where id=$1",[run.id])).rows;
  expect(state).toEqual([{status:"completed",final_report_ref:reply!.id}]);
  const step=(await db.query("select attempts,checkpoint_receipts from public.supervisor_run_steps where run_id=$1 and step_key='owner_turn'",[run.id])).rows[0];
  expect(step.attempts).toBeGreaterThanOrEqual(2);
  expect(step.checkpoint_receipts).toEqual(expect.arrayContaining([expect.objectContaining({tool:"calculate",phase:"read_pending"})]));
  const jobs=(await db.query("select id,status from public.ai_agent_jobs where durable_run_id=$1",[run.id])).rows;
  expect(jobs).toHaveLength(1);expect(jobs[0].status).toBe("done");
  expect((await db.query("select count(*)::int as n from public.supervisor_effect_attempts where business_id=$1",[businessId])).rows[0].n).toBe(0);
  await expect(authorizedExternalConversation({businessId:foreignBusinessId,ownerUserId:foreignOwnerId},threadId)).rejects.toThrow();
  const calls=meta?.usage?.modelCalls??0;expect(calls).toBeGreaterThan(0);
  mkdirSync("test-results/acceptance",{recursive:true});
  const proof={schema_version:1,task:scenario,head_sha:head,run_id:Number(process.env.GITHUB_RUN_ID)||null,status:"passed",
   provider:"openai_responses",observed_model:"gpt-6-luna",provider_calls:calls,provider_completions:calls,tool_names:toolNames,
   actual_worker_sigkill:true,actual_lease_expiry:true,verified_final_reply:true,same_run:true,cross_cafe_owner_denied:true,
   browser_proven:false,feature_proven:false,integrated_proven:false,released_proven:false};
  writeFileSync("test-results/acceptance/"+scenario+"-proof.json",JSON.stringify(proof,null,2)+"\n",{mode:0o600});
  writeFileSync("test-results/acceptance/"+scenario+"-scope.json",JSON.stringify({...scope,runId:run.id,ownerMessageId:message.id,
   replyId:reply!.id,jobId:jobs[0].id,foreignBusinessId,expectedProviderCalls:calls},null,2)+"\n",{mode:0o600});
 }finally{
  if(child){child.kill("SIGKILL");}
  vi.unstubAllEnvs();await db.end();
 }
},240000);
