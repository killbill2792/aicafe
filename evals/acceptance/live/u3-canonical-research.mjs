#!/usr/bin/env node
/** Deferred owner-authorized U3 real Luna acceptance: authenticated Supervisor,
 * source-to-tool evidence and independent SQL truth, without approving effects.
 * Never run in regular PR CI or without the shared-Luna owner authorization. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {matchedMoney} from "./u2-model-execution.mjs";

const fail=(reason)=>{throw Error("u3_canonical_research_live:"+reason);};
const query=async(db,sql,args=[])=> (await db.query(sql,args)).rows;
export function matchedCount(text,n){
 if(!Number.isSafeInteger(n)||n<0||typeof text!=="string")return false;
 return new RegExp("(^|[^0-9])"+String(n)+"([^0-9]|$)").test(text.replace(/,/g,""));
}
export function assertU3ObservedEvidence({model,tools,text,orders,lines,cents,proposals}){
 requireObservedProductionModel(model,"gpt-6-luna");
 if(!Array.isArray(tools)||!tools.includes("query_data"))fail("registered_research_tool_not_used");
 if(!matchedMoney(text,cents)||!matchedCount(text,orders)||!matchedCount(text,lines))
  fail("independent_source_result_mismatch");
 if(proposals!==0)fail("unapproved_effect_created");
}
async function login(browser,cafe){
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
 return {context,page};
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async({thread,text,clientMessageId})=>{
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),180000);
  const names=[];let pending="",done=null,error=null;
  try{
   const response=await fetch("/api/ai/threads/"+thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:ac.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text,locale:"en",attachmentIds:[],clientMessageId})});
   if(!response.ok||!response.body)return {names,done,error:"agent_http_"+response.status};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();
    if(frame.done)break;
    pending+=decoder.decode(frame.value,{stream:true});
    let index;
    while((index=pending.indexOf("\n\n"))>=0){
     const lines=pending.slice(0,index).split("\n");pending=pending.slice(index+2);
     const event=lines.find(line=>line.startsWith("event: "))?.slice(7);
     const payload=lines.find(line=>line.startsWith("data: "))?.slice(6);
     let data=null;try{data=JSON.parse(payload??"null")}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=data?.code??"agent_error";break;}
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_complete_turn")};
  }catch{return {names,done,error:"transport_failed"}}
  finally{clearTimeout(timer)}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
  !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))
  fail("registered_supervisor_turn_incomplete");
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||
   env.AICAFE_SHARED_LUNA_SCENARIO!=="u3-canonical-research"||
   env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
  fail("explicit_shared_luna_authorization_required");
 if(env.AICAFE_RESEARCH_SQL_ENABLED!=="true"||!env.AICAFE_RESEARCH_DATABASE_URL)
  fail("governed_research_connection_missing");
 // Trusted paid acceptance may run only against the disposable migrated DB.
 const researchURL=new URL(env.AICAFE_RESEARCH_DATABASE_URL);
 if(!["127.0.0.1","localhost"].includes(researchURL.hostname)||
   researchURL.port!=="54322"||researchURL.pathname!=="/postgres"||
   !["postgres:","postgresql:"].includes(researchURL.protocol)||
   decodeURIComponent(researchURL.username)!=="aicafe_research")
  fail("non_disposable_research_connection");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
  fail("private_output_and_scope_required");
 const root=realpathSync(process.cwd());
 const out=resolve(args[1]),scopeOut=resolve(args[3]);
 if(out===scopeOut)fail("different_evidence_files_required");
 for(const path of [out,scopeOut]){
  const parent=realpathSync(dirname(path));
  if((parent!==root&&!parent.startsWith(root+sep))||existsSync(path))
   fail("fresh_local_evidence_path_required");
 }
 const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
 if(!cafe?.owner||!other?.owner||cafe.businessId===other.businessId)
  fail("two_disposable_cafes_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let owner=null,foreign=null;
 await db.connect();
 try{
  const days=await query(db,"SELECT o.business_date::text AS day "+
   "FROM public.orders o WHERE o.business_id=$1 GROUP BY o.business_date "+
   "HAVING sum(o.net_sales_cents)>0 ORDER BY o.business_date DESC LIMIT 1",
   [cafe.businessId]);
  const date=days[0]?.day;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??""))fail("synthetic_source_date_missing");
  const [orders]=await query(db,"SELECT count(*)::int n, "+
   "sum(net_sales_cents)::text cents FROM public.orders "+
   "WHERE business_id=$1 AND business_date=$2",[cafe.businessId,date]);
  const [lines]=await query(db,"SELECT count(*)::int n,min(o.id)::text sample_order_id "+
   "FROM public.order_lines l JOIN public.orders o ON o.id=l.order_id "+
   "WHERE o.business_id=$1 AND o.business_date=$2",[cafe.businessId,date]);
  if(!orders||!lines||orders.n<1||lines.n<1||Number(orders.cents)<=0)
   fail("independent_oracle_missing");
  owner=await login(browser,cafe);
  const response=await owner.context.request.post("/api/ai/threads",{
   headers:{Origin:"http://127.0.0.1:3000"},
   data:{requestId:randomUUID(),title:"U3 source-backed analytical research"}});
  if(response.status()!==201)fail("thread_creation_failed");
  const thread=(await response.json()).thread?.id;
  if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_id_missing");
  const turn=await ownerTurn(owner.page,thread,
   "For "+date+", investigate this cafe's actual recorded order count, "+
   "order-line count and net sales, without multiplying the sales total "+
   "by joining to order lines. Use the available data sources, distinguish "+
   "recorded facts from missing coverage, and give "+cafe.currency+
   " with two decimals. This is research only: do not create or change anything.");
  const ownerMessage=await query(db,"SELECT id FROM public.ai_messages "+
   "WHERE business_id=$1 AND thread_id=$2 AND role='owner' AND client_message_id=$3",
   [cafe.businessId,thread,turn.clientMessageId]);
  if(ownerMessage.length!==1)fail("owner_message_missing");
  const usage=await readPersistedModelUsage(db,cafe.businessId,ownerMessage[0].id);
  const reply=await query(db,"SELECT structured_content FROM public.ai_messages "+
   "WHERE business_id=$1 AND thread_id=$2 AND role='supervisor' AND id=$3",
   [cafe.businessId,thread,turn.done.reply.id]);
  if(reply.length!==1)fail("saved_reply_missing");
  const blocks=reply[0].structured_content;
  if(!Array.isArray(blocks)||blocks.some(b=>b.type==="proposal_card"||b.type==="experiment_card"))
   fail("unexpected_effect_card");
  const text=blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
  const proposals=await query(db,"SELECT count(*)::int n FROM public.supervisor_proposals "+
   "WHERE business_id=$1 AND thread_id=$2",[cafe.businessId,thread]);
  assertU3ObservedEvidence({model:usage.model,tools:turn.names,text,
   orders:orders.n,lines:lines.n,cents:Number(orders.cents),proposals:proposals[0]?.n});
  foreign=await login(browser,other);
  const denied=await foreign.context.request.get("/api/ai/threads/"+thread);
  if(![401,403,404].includes(denied.status()))fail("cross_cafe_thread_visible");
  const scope={businessId:cafe.businessId,otherCafeId:other.businessId,
   ownerUserId:cafe.owner.userId,threadId:thread,replyId:turn.done.reply.id,
   businessDate:date,sampleOrderId:lines.sample_order_id,
   orderCount:orders.n,lineCount:lines.n,netCents:String(orders.cents)};
  writeFileSync(out,JSON.stringify({id:"u3-canonical-research",schema_version:1,
   head_sha:env.HEAD_SHA,status:"passed",observed_model:usage.model,
   checks:{sourceMatch:true,registeredResearch:true,foreignDenied:true,noEffect:true},
   observedModelCalls:Number(usage.model_call_count)})+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeOut,JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
 }finally{
  await foreign?.context.close().catch(()=>{});
  await owner?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"u3_canonical_research_live:unknown");process.exitCode=1});
