#!/usr/bin/env node
/** Integrated real Luna acceptance: recover a real model-created approval from another conversation after closing the chat, then verify the existing canonical owner effect. Disposable shared runner only. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw Error("task16d_live:"+code)};
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
  data:{requestId:randomUUID(),title:"Task16D disposable owner acceptance"}});
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
  console.log("task16d_safe_model_failure",JSON.stringify({
   code,endReason,stage:["setup","model","persist","finish"].includes(result.diagnosticStage)?
     result.diagnosticStage:result.done?"completed_frame":"unknown",
   calls:Number.isSafeInteger(calls)&&calls>=0?calls:null,
   providerFailures,
   tools:result.names.filter(n=>[
    "get_supplier_purchase_orders","inspect_purchase_reconciliation","propose_invoice_reconciliation"].includes(n))
  }));
  fail("real_supervisor_"+code);
 }
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="16d"||
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

 const id={supplier:randomUUID(),ingredient:randomUUID(),quote:randomUUID(),original:randomUUID(),
  po:randomUUID(),line:randomUUID()};
 const item="Task16D milk "+id.ingredient.slice(0,8),supplier="Disposable dairy "+id.supplier.slice(0,8);
 const today=day(new Date(),cafe.timezone),invoiceRef="invoice-"+randomUUID();
 let connection=null,foreign=null;
 await db.connect();
 try{
  connection=await login(browser,cafe);
  const thread=await createThread(connection.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId:thread};
  const hash="a".repeat(64);
  await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,$3)",
   [id.supplier,scope.businessId,supplier]);
  await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,$3,'ml')",
   [id.ingredient,scope.businessId,item]);
  await db.query("insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,"+
    "supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,quoted_on,currency_code)"+
    "values($1,$2,$3,$4,$5,$6,$7,2000,10,'liter','supplier_quote',$8::date,$9)",
    [id.quote,scope.businessId,scope.ownerUserId,randomUUID(),supplier,item,id.ingredient,today,cafe.currency]);
  const original={supplierName:supplier,currency:cafe.currency,neededBy:today,subtotalCents:20000,totalCents:null,
   shippingCents:null,taxCents:null,limitations:["Freight and tax unknown"],lines:[{quoteId:id.quote,
    ingredientId:id.ingredient,itemName:item,neededBaseQuantity:100000,baseUnit:"ml",packs:10,packQuantity:10,
    packUnit:"liter",priceCents:2000,lineSubtotalCents:20000,quotedOn:today,deliveryOn:today}]};
  await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,"+
    "capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)"+
    "values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,$6::jsonb,$7,'{}'::jsonb,"+
    "'{\"durationDays\":1,\"metricScope\":\"supplier_purchase_order\"}'::jsonb,'en','committed',4)",
    [id.original,scope.businessId,scope.ownerUserId,thread,randomUUID(),JSON.stringify(original),hash]);
  await db.query("insert into public.purchase_orders(id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,"+
    "proposal_id,effect_hash,status,revision,currency_code,subtotal_cents,needed_by)"+
    "values($1,$2,$3,$4,$5,$6,$7,'approved_for_ordering',1,$8,20000,$9::date)",
    [id.po,scope.businessId,scope.ownerUserId,id.supplier,supplier,id.original,hash,cafe.currency,today]);
  await db.query("insert into public.purchase_order_lines(id,business_id,purchase_order_id,quote_id,ingredient_id,"+
    "ordinal,item_name_snapshot,needed_base_quantity,base_unit,packs,pack_quantity,pack_unit,unit_price_cents,"+
    "subtotal_cents,quoted_on,delivery_on) values($1,$2,$3,$4,$5,1,$6,100000,'ml',10,10,'liter',2000,20000,$7::date,$7::date)",
    [id.line,scope.businessId,id.po,id.quote,id.ingredient,item,today]);
  const getStock=async()=>Number((await query(db,"select coalesce(sum(quantity_base),0) n from public.pantry_stock_purchases "+
   "where business_id=$1 and ingredient_id=$2 and voided_at is null",[scope.businessId,id.ingredient]))[0].n);
  const countExpenses=async()=>Number((await query(db,"select count(*) n from public.expenses where business_id=$1",[scope.businessId]))[0].n);
  const initialExpenseCount=await countExpenses();
  const verifiedTurn=async(text)=>{
   const turn=await ownerTurn(connection.page,thread,text);
   const required=["get_supplier_purchase_orders","inspect_purchase_reconciliation","propose_invoice_reconciliation"];
   let at=-1;for(const name of required){at=turn.names.indexOf(name,at+1);if(at<0)fail("registered_tool_missing_"+name);}
   const msgs=await query(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 "+
    "and role='owner' and client_message_id=$3",[scope.businessId,thread,turn.clientMessageId]);
   if(msgs.length!==1)fail("owner_message_not_persisted");
   const usage=await readPersistedModelUsage(db,scope.businessId,msgs[0].id);
   requireObservedProductionModel(usage.model,"gpt-6-luna");
   if(Number(usage.model_call_count)<2||Number(usage.input_tokens)<=0)fail("real_multistep_model_usage_missing");
   const reply=await query(db,"select structured_content from public.ai_messages where business_id=$1 "+
    "and thread_id=$2 and role='supervisor' and id=$3",[scope.businessId,thread,turn.done.reply.id]);
   const cards=reply[0]?.structured_content?.filter(b=>b.type==="proposal_card")??[];
   if(cards.length!==1)fail("exact_owner_card_missing");
   const rows=await query(db,"select id,status,revision,owner_user_id,capability_id,canonical_effect_payload from public.supervisor_proposals "+
    "where business_id=$1 and thread_id=$2 and id=$3",[scope.businessId,thread,cards[0].proposalId]);
   if(rows.length!==1||rows[0].status!=="draft"||rows[0].owner_user_id!==scope.ownerUserId)fail("inert_owner_proposal_missing");
   return {proposal:rows[0],replyId:turn.done.reply.id,calls:Number(usage.model_call_count),model:usage.model};
  };
  const invoice=await verifiedTurn("For saved PO "+id.po+", the supplier "+supplier+
   " sent invoice "+invoiceRef+" issued "+today+" for the full 100 litres of "+item+
   " at "+cafe.currency+" 20 per 10-litre pack, total "+cafe.currency+
   " 200.00; tax, freight and discount all zero, no due date stated. We have not verified any physical delivery or made payment. "+
   "Please prepare an invoice evidence confirmation for me, not an expense or stock update.");
  const ie=invoice.proposal.canonical_effect_payload;
  if(invoice.proposal.capability_id!=="maya.supplier_invoice.v1"||ie.purchaseOrderId!==id.po||
   ie.invoiceReference!==invoiceRef||ie.totalCents!==20000||ie.expenseDate!==null||
   ie.lines?.length!==1||ie.lines[0].quantityBase4!==1000000000||ie.lines[0].orderLineId!==id.line)
   fail("invoice_effect_not_source_matched");
  if(await getStock()!==0||await countExpenses()!==initialExpenseCount)fail("effect_before_owner_click");
  foreign=await login(browser,otherCafe);
  if((await foreign.context.request.get("/api/ai/threads/"+thread+"/proposals?ids="+invoice.proposal.id)).status()===200)
   fail("foreign_invoice_card_visible");
  // Closing the original page must not discard the draft or make another effect.
  const anchor=await createThread(connection.context);
  await connection.page.close();
  connection.page=await connection.context.newPage();
  await connection.page.setViewportSize({width:390,height:844});
  await connection.page.goto("/en?thread="+encodeURIComponent(anchor));
  const workButton=connection.page.getByRole("button",{name:"Supervisor work",exact:true});
  await workButton.waitFor({timeout:30000});await workButton.click();
  const drawer=connection.page.getByRole("dialog",{name:"Supervisor controls"});
  const pending=drawer.locator('[data-work-id="proposal:'+invoice.proposal.id+'"]');
  await pending.waitFor({timeout:30000});
  if(await pending.getAttribute("data-work-status")!=="approval_required")fail("approval_not_pending");
  const visible=await connection.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  if(!visible)fail("mobile_horizontal_overflow");
  await pending.getByRole("button").click();
  const exactCard=connection.page.locator('[data-work-proposal="'+invoice.proposal.id+'"]');
  const confirm=exactCard.getByRole("button",{name:"Confirm invoice evidence",exact:true});
  await confirm.waitFor({timeout:30000});
  if(await exactCard.count()!==1)fail("duplicate_approval_card");
  const before=(await query(db,"select count(*) n from public.supplier_invoices where business_id=$1 and purchase_order_id=$2",[scope.businessId,id.po]))[0];
  if(Number(before.n)!==0)fail("invoice_before_owner_click");
  await confirm.click();
  await exactCard.getByText("Invoice evidence recorded",{exact:true}).waitFor({timeout:30000});
  if(await getStock()!==0||await countExpenses()!==initialExpenseCount)fail("invoice_alone_changed_stock_or_expense");
  const invoiceRow=(await query(db,"select id,revision,total_cents,canonical_expense_id from public.supplier_invoices "+
   "where business_id=$1 and purchase_order_id=$2 and invoice_reference=$3",[scope.businessId,id.po,invoiceRef]))[0];
  if(!invoiceRow||Number(invoiceRow.revision)!==1||Number(invoiceRow.total_cents)!==20000||invoiceRow.canonical_expense_id!==null)
   fail("canonical_documentary_invoice_invalid");
  const denied=await foreign.context.request.get("/api/ai/threads/"+thread+"/work?scope=owner");
  if(![401,403,404].includes(denied.status()))fail("foreign_work_not_denied");
  await connection.page.goto("/en?thread="+encodeURIComponent(thread));
  await connection.page.setViewportSize({width:1440,height:900});
  await connection.page.getByRole("button",{name:"Supervisor work",exact:true}).click();
  const completed=connection.page.getByRole("dialog",{name:"Supervisor controls"})
   .locator('[data-work-id="proposal:'+invoice.proposal.id+'"]');
  await completed.waitFor({timeout:30000});
  if(await completed.getAttribute("data-work-status")!=="verified_complete")fail("verified_effect_not_visible");
  const realModelCalls=invoice.calls;
  const proof={schema_version:1,id:"16d",head_sha:env.HEAD_SHA,status:"passed",observed_model:invoice.model,
   modelCalls:realModelCalls,checks:{ownerWideWorkRecovered:true,ownerClickBeforeEffect:true,
   verifiedEffectVisible:true,noExpenseOrStock:true,foreignCafeDenied:true}};
  const scoped={...scope,otherCafeId:otherCafe.businessId,poId:id.po,ingredientId:id.ingredient,
   invoiceId:invoiceRow.id,invoiceProposalId:invoice.proposal.id,invoiceReplyId:invoice.replyId,expectedProviderCalls:realModelCalls};
  writeFileSync(file,JSON.stringify(proof,null,2)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeFile,JSON.stringify(scoped,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Task16D actual registered model approval recovered across threads and verified on the existing owner card.");
 }finally{
  await foreign?.context.close().catch(()=>{});await connection?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"task16d_live:unknown");process.exitCode=1});
