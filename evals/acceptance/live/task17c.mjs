#!/usr/bin/env node
// Initial cross-domain delegated lane. Not the complete autonomous release gate.
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,verifyCheckoutHead} from "./runner.mjs";
import {profiles,openOwner,createThread,makeQuote,delegate,rows} from "./task17c-world.mjs";
import {verifyRoutineAndFile,assessCoverage} from "./task17c-oracle.mjs";
const env=process.env;
assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||
 env.AICAFE_SHARED_LUNA_SCENARIO!=="17c"||env.AICAFE_SHARED_LUNA_HEAD!==env.HEAD_SHA)
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
   calls:providerCalls,registeredTools:result.names,coverage:assessCoverage({head:env.HEAD_SHA}),
   integrated_proven:false,released_proven:false};
 writeFileSync(files[0],JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
 writeFileSync(files[1],JSON.stringify({...scope,routineId,replyId:result.done.reply.id,expectedProviderCalls:providerCalls})+"\n",{flag:"wx",mode:0o600});
 console.log("Task17C initial chat delegation lane complete; full autonomous acceptance is NOT_PROVEN.");
}finally{
 await outsider?.context.close().catch(()=>{});
 await owner?.context.close().catch(()=>{});
 await browser.close().catch(()=>{});
 await db.end().catch(()=>{});
}
