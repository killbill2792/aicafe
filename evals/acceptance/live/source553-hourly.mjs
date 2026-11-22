#!/usr/bin/env node
/** Deferred, explicitly owner-authorized REAL Luna source-to-Supervisor check.
 * Creates only two disposable café hourly-reading fixtures; never calls Toast,
 * Vercel, hosted Supabase, or a paid model from PR CI. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {matchedMoney} from "./u2-model-execution.mjs";
const fail=reason=>{throw Error("source553_hourly_live:"+reason)};
export function assertSource553Hourly({model,tools,text,cents,otherCents,foreignDenied,proposals}){
 requireObservedProductionModel(model,"gpt-6-luna");
 if(!Array.isArray(tools)||!["get_peak_hours","query_data"].every(t=>tools.includes(t)))
  fail("registered_hourly_reader_not_used");
 if(!matchedMoney(text,cents)||matchedMoney(text,otherCents))
  fail("canonical_money_or_tenant_mismatch");
 if(!/provisional|not final|subject to change|pending closeout/i.test(text))
  fail("live_source_uncertainty_not_disclosed");
 if(!foreignDenied)fail("cross_cafe_thread_access");
 if(proposals!==0)fail("unexpected_effect");
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
async function ownerTurn(page,thread,message){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async({thread,message,clientMessageId})=>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),180000);
  const tools=[];let buffer="",done=null,error=null;
  try{
   const response=await fetch("/api/ai/threads/"+thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:controller.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text:message,locale:"en",attachmentIds:[],clientMessageId})});
   if(!response.ok||!response.body)return {tools,error:"http_"+response.status,done};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let index;while((index=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,index).split("\n");buffer=buffer.slice(index+2);
     const event=lines.find(x=>x.startsWith("event: "))?.slice(7);
     const payload=lines.find(x=>x.startsWith("data: "))?.slice(6);
     let data=null;try{data=JSON.parse(payload??"null")}catch{}
     if(event==="tool"&&typeof data?.name==="string")tools.push(data.name);
     if(event==="done"){done=data;break}
     if(event==="error"){error=data?.code??"agent_error";break}
    }
   }
   await reader.cancel().catch(()=>{});
   return {tools,done,error:error??(done?null:"incomplete")};
  }catch{return {tools,done,error:"transport_failed"}}
  finally{clearTimeout(timer)}
 },{thread,message,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
   !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))fail("owner_turn_incomplete");
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||
    env.AICAFE_SHARED_LUNA_SCENARIO!=="source553-hourly")
  fail("explicit_paid_shared_luna_authorization_required");
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
  fail("private_proof_and_scope_required");
 const proofRoot=realpathSync(env.AICAFE_SHARED_LUNA_PROOF_DIR??"/unconfigured");
 const output=resolve(args[1]),scopeOut=resolve(args[3]);
 if(output===scopeOut||[output,scopeOut].some(path=>
   realpathSync(dirname(path))!==proofRoot||existsSync(path)))
  fail("fresh_trusted_proof_directory_required");
 const [cafe,other]=TEST_CAFES;
 if(!cafe?.owner||!other?.owner||cafe.businessId===other.businessId)
  fail("independent_two_cafe_fixture_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let owner=null,foreign=null;
 await db.connect();
 try{
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:cafe.timezone??"America/Los_Angeles",
   year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail("cafe_date_unknown");
  const sourceHour=9,cents=1234,otherCents=9876;
  // Strictly disposable local DB, after the complete source migrations.
  for(const [id,value] of [[cafe.businessId,cents],[other.businessId,otherCents]]){
   await db.query(
    "INSERT INTO public.toast_today_live(business_id,business_date,read_at,net_sales_cents,orders,reading) "+
    "VALUES ($1,$2,now(),$3,2,$4::jsonb) ON CONFLICT(business_id) DO UPDATE SET "+
    "business_date=excluded.business_date,read_at=excluded.read_at,"+
    "net_sales_cents=excluded.net_sales_cents,orders=excluded.orders,reading=excluded.reading",
    [id,date,value,JSON.stringify({provisional:true,netSalesCents:value,
     locationsRead:1,locationsFailed:0,truncated:false,unparsedOrders:0,
     hourlyUnassignedOrders:0,
     hourlySales:[{hourLocal:sourceHour,netSalesCents:value,ordersCount:2}]})]);
  }
  const observed=await db.query(
   "SELECT business_id,net_sales_cents,status,data->>'hour_local' AS hour_local "+
   "FROM public.cv_sales_hours WHERE business_id IN ($1,$2) "+
   "AND business_date=$3 AND status='provisional'",
   [cafe.businessId,other.businessId,date]);
  if(observed.rows.length!==2||
   observed.rows.find(x=>x.business_id===cafe.businessId)?.net_sales_cents!=cents||
   observed.rows.find(x=>x.business_id===other.businessId)?.net_sales_cents!=otherCents||
   observed.rows.some(x=>x.hour_local!==String(sourceHour)))
   fail("real_two_cafe_canonical_oracle_missing");
  owner=await login(browser,cafe);
  const newThread=await owner.context.request.post("/api/ai/threads",{
   headers:{Origin:"http://127.0.0.1:3000"},
   data:{requestId:randomUUID(),title:"Source553 hourly source acceptance"}});
  if(newThread.status()!==201)fail("thread_creation_failed");
  const thread=(await newThread.json()).thread?.id;
  if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_missing");
  // Separate real owner turns make both canonical query and registered
  // specialized reader independently observable, never hand-fed model facts.
  const prompts=[
    "For this café on "+date+", use get_peak_hours to report the recorded "+
      "net sales at local 09:00. State when it is provisional, not final. "+
      "Show "+cafe.currency+" with two decimals. Do not modify anything.",
    "Cross-check the same "+date+" local 09:00 net sales using query_data "+
      "on cv_sales_hours for this café, and distinguish provisional live "+
      "records from a finalized closeout. A tab name never proves a "+
      "returning human. No proposals, changes or other effects.",
  ];
  const turns=[],usages=[];
  for(const prompt of prompts){
    const turn=await ownerTurn(owner.page,thread,prompt);
    const saved=await db.query("SELECT id FROM public.ai_messages "+
      "WHERE business_id=$1 AND thread_id=$2 AND role='owner' AND client_message_id=$3",
      [cafe.businessId,thread,turn.clientMessageId]);
    if(saved.rows.length!==1)fail("owner_message_missing");
    const usage=await readPersistedModelUsage(db,cafe.businessId,saved.rows[0].id);
    requireObservedProductionModel(usage.model,"gpt-6-luna");
    turns.push(turn);usages.push(usage);
  }
  const model=usages[1].model;
  const expectedProviderCalls=usages.reduce((n,u)=>n+Number(u.model_call_count),0);
  if(!Number.isSafeInteger(expectedProviderCalls)||expectedProviderCalls<2||
     expectedProviderCalls>18)fail("unbounded_provider_calls");
  const answer=await db.query("SELECT structured_content FROM public.ai_messages "+
   "WHERE business_id=$1 AND thread_id=$2 AND role='supervisor' AND id=$3",
   [cafe.businessId,thread,turns[1].done.reply.id]);
  if(answer.rows.length!==1)fail("persisted_response_missing");
  const blocks=answer.rows[0].structured_content;
  if(!Array.isArray(blocks)||blocks.some(b=>/proposal_card|experiment_card/.test(b.type??"")))
   fail("unexpected_effect_card");
  const resultText=blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
  const actions=await db.query("SELECT count(*)::integer AS count FROM public.supervisor_proposals "+
   "WHERE business_id=$1 AND thread_id=$2",[cafe.businessId,thread]);
  foreign=await login(browser,other);
  const denied=await foreign.context.request.get("/api/ai/threads/"+thread);
  const foreignDenied=[401,403,404].includes(denied.status());
  const selectedTools=turns.flatMap(t=>t.tools);
  assertSource553Hourly({model,tools:selectedTools,text:resultText,
   cents,otherCents,foreignDenied,proposals:actions.rows[0]?.count});
  writeFileSync(output,JSON.stringify({id:"source553-hourly",head_sha:env.HEAD_SHA,
   schema_version:1,status:"passed",observed_model:model,
   observedModelCalls:expectedProviderCalls,
   checks:{exactCanonicalCents:true,provisional:true,twoCafeIsolation:true,
    registeredHourlyReader:true,canonicalQuery:true,noEffect:true}})+"\n",
    {mode:0o600,flag:"wx"});
  writeFileSync(scopeOut,JSON.stringify({
    expectedProviderCalls,businessId:cafe.businessId,otherCafeId:other.businessId,
    ownerUserId:cafe.owner.userId,threadId:thread,businessDate:date,
    sourceCents:String(cents),otherSourceCents:String(otherCents),
    firstReplyId:turns[0].done.reply.id,replyId:turns[1].done.reply.id,
  })+"\n",{mode:0o600,flag:"wx"});
 }finally{
  await foreign?.context.close().catch(()=>{});
  await owner?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"source553_hourly_live:failed");process.exitCode=1});
