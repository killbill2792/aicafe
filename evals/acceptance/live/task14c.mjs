#!/usr/bin/env node
/**
 * Task14C objective, owner-authorized REAL GPT-6 Luna acceptance.
 * Shared #520 runner only: local migrated two-cafe Supabase and actual
 * registered Supervisor + authenticated owner browser. This test deliberately
 * NEVER approves a Gmail send; existing deterministic owner-click Gmail tests
 * cover the external effect. No real Gmail token or supplier is installed.
 * The trusted host independently checks model calls, tools and scoped DB rows.
 */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("task14c_live:"+code)};
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
  data:{requestId:randomUUID(),title:"Task14C disposable owner acceptance"}});
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
  let diagnosticStage=null,diagnosticEndReason=null,diagnosticModelCalls=null;
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
      diagnosticModelCalls=data?.diagnosticModelCalls??null;break;
     }
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_completed_turn"),
    diagnosticStage,diagnosticEndReason,diagnosticModelCalls};
  }finally{clearTimeout(timer)}
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
  console.log("task14c_safe_model_failure",JSON.stringify({
   code,endReason,stage:["setup","model","persist","finish"].includes(result.diagnosticStage)?
     result.diagnosticStage:result.done?"completed_frame":"unknown",
   calls:Number.isSafeInteger(calls)&&calls>=0?calls:null,
   tools:result.names.filter(n=>[
    "get_supplier_purchase_orders","propose_supplier_vendor_email","record_supplier_order_outcome"].includes(n))
  }));
  fail("real_supervisor_"+code);
 }
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="14c"||
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
 const id={supplier:randomUUID(),ingredient:randomUUID(),quote:randomUUID(),
  original:randomUUID(),po:randomUUID(),contact:randomUUID(),account:randomUUID()};
 const item="Task14C milk "+id.ingredient.slice(0,8);
 const supplier="Task14C verified dairy "+id.supplier.slice(0,8);
 const today=day(new Date(),cafe.timezone),needed=shift(today,3),delivery=shift(today,2);
 let connection=null,foreign=null,thread=null;
 await db.connect();
 try{
  connection=await login(browser,cafe);
  thread=await createThread(connection.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId:thread};
  const poHash="a".repeat(64);
  await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,$3)",
   [id.supplier,scope.businessId,supplier]);
  await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,$3,'ml')",
   [id.ingredient,scope.businessId,item]);
  await db.query("insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,"+
    "supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,"+
    "quoted_on,currency_code,valid_until,available_status,available_checked_at,delivery_on)"+
    "values($1,$2,$3,$4,$5,$6,$7,250,1,'gal','supplier_quote',$8::date,$9,$10::date,"+
    "'confirmed',$8::date,$11::date)",
    [id.quote,scope.businessId,scope.ownerUserId,randomUUID(),supplier,item,id.ingredient,
     today,cafe.currency,shift(today,5),delivery]);
  const effect={supplierName:supplier,currency:cafe.currency,neededBy:needed,
   subtotalCents:250,totalCents:null,shippingCents:null,taxCents:null,
   limitations:["Freight and tax unknown"],
   lines:[{quoteId:id.quote,ingredientId:id.ingredient,itemName:item,
    neededBaseQuantity:3785.4,baseUnit:"ml",packs:1,packQuantity:1,
    packUnit:"gal",priceCents:250,lineSubtotalCents:250,quotedOn:today,deliveryOn:delivery}]};
  await db.query("insert into public.supervisor_proposals"+
    "(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,"+
    "canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)"+
    "values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,$6::jsonb,$7,"+
    "'{}'::jsonb,'{\"durationDays\":1,\"metricScope\":\"supplier_purchase_order\"}'::jsonb,"+
    "'en','committed',4)",
    [id.original,scope.businessId,scope.ownerUserId,scope.threadId,randomUUID(),
     JSON.stringify(effect),poHash]);
  await db.query("insert into public.purchase_orders"+
    "(id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,proposal_id,effect_hash,"+
    "status,revision,currency_code,subtotal_cents,needed_by)"+
    "values($1,$2,$3,$4,$5,$6,$7,'approved_for_ordering',1,$8,250,$9::date)",
    [id.po,scope.businessId,scope.ownerUserId,id.supplier,supplier,id.original,poHash,
     cafe.currency,needed]);
  await db.query("insert into public.purchase_order_lines"+
    "(business_id,purchase_order_id,quote_id,ingredient_id,ordinal,item_name_snapshot,"+
    "needed_base_quantity,base_unit,packs,pack_quantity,pack_unit,unit_price_cents,"+
    "subtotal_cents,quoted_on)"+
    "values($1,$2,$3,$4,1,$5,3785.4,'ml',1,1,'gal',250,250,$6::date)",
    [scope.businessId,id.po,id.quote,id.ingredient,item,today]);
  await db.query("insert into public.cafe_supplier_order_contacts"+
    "(id,business_id,supplier_id,owner_user_id,channel,email,verified_at)"+
    "values($1,$2,$3,$4,'gmail','orders@task14c.example',now())",
    [id.contact,scope.businessId,id.supplier,scope.ownerUserId]);
  await db.query("insert into public.connector_accounts"+
    "(id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,"+
    "enabled_operations,status,generation)"+
    "values($1,$2,$3,'gmail','task14c-local-only','owner@task14c.example',"+
    "array['https://www.googleapis.com/auth/gmail.modify']::text[],"+
    "array['read','send']::text[],'active',1)",
    [id.account,scope.businessId,scope.ownerUserId]);
  const countSideEffects=async()=>(
   await query(db,"select "+
    "(select count(*)::int from public.pantry_stock_purchases where business_id=$1) stock,"+
    "(select count(*)::int from public.expenses where business_id=$1) expenses",
    [scope.businessId]))[0];
  const before=await countSideEffects();
  const turn=await ownerTurn(connection.page,thread,
   "This existing saved purchase order "+id.po+" is already approved internally. "+
   "Please read the saved supplier order and its verified Gmail contact, "+
   "then PREPARE a separate exact Gmail send approval for me. Do not send "+
   "anything yet and do not create a new purchase order.");
  const required=["get_supplier_purchase_orders","propose_supplier_vendor_email"];
  let cursor=-1;for(const name of required){
   const at=turn.names.indexOf(name,cursor+1);
   if(at<0)fail("registered_supervisor_tool_sequence_missing_"+name);
   cursor=at;
  }
  const ownerMessages=await query(db,
   "select id from public.ai_messages where business_id=$1 and thread_id=$2 "+
   "and role='owner' and client_message_id=$3",
   [scope.businessId,scope.threadId,turn.clientMessageId]);
  if(ownerMessages.length!==1)fail("owner_turn_not_persisted");
  const usage=await readPersistedModelUsage(db,scope.businessId,ownerMessages[0].id);
  requireObservedProductionModel(usage.model,"gpt-6-luna");
  if(Number(usage.model_call_count)<2||Number(usage.input_tokens)<=0)
   fail("real_multistep_model_usage_missing");
  const proposals=await query(db,
   "select id,business_id,owner_user_id,thread_id,status,revision,"+
   "canonical_effect_payload from public.supervisor_proposals "+
   "where business_id=$1 and thread_id=$2 and capability_id='alex.gmail_effect.v1'",
   [scope.businessId,scope.threadId]);
  if(proposals.length!==1||proposals[0].status!=="draft"||
    proposals[0].business_id!==scope.businessId||
    proposals[0].owner_user_id!==scope.ownerUserId||
    proposals[0].thread_id!==scope.threadId)
   fail("model_vendor_gmail_proposal_not_saved");
  const proposal=proposals[0],e=proposal.canonical_effect_payload;
  if(e.operation!=="send"||e.to?.length!==1||
     e.to[0]!=="orders@task14c.example"||
     e.from!=="owner@task14c.example"||e.subject!=="Purchase order "+id.po||
     !e.body.includes(item)||!e.body.includes(cafe.currency))
   fail("model_proposal_canonical_source_or_recipient_mismatch");
  const dispatch=await query(db,"select state,purchase_order_id,proposal_id,recipient_email "+
   "from public.purchase_order_dispatches where business_id=$1 and purchase_order_id=$2",
   [scope.businessId,id.po]);
  if(dispatch.length!==1||dispatch[0].state!=="prepared"||
     dispatch[0].proposal_id!==proposal.id||
     dispatch[0].recipient_email!=="orders@task14c.example")
   fail("unverified_vendor_dispatch_binding");
  const savedReply=await query(db,
   "select structured_content from public.ai_messages where business_id=$1 "+
   "and thread_id=$2 and id=$3 and role='supervisor'",
   [scope.businessId,scope.threadId,turn.done.reply.id]);
  if(savedReply.length!==1||!Array.isArray(savedReply[0].structured_content)||
     !savedReply[0].structured_content.some(b=>
       b?.type==="proposal_card"&&b.proposalId===proposal.id))
   fail("model_proposal_card_not_saved");
  if((await query(db,"select id from public.connector_provider_receipts "+
     "where business_id=$1 and proposal_id=$2",[scope.businessId,proposal.id])).length)
   fail("provider_effect_before_owner_click");
  foreign=await login(browser,otherCafe);
  const foreignRead=await foreign.context.request.get("/api/ai/threads/"+thread+
   "/proposals?ids="+proposal.id);
  if(foreignRead.status()===200)fail("foreign_cafe_proposal_visible");
  await connection.page.goto("/en?thread="+encodeURIComponent(thread));
  const card=connection.page.getByRole("region",{name:"Review Gmail action"});
  await card.getByRole("button",{name:"Approve & send"}).waitFor({timeout:30000});
  if(!(await card.innerText()).includes("orders@task14c.example"))
   fail("owner_visible_recipient_missing");
  // The genuine model saved an actionable card, but deliberately never
  // click Approve & send in a paid-model acceptance run. No Gmail account
  // credential exists in this disposable test database.
  const providerReceipts=await query(db,
   "select id from public.connector_provider_receipts where business_id=$1 and proposal_id=$2",
   [scope.businessId,proposal.id]);
  if(providerReceipts.length)fail("unexpected_unapproved_provider_effect");
  const reports=await query(db,
   "select outcome from public.purchase_order_channel_reports "+
   "where business_id=$1 and purchase_order_id=$2",[scope.businessId,id.po]);
  const po=await query(db,"select status from public.purchase_orders "+
   "where business_id=$1 and id=$2",[scope.businessId,id.po]);
  if(reports.length||po.length!==1||po[0].status!=="approved_for_ordering")
   fail("false_supplier_acceptance");
  // Second genuine owner turn: a directly reported supplier phone outcome.
  // The model must persist an owner-reported canonical row, not just answer
  // in chat or assert Gmail delivery. No Gmail send/approval click happens.
  const ownerReport="The supplier accepted purchase order "+id.po+
    " by phone today. I am explicitly reporting that supplier outcome as the owner. "+
    "Please save this as an owner-reported phone outcome for this exact PO and "+
    "do not send the prepared Gmail draft. Copy my complete message verbatim as the report note.";
  const outcomeTurn=await ownerTurn(connection.page,thread,ownerReport);
  const outcomeRequired=["get_supplier_purchase_orders","record_supplier_order_outcome"];
  cursor=-1;for(const name of outcomeRequired){
    const at=outcomeTurn.names.indexOf(name,cursor+1);
    if(at<0)fail("registered_supervisor_outcome_tool_missing_"+name);
    cursor=at;
  }
  const secondOwner=await query(db,
    "select id from public.ai_messages where business_id=$1 and thread_id=$2 "+
    "and role='owner' and client_message_id=$3",
    [scope.businessId,scope.threadId,outcomeTurn.clientMessageId]);
  if(secondOwner.length!==1)fail("second_owner_turn_not_persisted");
  const secondUsage=await readPersistedModelUsage(db,scope.businessId,secondOwner[0].id);
  requireObservedProductionModel(secondUsage.model,"gpt-6-luna");
  if(Number(secondUsage.model_call_count)<2||Number(secondUsage.input_tokens)<=0)
    fail("real_owner_outcome_model_usage_missing");
  const savedReports=await query(db,
    "select id,owner_user_id,channel,outcome,note from public.purchase_order_channel_reports "+
    "where business_id=$1 and purchase_order_id=$2",[scope.businessId,id.po]);
  if(savedReports.length!==1||savedReports[0].owner_user_id!==scope.ownerUserId||
    savedReports[0].channel!=="phone"||
    savedReports[0].outcome!=="supplier_accepted"||
    savedReports[0].note!==ownerReport)
    fail("explicit_owner_chat_outcome_not_canonical");
  const reportId=savedReports[0].id;
  const realModelCalls=Number(usage.model_call_count)+Number(secondUsage.model_call_count);
  const after=await countSideEffects();
  if(before.stock!==after.stock||before.expenses!==after.expenses)
   fail("unauthorized_stock_or_expense_effect");
  const proof={schema_version:1,id:"14c",head_sha:env.HEAD_SHA,status:"passed",
   observed_model:usage.model,modelCalls:realModelCalls,
   gmailEffect:"not_authorized_not_sent",
   checks:{registeredToolsInOrder:required,sourceBoundSavedPO:true,
    ownerVisibleSeparateGmailApproval:true,foreignCafeDenied:true,
    ownerOutcomeToolSequence:outcomeRequired,ownerReportedByPhone:true,
    providerCalls:0,stockEffects:0,expenseEffects:0}};
  const scoped={businessId:scope.businessId,otherCafeId:otherCafe.businessId,
   ownerUserId:scope.ownerUserId,threadId:thread,poId:id.po,
   contactId:id.contact,proposalId:proposal.id,
   replyId:turn.done.reply.id,reportReplyId:outcomeTurn.done.reply.id,
   reportId,expectedProviderCalls:realModelCalls};
  writeFileSync(file,JSON.stringify(proof,null,2)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeFile,JSON.stringify(scoped,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Task14C real-Luna saved Gmail approval card and explicit owner phone outcome; no Gmail send.");
 }finally{
  await foreign?.context.close().catch(()=>{});
  await connection?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(e=>{console.error(e instanceof Error?e.message:"task14c_live:unknown");process.exitCode=1});
}
