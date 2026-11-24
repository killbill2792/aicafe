import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall}
  from "./investigation.liveBudget";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {enqueueInvestigationsForOwner,processDueInvestigations,
  processNextInvestigation,type InvestigationModelProofSummary} from "./investigation.server";
const scenario="15a-proactive-owner-answer";
const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_SCENARIO===scenario&&process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY";
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

import {generateAlerts} from "@/lib/alerts/generate";
import {authorizedExternalConversation} from "@/lib/ai/conversations/authorizedTurn.server";

live("generated meal-break evidence, real model investigation, and an exact owner response to the same episode",async()=>{
 const head=process.env.AICAFE_SHARED_LUNA_HEAD;
 if(!/^[a-f0-9]{40}$/.test(head??"")||configuredSupervisorModel()!=="gpt-6-luna"||!process.env.OPENAI_API_KEY||!process.env.SUPABASE_SERVICE_ROLE_KEY)
   throw Error("15a_live_configuration");
 const admin=new Client({connectionString:requireLocal(process.env.ACCEPTANCE_DATABASE_URL,"db")});
 await admin.connect();
 const db=createClient(requireLocal(process.env.NEXT_PUBLIC_SUPABASE_URL,"api"),process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const businessId=randomUUID(),ownerUserId=randomUUID(),threadId=randomUUID(),foreignBusinessId=randomUUID(),foreignOwnerId=randomUUID();
 const scope={businessId,ownerUserId,threadId};
 const now=new Date();
 let ledger=emptyInvestigationLiveLedger(),providerCompletions=0;
 const proofs:InvestigationModelProofSummary[]=[];
 const capture=(p:InvestigationModelProofSummary)=>proofs.push(p);
 const provider:AgentProvider=async function*(params,signal){
  if(params.model!=="gpt-6-luna"||typeof params.max_output_tokens!=="number")throw Error("15a_live_model");
  ledger=reserveInvestigationLiveCall(ledger,Buffer.byteLength(JSON.stringify(params),"utf8"),params.max_output_tokens,params.model);
  for await(const event of openAIProvider(params,signal)){
   if(event.type==="response.completed"){
    if((event.response as {model?:unknown})?.model!=="gpt-6-luna")throw Error("15a_live_model_mismatch");
    providerCompletions++;
   }
   yield event;
  }
 };
 try{
  for(const [business,owner] of [[businessId,ownerUserId],[foreignBusinessId,foreignOwnerId]]){
   await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
   await admin.query("insert into public.businesses(id,name,timezone,currency,is_demo) values($1,'Disposable proactive answer cafe','UTC','USD',false)",[business]);
   // Paid autonomous acceptance requires a verified synthetic Toast source.
   // This is an isolated local DB fixture, never a real API credential.
   await admin.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc,state) values ($1,'https://example.invalid','fixture-only','no-secret','verified')",[business]);
   await admin.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",[business]);
   await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,owner]);
  }
  await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,ownerUserId,randomUUID()]);
  const employeeId=randomUUID(),timecardId=randomUUID();
  await admin.query("insert into public.employees(id,business_id,display_name) values($1,$2,'Disposable barista')",
   [employeeId,businessId]);
  await admin.query("insert into public.timecards(id,business_id,employee_id,clock_in,clock_out,hourly_wage_cents,breaks) "+
   "values($1,$2,$3,$4::timestamptz-interval '8 hours',$4::timestamptz-interval '1 hour',1800,'[]'::jsonb)",
   [timecardId,businessId,employeeId,now.toISOString()]);
  // Generate the alert from the actual recorded timecard, never seed a
  // technical coverage diagnostic as a paid business investigation.
  await generateAlerts(db,businessId);
  const alert=(await admin.query("select id,payload from public.alerts where business_id=$1 and kind='meal_break' and status='new' and payload->>'timecardId'=$2",
   [businessId,timecardId])).rows;
  expect(alert).toHaveLength(1);
  const sourceId=alert[0].id as string;
  const scan=(time:Date)=>enqueueInvestigationsForOwner(db,{...scope,localDate:time.toISOString().slice(0,10)},time);
  expect(await scan(now)).toBe(1);
  expect(await processDueInvestigations(db,now,2,provider,capture)).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
  const row=async()=>(await admin.query("select episode_id,phase,pending_question_id,last_owner_answer_id,reported_owner_answer_id from public.supervisor_investigations where business_id=$1 and source_id=$2",[businessId,sourceId])).rows[0];
  const first=await row();expect(first.phase).toBe("awaiting_owner");expect(first.pending_question_id).toBeTruthy();
  const questionId=first.pending_question_id as string;
  const beforeRepeat=ledger.calls;
  await generateAlerts(db,businessId);
  const later=new Date(now.getTime()+86_400_000);
  expect(await scan(later)).toBe(0);
  expect(await processNextInvestigation(db,later,provider,capture)).toMatchObject({processed:0});
  expect(ledger.calls).toBe(beforeRepeat);
  expect(await row()).toEqual(first);
  const service=await authorizedExternalConversation(scope,threadId);
  const unrelated=await service.addOwnerMessage(threadId,randomUUID(),"This is a separate question.");
  expect((await row()).pending_question_id).toBe(questionId);
  await expect(authorizedExternalConversation({businessId:foreignBusinessId,ownerUserId:foreignOwnerId},threadId)).rejects.toThrow();
  const answer=await service.addOwnerMessage(threadId,randomUUID(),"I cannot confirm whether the break happened outside the recorded punches. Keep the original case open while I check.");
  const args={p_business_id:businessId,p_owner_user_id:ownerUserId,p_thread_id:threadId,p_question_id:questionId,p_answer_id:answer.id,p_response:{questionId,action:"supply"}};
  const foreign=await db.rpc("supervisor_answer_investigation_question",{...args,p_business_id:foreignBusinessId,p_owner_user_id:foreignOwnerId});
  expect(foreign.error).toBeTruthy();
  const bound=await db.rpc("supervisor_answer_investigation_question",args);
  expect(bound.error).toBeNull();expect(bound.data).toBe(first.episode_id);
  expect((await db.rpc("supervisor_answer_investigation_question",args)).data).toBe(first.episode_id);
  expect((await db.rpc("supervisor_answer_investigation_question",{...args,p_answer_id:unrelated.id})).error).toBeTruthy();
  expect(await processNextInvestigation(db,new Date(Date.now()+1000),provider,capture)).toMatchObject({processed:1,followUps:1,failed:0});
  expect(await row()).toMatchObject({episode_id:first.episode_id,phase:"awaiting_owner",last_owner_answer_id:answer.id,reported_owner_answer_id:answer.id});
  const update=(await admin.query("select id from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and role='supervisor' and grounding->>'ownerMessageId'=$4",[businessId,ownerUserId,threadId,answer.id])).rows;
  expect(update).toHaveLength(1);
  // Unverified owner input cannot close a source or authorize any effect.
  expect((await admin.query("select status from public.alerts where id=$1",[sourceId])).rows[0].status).toBe("new");
  expect((await admin.query("select count(*)::int n from public.supervisor_effect_attempts where business_id=$1",[businessId])).rows[0].n).toBe(0);
  const toolNames=[...new Set(proofs.flatMap(p=>p.toolNames))];
  expect(toolNames).toContain("get_investigation_source");expect(toolNames).toContain("query_data");
  expect(providerCompletions).toBe(ledger.calls);expect(ledger.calls).toBeGreaterThanOrEqual(4);
  const proof={schema_version:1,task:scenario,head_sha:head,status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",provider_calls:ledger.calls,provider_completions:providerCompletions,tool_names:toolNames,actual_source_detector:true,exact_owner_answer:true,same_episode:true,no_unapproved_effect:true,feature_proven:false,integrated_proven:false,released_proven:false};
  mkdirSync("test-results/acceptance",{recursive:true});
  writeFileSync("test-results/acceptance/"+scenario+"-proof.json",JSON.stringify(proof)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync("test-results/acceptance/"+scenario+"-scope.json",JSON.stringify({...scope,foreignBusinessId,sourceId,episodeId:first.episode_id,answerId:answer.id,questionId,replyId:update[0].id,expectedProviderCalls:ledger.calls})+"\n",{mode:0o600,flag:"wx"});
 }finally{await admin.end();}
},240000);
