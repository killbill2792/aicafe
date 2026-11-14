#!/usr/bin/env node
/* Owner-authenticated real-model pilot on localhost; NEVER a fake provider. */
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync,realpathSync} from "node:fs";
import {resolve,dirname,isAbsolute,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {scoreAcceptance} from "../evidence.mjs";
import {assertLocalLiveEnvironment,assertLiveManifest} from "./preflight.mjs";

const error=code=>{throw new Error("live_capture:"+code);};
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
/** A logged fallback is not evidence of the production Luna model. */
export function requireObservedProductionModel(observed,expected){
 if(typeof expected!=="string"||!expected||observed!==expected)
  error("unexpected_runtime_model");
 return observed;
}
export function verifyCheckoutHead(expected,readHead=()=>execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()){
 if(!/^[a-f0-9]{40}$/.test(expected??"")||readHead()!==expected)
  error("checkout_does_not_match_attested_head");
 return expected;
}
export function toScaled(value){
 const s=String(value);
 if(!/^-?\d+(?:\.\d{1,4})?$/.test(s))error("precision_not_canonical");
 const neg=s[0]==="-",parts=(neg?s.slice(1):s).split(".");
 const b=(BigInt(parts[0])*10000n+BigInt((parts[1]??"").padEnd(4,"0")))*(neg?-1n:1n);
 if(b>BigInt(Number.MAX_SAFE_INTEGER)||b<BigInt(Number.MIN_SAFE_INTEGER))error("stock_overflow");
 return Number(b);
}
export function stockRows(rows){
 const seen=new Set();
 return rows.map(r=>{
  const ingredient=slug(r.name);
  if(seen.has(ingredient)||!ingredient||!["g","ml","each"].includes(r.base_unit))
   error("ambiguous_ingredient");
  seen.add(ingredient);
  return {ingredient,unit:r.base_unit+"_x10000",quantity:toScaled(r.quantity_base)};
 }).sort((a,b)=>a.ingredient.localeCompare(b.ingredient));
}
export function expectedAfter(before,expectedWrites){
 const map=new Map(before.map(x=>[x.ingredient,{...x}]));
 for(const w of expectedWrites){
  const x=map.get(w.ingredient);
  if(!x||x.unit!==w.unit)error("invalid_human_labeled_effect");
  x.quantity+=w.delta;
  if(!Number.isSafeInteger(x.quantity))error("stock_overflow");
 }
 return [...map.values()].sort((a,b)=>a.ingredient.localeCompare(b.ingredient));
}
export function ledgerWrites(before,after,expectedWrites){
 const ids=new Set(before.map(x=>x.line_id)),used=new Set();
 return after.filter(x=>!ids.has(x.line_id)&&x.voided_at===null)
  .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||
     String(a.line_id).localeCompare(String(b.line_id)))
  .map((r,i)=>{
   const ingredient=slug(r.name),unit=r.base_unit+"_x10000",delta=toScaled(r.quantity_base);
   const matches=expectedWrites.map((line,index)=>({line,index})).filter(x=>
    !used.has(x.index)&&x.line.ingredient===ingredient&&x.line.unit===unit&&x.line.delta===delta);
   const savedCost=r.cost_cents===null?null:Number(r.cost_cents);
   if(!Number.isSafeInteger(savedCost)&&savedCost!==null)error("invalid_saved_cost");
   const matched=matches.find(x=>!Object.hasOwn(x.line,"costCents")||x.line.costCents===savedCost);
   if(matches.length&&!matched)error("saved_purchase_cost_mismatch");
   if(matched)used.add(matched.index);
   return {sourceLineId:matched?.line.sourceLineId??"unexpected_"+i,
    ingredient,unit,delta,receiptId:r.id,status:"committed"};
  });
}
export function newPurchaseProposals(before,after){
 const ids=new Set(before.map(x=>x.id));
 return after.filter(x=>!ids.has(x.id)&&x.capability_id==="maya.inventory_purchase.v1")
  .sort((a,b)=>Number(a.canonical_effect_payload?.receiptLineIndex??999)-
    Number(b.canonical_effect_payload?.receiptLineIndex??999)||
    String(a.created_at).localeCompare(String(b.created_at))||
    String(a.id).localeCompare(String(b.id)));
}
export function proposalLines(before,after){
 return newPurchaseProposals(before,after).map((p,i)=>{
   const e=p.canonical_effect_payload;
   if(!e||typeof e!=="object")error("invalid_observed_proposal");
   // Observed identifiers must NEVER come from human expected labels.
   return {lineId:"proposal_"+i,
     name:e.name??"",quantity:e.quantity??null,unit:e.unit??null,
     costCents:e.costCents??null,confidence:e.ingredientId?"verified":"needs_review"};
  });
}
/** Gate any simulated owner click on independently pre-reviewed exact effects.
 * Never approve a model-suggested extra line or mismatched cost/ingredient. */
export function planOwnerApprovals(label,before,after){
 const expected=label.expected;
 const observed=proposalLines(before,after);
 const sorted=items=>[...items].sort((a,b)=>a.lineId.localeCompare(b.lineId));
 if(JSON.stringify(sorted(observed))!==JSON.stringify(sorted(expected.extracted)))
  error("proposal_mismatch_before_approval");
 if(expected.authorization!=="owner_click")return [];
 const proposals=newPurchaseProposals(before,after);
 return expected.approvals.map(selection=>{
  const n=Number(selection.lineId.slice("proposal_".length));
  const p=proposals[n],write=expected.writes.find(x=>x.sourceLineId===selection.sourceLineId);
  const data=p?.canonical_effect_payload;
  const cost=Object.hasOwn(write??{},"costCents")?write.costCents:null;
  if(!p||!write||p.status!=="draft"||!Number.isSafeInteger(p.revision)||p.revision<1||
     !/^[0-9a-f-]{36}$/i.test(p.id??"")||!data?.ingredientId||
     slug(data.name)!==write.ingredient||data.costCents!==cost)
   error("unreviewed_proposal_cannot_be_approved");
  return {proposalId:p.id,revision:p.revision};
 });
}
const stockSql="select i.name,i.base_unit,coalesce(sum(p.quantity_base) filter (where p.voided_at is null),0)::text quantity_base "+
 "from public.ingredients i left join public.pantry_stock_purchases p "+
 "on p.business_id=i.business_id and p.ingredient_id=i.id "+
 "where i.business_id=$1 group by i.id,i.name,i.base_unit order by i.id";
const ledgerSql="select p.id::text,p.line_id::text,p.quantity_base::text,p.created_at::text,"+
 "p.voided_at::text,p.cost_cents,i.name,i.base_unit from public.pantry_stock_purchases p "+
 "join public.ingredients i on i.id=p.ingredient_id and i.business_id=p.business_id "+
 "where p.business_id=$1 order by p.created_at,p.line_id";
const proposalSql="select id::text,capability_id,canonical_effect_payload,revision,status,created_at::text "+
 "from public.supervisor_proposals where business_id=$1 and thread_id=$2 order by created_at,id";
async function rows(db,sql,params){return (await db.query(sql,params)).rows}
async function stock(db,id){return stockRows(await rows(db,stockSql,[id]))}
async function ledger(db,id){return rows(db,ledgerSql,[id])}
async function proposals(db,id,thread){return rows(db,proposalSql,[id,thread])}
/** Verify model usage using the table actually migrated by AI CAFE.
 * Backend usage identifiers are NOT provider-native request IDs. */
export async function readPersistedModelUsage(db,businessId,ownerMessageId,{
 attempts=60,pause=()=>new Promise(r=>setTimeout(r,250))
}={}){
 const sql="select id::text,provider,model,input_tokens,model_call_count "+
  "from public.ai_usage_events where business_id=$1 and owner_message_id=$2 "+
  "order by created_at desc limit 1";
 for(let i=0;i<attempts;i++){
  const data=(await rows(db,sql,[businessId,ownerMessageId]))[0];
  if(data){
   const tokens=Number(data.input_tokens),calls=Number(data.model_call_count);
   if(data.provider!=="openai"||typeof data.model!=="string"||!data.model||
      data.model==="unknown"||!Number.isSafeInteger(tokens)||tokens<=0||
      !Number.isSafeInteger(calls)||calls<=0||
      !/^[0-9a-f-]{36}$/i.test(data.id??""))
    error("model_usage_unverified");
   return data;
  }
  if(i+1<attempts)await pause();
 }
 error("model_usage_not_persisted");
}
export function requireCompletedTurn(actual){
 if(actual?.error||actual?.done?.endReason!=="complete"||
    !/^[0-9a-f-]{36}$/i.test(actual?.done?.reply?.id??"")||
    !Array.isArray(actual?.done?.reply?.blocks)||
    actual.done.reply.blocks.length===0)
  error("agent_turn_not_complete");
 return actual.done;
}
async function checked(response,code,status=200){
 if(response.status()!==status)error(code+"_"+response.status());
 return response.json();
}
async function makeThread(context){
 const x=await checked(await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"Private acceptance run"}}),"thread_create",201);
 if(!/^[0-9a-f-]{36}$/i.test(x.thread?.id??""))error("thread_missing");
 return x.thread.id;
}
async function upload(context,thread,file){
 const x=await checked(await context.request.post("/api/ai/threads/"+thread+"/attachments",{
  headers:{Origin:"http://127.0.0.1:3000"},
  multipart:{file:{name:"private_receipt"+file.real.slice(file.real.lastIndexOf(".")),
   mimeType:file.mime,buffer:file.raw}},timeout:45_000}),"receipt_upload",201);
 if(!/^[0-9a-f-]{36}$/i.test(x.attachment?.id??""))error("attachment_missing");
 return x.attachment.id;
}
/** The same authenticated approval endpoint used by the one-screen owner card.
 * This uses only explicitly labeled expected proposal IDs on disposable cafés. */
async function approveExpectedPurchases(context,thread,steps){
 for(const step of steps){
  const response=await checked(await context.request.post(
   "/api/ai/threads/"+thread+"/proposals",{
    headers:{Origin:"http://127.0.0.1:3000"},
    data:{action:"approve",proposalId:step.proposalId,revision:step.revision},
    timeout:45_000
   }),"purchase_owner_approval",200);
  if(response?.proposal?.proposalId!==step.proposalId||
     response.proposal?.state!=="applied")
   error("approved_effect_not_committed");
 }
 return steps.length;
}
/** Measure actual streamed bytes, not a model-reported latency. */
async function actualTurn(page,thread,text,attachmentIds,clientMessageId){
 return page.evaluate(async input=>{
  const start=performance.now(),controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),165_000);
  try{
   const response=await fetch("/api/ai/threads/"+input.thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:controller.signal,
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({clientMessageId:input.clientMessageId,text:input.text,
     attachmentIds:input.attachmentIds,locale:"en"})});
   if(!response.ok||!response.body)return {error:"agent_http_"+response.status};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   let chunk="",first=null,done=null,failed=null;
   while(!done&&!failed){
    const frame=await reader.read();if(frame.done)break;
    chunk+=decoder.decode(frame.value,{stream:true});
    let sep;
    while((sep=chunk.indexOf("\n\n"))>=0){
     const block=chunk.slice(0,sep);chunk=chunk.slice(sep+2);
     const e=block.split("\n").find(x=>x.startsWith("event: "))?.slice(7);
     const dataLine=block.split("\n").find(x=>x.startsWith("data: "));
     let data;try{data=JSON.parse(dataLine?.slice(6)??"null")}catch{}
     if(first===null&&((e==="delta"&&data?.text?.trim())||e==="tool"||e==="done"))
      first=Math.round(performance.now()-start);
     if(e==="done"){done=data;break}
     if(e==="error"){failed=data?.code??"agent_error";break}
    }
   }
   await reader.cancel().catch(()=>{});
   return {error:failed??(done?null:"no_completed_reply"),done,
    firstUsefulMs:first??0,completedMs:Math.round(performance.now()-start)};
  }finally{clearTimeout(timeout)}
 },{thread,text,attachmentIds,clientMessageId});
}
async function login(browser,cafe){
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30_000});
 return {context,page};
}
function textFromReply(reply){
 if(typeof reply?.text==="string")return reply.text.slice(0,8000);
 return Array.isArray(reply?.blocks)?reply.blocks.filter(x=>x.type==="text")
  .map(x=>x.text??"").join(" ").slice(0,8000):"";
}
function ownerLabel(caseLabel,before,otherBefore){
 return {...caseLabel,input:{text:caseLabel.input.text,
  assetSha256:caseLabel.input.assetSha256??null},
  expected:{...caseLabel.expected,before,
    after:expectedAfter(before,caseLabel.expected.writes),
    otherTenant:{before:otherBefore,after:otherBefore}}};
}
export function failureCode(cause){
 if(cause instanceof Error&&/^(?:live_capture|live_preflight|acceptance_integrity):[a-z0-9_]+$/.test(cause.message))
  return cause.message;
 return "live_capture:unclassified_failure";
}
export function allCasesAccountedFor(expected,observed,failures){
 return Number.isSafeInteger(expected)&&observed===expected&&failures.length===0;
}
export async function runLive(manifest,prepared,env,outputPath){
 const {expectedModelId}=assertLocalLiveEnvironment(env);
 // The no-secret evaluator-integrity job deliberately does not run npm ci.
 // Only real paid execution loads the pinned browser and DB dependencies.
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL,
  options:"-c default_transaction_read_only=on"});
 const browser=await chromium.launch({headless:true});
 const contexts=new Map(),threads=new Map(),failures=[];
 const truth={schemaVersion:1,suiteId:manifest.suiteId,
  datasetKind:"human-labeled-holdout",cases:[]};
 const observation={schemaVersion:1,suiteId:manifest.suiteId,
  capture:{mode:"live_provider",headSha:env.HEAD_SHA,
   runId:env.GITHUB_RUN_ID??"owner_local_run",modelId:"pending"},cases:[]};
 const cafes=new Map(TEST_CAFES.map(x=>[x.businessId,x]));
 await db.connect();
 try{
  for(const {label,file} of prepared){
   try{
   const cafe=cafes.get(label.actor.businessId);
   const other=TEST_CAFES.find(x=>x.businessId!==label.actor.businessId);
   if(!cafe||!other)error("unknown_seed_cafe");
   let session=contexts.get(cafe.businessId);
   if(!session){session=await login(browser,cafe);contexts.set(cafe.businessId,session)}
   const key=cafe.businessId+"::"+label.threadKey;
   let thread=threads.get(key);
   if(!thread){thread=await makeThread(session.context);threads.set(key,thread)}
   const [before,otherBefore,oldLedger,oldProposals]=await Promise.all([
    stock(db,cafe.businessId),stock(db,other.businessId),ledger(db,cafe.businessId),
    proposals(db,cafe.businessId,thread)]);
   const attachmentIds=file?[await upload(session.context,thread,file)]:[];
   const msgId=randomUUID(),turnStarted=Date.now();
   const actual=await actualTurn(session.page,thread,label.input.text,attachmentIds,msgId);
   requireCompletedTurn(actual);
   const proposalsAfterModel=await proposals(db,cafe.businessId,thread);
   const approvalSteps=planOwnerApprovals(label,oldProposals,proposalsAfterModel);
   const approvalsApplied=await approveExpectedPurchases(session.context,thread,approvalSteps);
   const [after,otherAfter,newLedger,newProposals,ownerMessages]=await Promise.all([
    stock(db,cafe.businessId),stock(db,other.businessId),ledger(db,cafe.businessId),
    proposals(db,cafe.businessId,thread),
    rows(db,"select id::text from public.ai_messages where business_id=$1 "+
     "and thread_id=$2 and client_message_id=$3 and role='owner'",
     [cafe.businessId,thread,msgId])]);
   requireCompletedTurn(actual);
   if(ownerMessages.length!==1)error("owner_message_not_persisted");
   const model=await readPersistedModelUsage(db,cafe.businessId,ownerMessages[0].id);
   requireObservedProductionModel(model.model,expectedModelId);
   if(observation.capture.modelId!=="pending"&&observation.capture.modelId!==model.model)
    error("mixed_models_in_same_benchmark");
   observation.capture.modelId=model.model;
   const saved=ledgerWrites(oldLedger,newLedger,label.expected.writes);
   const extracted=proposalLines(oldProposals,newProposals);
   const blocks=actual.done?.reply?.blocks??[];
   const clarifications=blocks.filter(x=>x.type==="clarify").length;
   const status=saved.length?"updated":
    (clarifications>0||extracted.some(x=>x.confidence==="needs_review"))?"needs_review":"no_action";
   truth.cases.push(ownerLabel(label,before,otherBefore));
   observation.cases.push({
    id:label.id,actor:label.actor,executed:true,
    sourceSha256:createHash("sha256").update(label.input.text).digest("hex"),
    assetSha256:label.input.assetSha256??null,
    readbackKind:"independent_scoped_sql",
    dbBefore:before,dbAfter:after,otherTenantBefore:otherBefore,otherTenantAfter:otherAfter,
    receiptWrites:saved,extracted,outcome:status,
    reply:textFromReply(actual.done?.reply),clarifications,
    approvalPath:label.expected.authorization,approvedPurchaseLines:approvalsApplied,
    latency:{firstUsefulMs:actual.firstUsefulMs,
     completedMs:Math.max(actual.firstUsefulMs,Date.now()-turnStarted)},
    // A durable backend audit row, NOT an OpenAI request ID; provenance
    // remains an explicit limitation in scorer's live-mode status.
    modelRequestId:"usage_"+model.id.replaceAll("-",""),
    auditModel:model.model,auditEvidenceType:"ai_usage_event_not_provider_request_id"
   });
   }catch(cause){
    failures.push({id:label.id,code:failureCode(cause)});
   }
  }
  let score=null,scoreError=null;
  if(allCasesAccountedFor(manifest.cases.length,observation.cases.length,failures)){
   try{score=scoreAcceptance(truth,observation,{mode:"live"});}
   catch(cause){scoreError=failureCode(cause);}
  }else scoreError="live_capture:cases_missing_or_failed";
  const repo=realpathSync(process.cwd()),folder=realpathSync(dirname(outputPath));
  if(!isAbsolute(outputPath)||folder===repo||folder.startsWith(repo+sep))
   error("private_output_outside_git_required");
  writeFileSync(outputPath,JSON.stringify({truth,observations:observation,score,
   failureSummary:{casesRequested:manifest.cases.length,casesCaptured:observation.cases.length,
    failures,scoreError},
   limitations:["Before-baselines from independent local SQL, expected deltas from human labels",
    "Agent-turn audit ID is not external provider request ID",
    "Subjective human ratings and competitor comparison require separate review"]},null,2),
   {mode:0o600,flag:"wx"});
  if(!score)error("live_acceptance_failed_private_report_written");
  return {status:score.status,cases:score.cases,latencyMs:score.latencyMs};
 }finally{
  await Promise.all([...contexts.values()].map(x=>x.context.close().catch(()=>{})));
  await browser.close();await db.end();
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  assertLocalLiveEnvironment(process.env);
  const args=process.argv.slice(2);
  if(args.length!==6||args[0]!=="--labels"||args[2]!=="--assets"||args[4]!=="--output")
   error("usage_labels_assets_output");
  verifyCheckoutHead(process.env.HEAD_SHA);
  const manifest=JSON.parse(readFileSync(resolve(args[1]),"utf8"));
  const owners=new Map(TEST_CAFES.map(c=>[c.businessId,c.owner.userId]));
  const prepared=assertLiveManifest(manifest,{assetRoot:resolve(args[3]),allowedOwners:owners});
  const result=await runLive(manifest,prepared,process.env,resolve(args[5]));
  console.log("OBJECTIVE LIVE CONTRACT:",JSON.stringify(result));
  console.log("Human interpretation, external provider ID and Muse/Grok comparison remain separately unverified.");
 }catch(e){
  console.error("LIVE ACCEPTANCE NOT PASSED:",e instanceof Error?e.message.slice(0,160):"unknown");
  process.exitCode=1;
 }
}
