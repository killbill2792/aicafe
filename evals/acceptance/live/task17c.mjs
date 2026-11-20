#!/usr/bin/env node
// Initial cross-domain delegated lane. Not the complete autonomous release gate.
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,verifyCheckoutHead} from "./runner.mjs";
import {profiles,openOwner,createThread,makeQuote,delegate,rows,observeDueOccurrence,createOperatingWorld,exerciseOperatingWorld,procurementRecovery,businessMonitorRecovery,effectSecurityRecovery,legacyFollowup} from "./task17c-world.mjs";
import {verifyRoutineAndFile,assessCoverage,verifyScheduledOccurrence,verifyOperatingWorld} from "./task17c-oracle.mjs";
const env=process.env;
assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||
 !["17c","17c-autonomy","17c-procurement-recovery","17c-business-monitors","17c-effect-security-recovery","17c-fault-followup"].includes(env.AICAFE_SHARED_LUNA_SCENARIO)||env.AICAFE_SHARED_LUNA_HEAD!==env.HEAD_SHA)
 throw Error("task17c:trusted_shared_run_required");
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")throw Error("task17c:proof_paths_required");
const files=[resolve(args[1]),resolve(args[3])],proofRoot=realpathSync("/proof");
if(files[0]===files[1]||files.some(f=>existsSync(f)||realpathSync(dirname(f))!==proofRoot||!f.startsWith(proofRoot+sep)))
 throw Error("task17c:private_fresh_outputs_required");
const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
const {first,foreign}=profiles(),db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
const browser=await chromium.launch({headless:true});
let owner,outsider;
try{
 await db.connect();
 const additional={"17c-procurement-recovery":procurementRecovery,"17c-business-monitors":businessMonitorRecovery,"17c-effect-security-recovery":effectSecurityRecovery,"17c-fault-followup":legacyFollowup};
 if(Object.hasOwn(additional,env.AICAFE_SHARED_LUNA_SCENARIO)){
  const result=await additional[env.AICAFE_SHARED_LUNA_SCENARIO](db,browser);
  if(!Number.isSafeInteger(result.calls)||result.calls<2||result.calls>18)throw Error("task17c:provider_call_bound");
  const proof={schema_version:1,task:"17c",lane:env.AICAFE_SHARED_LUNA_SCENARIO,head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",calls:result.calls,coverage:assessCoverage({head:env.HEAD_SHA}),integrated_proven:false,released_proven:false};
  writeFileSync(files[0],JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
  writeFileSync(files[1],JSON.stringify({...result.scope,expectedProviderCalls:result.calls})+"\n",{flag:"wx",mode:0o600});
 }else if(env.AICAFE_SHARED_LUNA_SCENARIO==="17c-autonomy"){
  const world=await createOperatingWorld(db), evidence=await exerciseOperatingWorld(db,world);
  const verified=verifyOperatingWorld({world,evidence});
  const {staff,finance}=world;
  for(const [cafe,noticeId] of [[staff,verified.staffNoticeId],[finance,verified.financeFollowupNoticeId]]){
   const read=await cafe.owner.client.from("ai_messages").select("id").eq("id",noticeId).eq("business_id",cafe.businessId);
   if(read.error||read.data.length!==1)throw Error("task17c:owner_notice_not_readable");
   owner=await openOwner(browser,cafe);
   await owner.page.goto("/en?thread="+encodeURIComponent(cafe.threadId));
   const work=await owner.context.request.get("/api/ai/threads/"+cafe.threadId+"/work");
   if(work.status()!==200)throw Error("task17c:owner_work_unavailable");
   await owner.context.close();owner=null;
  }
  const proof={schema_version:1,task:"17c",lane:"two-cafe-unattended-investigation-recovery",head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",calls:verified.providerCalls,realWorkerKilled:true,realLeaseExpired:true,ownerPrompts:0,followupSourceChanged:true,coverage:assessCoverage({head:env.HEAD_SHA}),integrated_proven:false,released_proven:false};
  const scope={businessId:staff.businessId,ownerUserId:staff.ownerUserId,threadId:staff.threadId,foreignBusinessId:finance.businessId,financeOwnerUserId:finance.ownerUserId,financeThreadId:finance.threadId,staffSourceId:staff.taskId,financeSourceId:finance.taskId,staffMessageId:staff.messageId,firstUploadId:finance.firstUploadId,secondUploadId:evidence.secondUploadId,...verified,expectedProviderCalls:verified.providerCalls};
  writeFileSync(files[0],JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
  writeFileSync(files[1],JSON.stringify(scope)+"\n",{flag:"wx",mode:0o600});
 }else{
 owner=await openOwner(browser,first);
 const threadId=await createThread(owner.context);
 const {attachmentId,expected}=await makeQuote(owner.context,threadId,first.timezone);
 const scope={businessId:first.businessId,ownerUserId:first.owner.userId,
  foreignBusinessId:foreign.businessId,threadId,attachmentId};
 const result=await delegate(owner.page,threadId,attachmentId,expected);
 // Close owner browser before independent readback; no subsequent prompt.
 await owner.context.close();owner=null;
 const ownerRows=await rows(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner'",[scope.businessId,threadId]);
 if(ownerRows.length!==1)throw Error("task17c:owner_delegation_count");
 const usage=await readPersistedModelUsage(db,scope.businessId,ownerRows[0].id);
 const routineId=verifyRoutineAndFile({scope,expected,ownerRows,usage,
  routines:await rows(db,"select * from public.supervisor_routines where business_id=$1 and thread_id=$2",[scope.businessId,threadId]),
  reply:await rows(db,"select structured_content from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and id=$4 and role='supervisor'",[scope.businessId,scope.ownerUserId,threadId,result.done.reply.id]),
  attachments:await rows(db,"select id,business_id,owner_user_id,thread_id from public.ai_attachments where id=$1",[attachmentId]),
  proposals:await rows(db,"select id from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,threadId]),
  foreignRows:await rows(db,"select id from public.supervisor_routines where business_id=$1 and thread_id=$2",[scope.foreignBusinessId,threadId])
 });
 const occurrence=await observeDueOccurrence(db,scope,expected,routineId);
 const routineRunId=verifyScheduledOccurrence({expected,...occurrence});
 const ownerAfter=await rows(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner'",[scope.businessId,threadId]);
 if(ownerAfter.length!==1||ownerAfter[0].id!==ownerRows[0].id)throw Error("task17c:unexpected_new_owner_prompt");
 const effectsAfter=await rows(db,"select id from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,threadId]);
 if(effectsAfter.length!==0)throw Error("task17c:unapproved_effect_proposal");
 outsider=await openOwner(browser,foreign);
 const rejected=await outsider.context.request.get("/api/ai/threads/"+threadId);
 if(![401,403,404].includes(rejected.status()))throw Error("task17c:foreign_thread_denial_unverified");
 // Real saved work and owner-visible routine must survive a fresh login.
 owner=await openOwner(browser,first);
 await owner.page.goto("/en?thread="+encodeURIComponent(threadId));
 await owner.page.setViewportSize({width:390,height:844});
 await owner.page.getByRole("button",{name:"Library, routines and permissions"}).click({timeout:30000});
 const panel=owner.page.getByRole("dialog",{name:"Supervisor controls"});
 await panel.getByRole("button",{name:"Routines",exact:true}).click({timeout:30000});
 await panel.getByText(expected.title,{exact:true}).waitFor({timeout:30000});
 const foreignRoutines=await outsider.context.request.get("/api/ai/supervisor/routines");
 if(foreignRoutines.status()!==200)throw Error("task17c:foreign_routine_reader_failed");
 const other=await foreignRoutines.json();
 if(!Array.isArray(other.routines)||other.routines.some(row=>row.id===routineId))throw Error("task17c:foreign_routine_leak");
 const providerCalls=Number(usage.model_call_count);
 if(providerCalls>18)throw Error("task17c:shared_call_cap_exceeded");
 const proof={schema_version:1,task:"17c",lane:"chat-routine-file-delegation",head_sha:env.HEAD_SHA,
   status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",
   calls:providerCalls,registeredTools:result.names,actualRoutineOccurrence:true,duplicateTickStable:true,realDatabaseClock:true,distinctWorkerProcesses:true,coverage:assessCoverage({head:env.HEAD_SHA}),
   integrated_proven:false,released_proven:false};
 writeFileSync(files[0],JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
 writeFileSync(files[1],JSON.stringify({...scope,routineId,routineRunId,routineLocalDate:expected.localDate,replyId:result.done.reply.id,expectedProviderCalls:providerCalls})+"\n",{flag:"wx",mode:0o600});
 console.log("Task17C initial chat delegation lane complete; full autonomous acceptance is NOT_PROVEN.");
 }
}finally{
 await outsider?.context.close().catch(()=>{});
 await owner?.context.close().catch(()=>{});
 await browser.close().catch(()=>{});
 await db.end().catch(()=>{});
}
