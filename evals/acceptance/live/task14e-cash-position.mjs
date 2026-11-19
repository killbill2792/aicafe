#!/usr/bin/env node
/** Actual registered Task14E cash position owner/browser journey. Only disposable shared
 * Luna runner; no external supplier request, real payment or production data.
 * Host attestation independently checks selected model tools, source evidence,
 * owner messages, and tenant isolation. */
import {randomUUID,createHash} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("task14e_cash_position:"+code)};
const query=async(db,sql,args=[]) => (await db.query(sql,args)).rows;
const day=(date,timezone)=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
  timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(date).map(p=>[p.type,p.value]));
 return parts.year+"-"+parts.month+"-"+parts.day;
};
const shift=(d,n)=>{const v=new Date(d+"T12:00:00Z");v.setUTCDate(v.getUTCDate()+n);
 return v.toISOString().slice(0,10)};
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
  data:{requestId:randomUUID(),title:"Task14E cash position disposable owner acceptance"}});
 if(response.status()!==201)fail("thread_creation_failed");
 const data=await response.json();
 if(!/^[0-9a-f-]{36}$/i.test(data.thread?.id??""))fail("thread_identity_missing");
 return data.thread.id;
}
async function ownerTurn(page,thread,text,phase){
 if(!/^[a-z_]{1,50}$/.test(phase))fail("invalid_turn_phase");
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
  console.log("task14e_safe_model_failure",JSON.stringify({
   phase,code,endReason,stage:["setup","model","persist","finish"].includes(result.diagnosticStage)?
     result.diagnosticStage:result.done?"completed_frame":"unknown",
   calls:Number.isSafeInteger(calls)&&calls>=0?calls:null,
   providerFailures,
   tools:result.names.filter(n=>[
    "get_cashflow_evidence","get_bills","get_expenses","calculate"].includes(n))
  }));
  fail("real_supervisor_"+code);
 }
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="14e-cash-position"||
    env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
  fail("trusted_shared_luna_candidate_required");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||!args[1]||
   args[2]!=="--scope-output"||!args[3])fail("output_and_scope_required");
 const file=resolve(args[1]),scopeFile=resolve(args[3]);
 const root=realpathSync(process.cwd());
 for(const f of [file,scopeFile]){
  const parent=realpathSync(dirname(f));
  if(parent===root||parent.startsWith(root+sep)||existsSync(f))
   fail("fresh_private_output_outside_repo_required");
 }
 if(file===scopeFile)fail("distinct_evidence_paths_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const cafe=TEST_CAFES[0],otherCafe=TEST_CAFES[1];
 if(!cafe?.owner||!otherCafe?.owner||cafe.businessId===otherCafe.businessId)
  fail("two_disposable_cafes_required");


 let connection=null,foreign=null;
 await db.connect();
 try{
  connection=await login(browser,cafe);
  const thread=await createThread(connection.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId:thread,otherCafeId:otherCafe.businessId};
  const count=async(sql,args)=>Number((await query(db,sql,args))[0].n);
  if(await count("select count(*) n from public.uploads where business_id=$1 and financial_source_sha256 is not null",[scope.businessId]))fail("expected_empty_statement_source");
  const beforeExpenses=await count("select count(*) n from public.expenses where business_id=$1",[scope.businessId]);
  const turn=async(prompt,phase)=>{
   const result=await ownerTurn(connection.page,thread,prompt,phase);
   if(!result.names.includes("get_cashflow_evidence")||!result.names.includes("get_bills"))fail("missing_real_financial_reads");
   const msg=(await query(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",[scope.businessId,thread,result.clientMessageId]))[0];
   if(!msg)fail("owner_message_not_persisted");
   const usage=await readPersistedModelUsage(db,scope.businessId,msg.id);
   requireObservedProductionModel(usage.model,"gpt-6-luna");
   const calls=Number(usage.model_call_count);
   if(calls<2||Number(usage.input_tokens)<=0)fail("real_multistep_model_usage_missing");
   const reply=result.done.reply;
   const answer=typeof reply.text==="string"?reply.text:(reply.blocks??[]).filter(b=>b.type==="text").map(b=>b.text??"").join(" ");
   if(!answer||!/bill|cost|expense/i.test(answer)||!/unknown|cannot|can't|not (?:know|verified|available|connected|able|a live)|unavailable|not have/i.test(answer))
    fail("missing_useful_partial_financial_answer");
   return {replyId:reply.id,answer,calls,model:usage.model};
  };
  const none=await turn("My bank and QuickBooks are not connected. Use the saved café data: what do we know about recurring bills and cash available? Tell me what is missing, give me useful next steps even without connected accounts. Do not change anything.","no_source");
  const today=day(new Date(),cafe.timezone),from=shift(today,-30),to=shift(today,-29);
  const csv="Date,Description,Amount,Balance\n"+from+",Historic deposit,100.00,12300.00\n"+to+",Historic deposit,45.67,12345.67\n";
  const digest=createHash("sha256").update(csv).digest("hex");
  await connection.page.goto("/en/add-cost/statement");
  await connection.page.locator('input[type=file]').setInputFiles({name:"cash-evidence.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});
  await connection.page.getByText("Balance checks out",{exact:true}).waitFor({timeout:30000});
  await connection.page.getByRole("checkbox",{name:/Use this original statement/}).check();
  await connection.page.getByRole("textbox",{name:/Account nickname/}).fill("Historical Current Account");
  await connection.page.getByRole("button",{name:"Save all",exact:true}).click();
  await connection.page.getByText("Saved",{exact:true}).waitFor({timeout:30000});
  const row=(await query(db,"select id,financial_to::text,financial_closing_cents,financial_owner_user_id from public.uploads where business_id=$1 and financial_source_sha256=$2",[scope.businessId,digest]))[0];
  if(!row||Number(row.financial_closing_cents)!==1234567||row.financial_to!==to||row.financial_owner_user_id!==scope.ownerUserId)fail("statement_readback_mismatch");
  const dated=await turn("Now use my recently imported financial evidence and saved recurring bills. What is my latest documented balance and its date, is it my live available cash, and what should I do about the uncertainty? My bank and QuickBooks are still not connected. Read the saved records rather than assuming a balance. Do not change anything.","dated_source");
  if(!/12[,\s]?345[.]67/.test(dated.answer)||!dated.answer.includes(to)&&!dated.answer.includes(String(Number(to.slice(-2))))||!/historic|as of|dated|statement/i.test(dated.answer))fail("historical_balance_or_date_missing");
  foreign=await login(browser,otherCafe);
  if((await foreign.context.request.get("/api/ai/threads/"+thread+"/proposals")).status()===200)fail("foreign_thread_visible");
  const foreignSession=await foreign.context.request.get("/api/ai/threads/"+thread);
  if(foreignSession.status()===200)fail("foreign_finance_thread_visible");
  if(await count("select count(*) n from public.expenses where business_id=$1",[scope.businessId])!==beforeExpenses)fail("documentary_cash_changed_expenses");
  if(await count("select count(*) n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,thread]))fail("read_only_finance_generated_effect");
  const realModelCalls=none.calls+dated.calls;
  const proof={schema_version:1,id:"14e-cash-position",head_sha:env.HEAD_SHA,status:"passed",observed_model:dated.model,
   modelCalls:realModelCalls,checks:{missingSourcesUsefulAnswer:true,ownerConfirmedHistoricalBalance:true,datedNotLive:true,noExpenseOrEffect:true,foreignCafeDenied:true}};
  writeFileSync(file,JSON.stringify(proof,null,2)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeFile,JSON.stringify({...scope,uploadId:row.id,initialReplyId:none.replyId,datedReplyId:dated.replyId,expectedProviderCalls:realModelCalls},null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Task14E disconnected cash evidence and dated statement owner journey.");
 }finally{
  await foreign?.context.close().catch(()=>{});await connection?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"task14e_cash_position:unknown");process.exitCode=1});

/** Shared helpers for the other approved Task14E browser scenarios. No provider
 * substitution or seeded effect success; every model turn goes through the real
 * owner session and every new effect is committed through the owner card. */
export async function withFinanceJourney(id,body){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!==id||
    env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")fail("trusted_shared_luna_candidate_required");
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
 let connection=null,foreign=null,modelCalls=0,model=null;
 await db.connect();
 try{
  connection=await login(browser,cafe);foreign=await login(browser,otherCafe);
  const threadId=await createThread(connection.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId,otherCafeId:otherCafe.businessId};
  const read=(statement,args=[])=>query(db,statement,args);
  const count=async(statement,args=[])=>Number((await read(statement,args))[0].n);
  const expenses=()=>count("select count(*) n from public.expenses where business_id=$1",[scope.businessId]);
  const stock=()=>count("select count(*) n from public.pantry_stock_purchases where business_id=$1",[scope.businessId]);
  const receipts=()=>count("select count(*) n from public.connector_provider_receipts where business_id=$1",[scope.businessId]);
  const initial=[await expenses(),await stock(),await receipts()];
  const today=day(new Date(),cafe.timezone);
  const turn=async(prompt,phase,required,capability=null)=>{
   const result=await ownerTurn(connection.page,threadId,prompt,phase);
   for(const name of required)if(!result.names.includes(name))fail("registered_tool_missing_"+name);
   const owner=(await read("select id from public.ai_messages where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
     [scope.businessId,threadId,result.clientMessageId]))[0];
   if(!owner)fail("owner_message_not_persisted");
   const usage=await readPersistedModelUsage(db,scope.businessId,owner.id);
   requireObservedProductionModel(usage.model,"gpt-6-luna");model=usage.model;
   if(Number(usage.model_call_count)<2||Number(usage.input_tokens)<=0)fail("real_multistep_model_usage_missing");
   modelCalls+=Number(usage.model_call_count);
   const reply=(await read("select id,text_content,structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and id=$3 and role='supervisor'",[scope.businessId,threadId,result.done.reply.id]))[0];
   if(!reply)fail("owner_reply_missing");
   const cards=reply.structured_content?.filter(b=>b.type==="proposal_card")??[];
   if(!capability){if(cards.length)fail("unexpected_effect_draft");return {replyId:reply.id,answer:reply.text_content??"",proposal:null};}
   if(cards.length!==1)fail("exact_owner_card_missing");
   const proposal=(await read("select id,status,revision,capability_id,canonical_effect_payload from public.supervisor_proposals where business_id=$1 and owner_user_id=$2 and thread_id=$3 and id=$4",
      [scope.businessId,scope.ownerUserId,threadId,cards[0].proposalId]))[0];
   if(!proposal||proposal.status!=="draft"||proposal.capability_id!==capability)fail("inert_owner_proposal_missing");
   if((await foreign.context.request.get("/api/ai/threads/"+threadId+"/proposals?ids="+proposal.id)).status()===200)fail("foreign_finance_card_visible");
   return {replyId:reply.id,answer:reply.text_content??"",proposal};
  };
  const click=async(proposal,region,label,done)=>{
   await connection.page.goto("/en?thread="+encodeURIComponent(threadId));
   const card=connection.page.getByRole("region",{name:region}).filter({has:connection.page.getByRole("button",{name:label})});
   await card.getByRole("button",{name:label}).waitFor({timeout:30000});
   if(await card.count()!==1)fail("ambiguous_owner_card");
   await card.getByRole("button",{name:label}).click();
   await connection.page.getByRole("region",{name:region}).getByText(done,{exact:true}).last().waitFor({timeout:30000});
   const saved=(await read("select status from public.supervisor_proposals where business_id=$1 and id=$2",[scope.businessId,proposal.id]))[0];
   if(saved?.status!=="committed")fail("owner_click_effect_not_committed");
  };
  const statement=async(csv,nickname)=>{
   const hash=createHash("sha256").update(csv).digest("hex");
   await connection.page.goto("/en/add-cost/statement");
   await connection.page.locator('input[type=file]').setInputFiles({name:"finance-evidence.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});
   await connection.page.getByText("Balance checks out",{exact:true}).waitFor({timeout:30000});
   await connection.page.getByRole("checkbox",{name:/Use this original statement/}).check();
   await connection.page.getByRole("textbox",{name:/Account nickname/}).fill(nickname);
   // Bank statement cash proof is deliberately independent of expense review.
   // Exclude each debit from incidental expense recognition before saving.
   for(const box of await connection.page.getByRole("checkbox",{name:/exclude/i}).all())await box.check();
   await connection.page.getByRole("button",{name:"Save all",exact:true}).click();
   await connection.page.getByText("Saved",{exact:true}).waitFor({timeout:30000});
   const row=(await read("select id,financial_owner_user_id,financial_closing_cents from public.uploads where business_id=$1 and financial_source_sha256=$2",[scope.businessId,hash]))[0];
   if(!row||row.financial_owner_user_id!==scope.ownerUserId)fail("statement_not_owner_scoped");
   return row;
  };
  const outcome=await body({scope,db,cafe,otherCafe,today,shift,read,count,turn,click,statement,fail,connection,foreign});
  const final=[await expenses(),await stock(),await receipts()];
  if(JSON.stringify(final)!==JSON.stringify(initial))fail("unexpected_financial_stock_expense_or_external_effect");
  if(!model||modelCalls<2)fail("no_actual_model_proof");
  writeFileSync(file,JSON.stringify({schema_version:1,id,head_sha:env.HEAD_SHA,status:"passed",observed_model:model,
    modelCalls,checks:{...outcome.checks,noStockExpenseOrExternalEffect:true,foreignCafeDenied:true}},null,2)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeFile,JSON.stringify({...scope,...outcome.scope,expectedProviderCalls:modelCalls},null,2)+"\n",{mode:0o600,flag:"wx"});
 }finally{
  await foreign?.context.close().catch(()=>{});await connection?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
