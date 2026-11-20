#!/usr/bin/env node
/** Real-Luna natural answer + source-bound generative presentation acceptance. Disposable shared runner only. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("task16e_live:"+code)};
const query=async(db,sql,args=[]) => (await db.query(sql,args)).rows;
const day=(date,timezone)=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
  timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(date).map(p=>[p.type,p.value]));
 return parts.year+"-"+parts.month+"-"+parts.day;
};
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
async function createThread(context){
 const response=await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"Task16E disposable owner acceptance"}});
 if(response.status()!==201)fail("thread_creation_failed");
 const data=await response.json();
 if(!/^[0-9a-f-]{36}$/i.test(data.thread?.id??""))fail("thread_identity_missing");
 return data.thread.id;
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async({thread,text,clientMessageId})=>{
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),180000);
  let buffer="",done=null,error=null;const names=[];
  let diagnosticStage=null,diagnosticEndReason=null,diagnosticModelCalls=null,diagnosticProviderFailures=null;
  try{
   const response=await fetch("/api/ai/threads/"+thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:ac.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text,locale:"en",attachmentIds:[],clientMessageId})});
   if(!response.ok||!response.body)return {error:"agent_http_"+response.status,names,done};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let at;while((at=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,at).split("\n");buffer=buffer.slice(at+2);
     const ev=lines.find(v=>v.startsWith("event: "))?.slice(7);
     const raw=lines.find(v=>v.startsWith("data: "))?.slice(6);
     let data=null;try{data=JSON.parse(raw??"null")}catch{}
     if(ev==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(ev==="done"){done=data;break}
     if(ev==="error"){
      error=data?.code??"agent_error";diagnosticStage=data?.diagnosticStage??null;
      diagnosticEndReason=data?.diagnosticEndReason??null;
      diagnosticModelCalls=data?.diagnosticModelCalls??null;
      diagnosticProviderFailures=data?.diagnosticProviderFailures??null;break;
     }
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_completed_turn"),
    diagnosticStage,diagnosticEndReason,diagnosticModelCalls,diagnosticProviderFailures};
  }catch{return {names,done,error:"transport_failed",diagnosticStage,diagnosticEndReason,diagnosticModelCalls,diagnosticProviderFailures}}
  finally{clearTimeout(timer)}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
    !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??"")){
  const reason=result.done?.endReason??result.diagnosticEndReason;
  const endReason=["complete","timeout","budget","provider_error","tool_errors"].includes(reason)?
   reason:"unknown";
  const validCode=typeof result.error==="string"&&/^[a-z][a-z0-9_-]{0,50}$/.test(result.error);
  const code=validCode?result.error:
   endReason!=="unknown"&&endReason!=="complete"?endReason:"model_incomplete";
  const calls=result.done?.usage?.modelCalls??result.diagnosticModelCalls;
  const reasons=result.done?.diagnosticProviderFailures??result.diagnosticProviderFailures;
  const providerFailures=Array.isArray(reasons)?reasons.slice(0,8).map(x=>[
   "max_output_tokens","content_filter","incomplete_other","missing_terminal","provider_failed","stream_error"
  ].includes(x)?x:"unknown"):[];
  console.log("task16e_safe_model_failure",JSON.stringify({
   code,endReason,stage:["setup","model","persist","finish"].includes(result.diagnosticStage)?
     result.diagnosticStage:result.done?"completed_frame":"unknown",
   calls:Number.isSafeInteger(calls)&&calls>=0?calls:null,
   providerFailures,
   tools:result.names.filter(n=>[
    "get_sales","query_data","present_response"].includes(n))
  }));
  fail("real_supervisor_"+code);
 }
 return {...result,clientMessageId};
}

async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="16e"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
   fail("trusted_shared_luna_candidate_required");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")fail("output_and_scope_required");
 const file=resolve(args[1]),scopeFile=resolve(args[3]),root=realpathSync(process.cwd());
 for(const f of [file,scopeFile]){
   const parent=realpathSync(dirname(f));
   if(parent===root||parent.startsWith(root+sep)||existsSync(f))fail("fresh_private_output_outside_repo_required");
 }
 if(file===scopeFile)fail("distinct_evidence_paths_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const cafe=TEST_CAFES[0],otherCafe=TEST_CAFES[1];
 if(!cafe?.owner||!otherCafe?.owner||cafe.businessId===otherCafe.businessId)fail("two_disposable_cafes_required");
 let connection=null,foreign=null;
 await db.connect();
 try{
   connection=await login(browser,cafe);
   const thread=await createThread(connection.context);
   const today=day(new Date(),cafe.timezone);
   // Existing seeded, saved records only. Select two contiguous complete historical days.
   const days=await query(db,"select business_date::text as day,net_sales_cents::text as cents from public.daily_rollups "+
    "where business_id=$1 and sales_data_status='actual' and business_date<$2::date and net_sales_cents is not null order by business_date desc limit 30",[cafe.businessId,today]);
   const pair=days.slice(0,-1).map((d,i)=>[days[i+1],d]).find(([a,b])=>Date.parse(b.day)-Date.parse(a.day)===86400000&&Number(a.cents)>0&&Number(b.cents)>0);
   if(!pair)fail("complete_seeded_sales_pair_missing");
   const [first,last]=pair;
   const simple=await ownerTurn(connection.page,thread,"In one sentence, explain what an espresso is. No chart needed.");
   const rich=await ownerTurn(connection.page,thread,"Show my recorded daily net sales from "+first.day+" through "+last.day+
      " inclusive. Give the amounts and a complete plain-language comparison, plus a useful daily trend chart and an optional follow-up suggestion.");
   const getProof=async(turn)=>{
     const owners=await query(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner' and client_message_id=$3",[cafe.businessId,thread,turn.clientMessageId]);
     if(owners.length!==1)fail("owner_message_not_persisted");
     const usage=await readPersistedModelUsage(db,cafe.businessId,owners[0].id);
     requireObservedProductionModel(usage.model,"gpt-6-luna");
     if(Number(usage.model_call_count)<1||Number(usage.input_tokens)<=0)fail("real_model_usage_missing");
     const rows=await query(db,"select structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and id=$3",
      [cafe.businessId,thread,turn.done.reply.id]);
     if(rows.length!==1||!Array.isArray(rows[0].structured_content))fail("persisted_reply_missing");
     return {blocks:rows[0].structured_content,model:usage.model,calls:Number(usage.model_call_count)};
   };
   const plain=await getProof(simple),answer=await getProof(rich);
   const plainText=plain.blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
   if(!plainText.trim()||plain.blocks.some(b=>b.type==="rich_presentation")||plainText.length>800)fail("simple_answer_overformatted");
   const richText=answer.blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
   if(!richText.trim()||!rich.names.includes("present_response")||
      !rich.names.includes("get_sales"))fail("real_adaptive_tool_or_text_missing");
   const ui=answer.blocks.find(b=>b.type==="rich_presentation"&&b.version===1);
   const panel=ui?.panels?.find(x=>x.kind==="line"||x.kind==="bar");
   if(!panel||panel.unit!=="cents"||panel.currency!==cafe.currency||panel.from!==first.day||panel.to!==last.day||
      panel.points.length!==2||!pair.every(d=>panel.points.some(x=>x.label===d.day&&x.value===Number(d.cents))))
       fail("chart_not_equal_to_covered_seeded_records");
   if(!Array.isArray(ui.suggestions)||ui.suggestions.length<1)fail("followup_missing");
   const page=connection.page;
   await page.goto("/en?thread="+encodeURIComponent(thread));
   await page.setViewportSize({width:390,height:844});
   const container=page.locator('[data-work-message="'+rich.done.reply.id+'"]');
   const presentation=container.getByTestId("supervisor-rich-presentation");
   await presentation.waitFor({timeout:30000});
   const details=presentation.locator("details summary").first();
   await details.click();
   const table=presentation.getByRole("table").first();await table.waitFor({timeout:30000});
   for(const d of pair){
     const expected=new Intl.NumberFormat("en-US",{style:"currency",currency:cafe.currency}).format(Number(d.cents)/100);
     const row=table.getByRole("row").filter({hasText:d.day});
     if(await row.getByRole("cell",{name:expected,exact:true}).count()!==1)fail("rendered_value_mismatch");
   }
   if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))fail("mobile_horizontal_overflow");
   const input=page.locator("#supervisor-home-composer");
   await input.fill("");
   await presentation.getByRole("button",{name:ui.suggestions[0],exact:true}).click();
   if(await input.inputValue()!==ui.suggestions[0])fail("suggestion_not_editable");
   const msgCount=await query(db,"select count(*)::int as n from public.ai_messages where business_id=$1 and thread_id=$2",[cafe.businessId,thread]);
   if(msgCount[0].n!==4)fail("suggestion_auto_submitted");
   await page.reload();await presentation.waitFor({timeout:30000});
   foreign=await login(browser,otherCafe);
   const denied=await foreign.context.request.get("/api/ai/threads/"+thread+"/messages");
   if(![401,403,404].includes(denied.status()))fail("foreign_history_not_denied");
   const effects=await query(db,"select count(*)::int as n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[cafe.businessId,thread]);
   if(effects[0].n!==0)fail("unexpected_effect_draft");
   const modelCalls=plain.calls+answer.calls;
   writeFileSync(file,JSON.stringify({schema_version:1,id:"16e",head_sha:env.HEAD_SHA,status:"passed",observed_model:answer.model,
    modelCalls,checks:{simpleText:true,plainLanguageAndChart:true,exactCanonicalValues:true,editableSuggestion:true,historyReload:true,foreignDenied:true,noEffect:true}},null,2)+"\n",{mode:0o600,flag:"wx"});
   writeFileSync(scopeFile,JSON.stringify({businessId:cafe.businessId,ownerUserId:cafe.owner.userId,otherCafeId:otherCafe.businessId,
    threadId:thread,plainReplyId:simple.done.reply.id,richReplyId:rich.done.reply.id,firstDay:first.day,lastDay:last.day,
    firstCents:first.cents,lastCents:last.cents,expectedProviderCalls:modelCalls},null,2)+"\n",{mode:0o600,flag:"wx"});
   console.log("Task16E real model chose useful source-bound presentation and preserved ordinary text, reload and owner controls.");
 }finally{
   await foreign?.context.close().catch(()=>{});await connection?.context.close().catch(()=>{});
   await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"task16e_live:unknown");process.exitCode=1});
