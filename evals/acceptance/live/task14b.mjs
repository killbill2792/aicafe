#!/usr/bin/env node
/** Task14B paid REAL-model purchasing pilot. Never runs on CI or hosted cafés.
 * Objective operational smoke only: competitor comparison/human grading are separate. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=code=>{throw new Error("task14b_live:"+code);};
const expectedTools=Object.freeze(["inspect_supplier_purchase","propose_supplier_purchase_order"]);
export function verifyTask14bToolTrace(names,{correction=false}={}){
 if(!Array.isArray(names)||names.some(x=>typeof x!=="string"))fail("invalid_tool_trace");
 const required=correction?["get_supplier_purchase_orders",...expectedTools]:expectedTools;
 let cursor=-1;
 for(const name of required){
  const at=names.indexOf(name,cursor+1);
  if(at<0)fail("required_multistep_tool_missing_"+name);
  cursor=at;
 }
 return {required,toolCalls:names.length};
}
/** A model's text or a seeded proposal row is not proof that the owner can
 * approve it. Read the actual persisted assistant blocks and demand the card. */
export function verifyTask14bSavedCard(message,proposalId){
 const blocks=message?.structured_content;
 if(!Array.isArray(blocks)||!blocks.some(b=>b?.type==="proposal_card"&&
     b.proposalId===proposalId))
  fail("model_proposal_card_not_persisted");
 return true;
}
export function verifyTask14bScope(candidate,scope){
 if(candidate?.business_id!==scope.businessId||
    candidate?.owner_user_id!==scope.ownerUserId||
    candidate?.thread_id!==scope.threadId||
    candidate?.capability_id!=="maya.supplier_purchase_order.v1")
  fail("unverified_saved_owner_scope");
 return candidate;
}
const isoDay=(date,timeZone)=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
  timeZone,year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(date).map(x=>[x.type,x.value]));
 return parts.year+"-"+parts.month+"-"+parts.day;
};
const shift=(day,n)=>{const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);
 return d.toISOString().slice(0,10)};
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
async function createdThread(context){
 const response=await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"Task14B paid local operational acceptance"}});
 if(response.status()!==201)fail("thread_creation_failed");
 const data=await response.json();
 if(!/^[0-9a-f-]{36}$/i.test(data.thread?.id??""))fail("thread_identity_missing");
 return data.thread.id;
}
/** Consume the actual owner /agent stream. No replay/canned completion accepted. */
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async input=>{
  const stop=new AbortController(),timeout=setTimeout(()=>stop.abort(),180_000);
  const names=[];let done=null,error=null,buffer="";
  try{
   const response=await fetch("/api/ai/threads/"+input.thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:stop.signal,
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({text:input.text,locale:"en",attachmentIds:[],
      clientMessageId:input.clientMessageId})});
   if(!response.ok||!response.body)return {error:"agent_http_"+response.status,names,done};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
     const event=block.split("\n").find(x=>x.startsWith("event: "))?.slice(7);
     const dataLine=block.split("\n").find(x=>x.startsWith("data: "));
     let data=null;try{data=JSON.parse(dataLine?.slice(6)??"null")}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break}
     if(event==="error"){error=data?.code??"agent_error";break}
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_completed_turn")};
  }finally{clearTimeout(timeout)}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
   !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))
  fail("real_agent_turn_failed");
 return {...result,clientMessageId};
}
async function query(db,sql,args){return (await db.query(sql,args)).rows}
async function savedProposals(db,scope){
 return query(db,"select id,business_id,owner_user_id,thread_id,capability_id,status,revision,"+
  " canonical_effect_payload from public.supervisor_proposals"+
  " where business_id=$1 and thread_id=$2 and capability_id='maya.supplier_purchase_order.v1'"+
  " order by created_at,id",[scope.businessId,scope.threadId]);
}
async function savedModelCard(db,scope,turn,proposalId){
 const messages=await query(db,"select structured_content from public.ai_messages"+
  " where business_id=$1 and thread_id=$2 and id=$3 and role='supervisor'",
  [scope.businessId,scope.threadId,turn.done.reply.id]);
 if(messages.length!==1)fail("model_reply_not_persisted");
 verifyTask14bSavedCard(messages[0],proposalId);
}
async function modelUsage(db,scope,turn){
 const owners=await query(db,"select id::text from public.ai_messages"+
  " where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
  [scope.businessId,scope.threadId,turn.clientMessageId]);
 if(owners.length!==1)fail("owner_message_not_saved");
 const usage=await readPersistedModelUsage(db,scope.businessId,owners[0].id);
 requireObservedProductionModel(usage.model,"gpt-6-luna");
 if(Number(usage.model_call_count)<2||Number(usage.input_tokens)<=0)
  fail("multistep_live_provider_usage_missing");
 return {model:usage.model,modelCalls:Number(usage.model_call_count)};
}
async function measure(){
 const env=process.env;
 assertLocalLiveEnvironment(env);
 verifyCheckoutHead(env.HEAD_SHA);
 const outArg=process.argv.slice(2);
 if(outArg.length!==2||outArg[0]!=="--output"||!outArg[1])fail("output_required");
 const file=resolve(outArg[1]),root=realpathSync(process.cwd());
 const parent=realpathSync(dirname(file));
 if(parent===root||parent.startsWith(root+sep)||existsSync(file))
  fail("private_new_output_outside_repository_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const cafe=TEST_CAFES[0],foreign=TEST_CAFES[1];
 if(!cafe?.owner||!foreign?.owner||cafe.businessId===foreign.businessId)
  fail("two_disposable_cafes_required");
 const id={ingredient:randomUUID(),quoteA:randomUUID(),quoteB:randomUUID()};
 const item="Task14B live milk "+id.ingredient.slice(0,8);
 const supplierA="Task14B source A "+id.quoteA.slice(0,8);
 const supplierB="Task14B source B "+id.quoteB.slice(0,8);
 const now=isoDay(new Date(),cafe.timezone),needed=shift(now,3);
 let connection=null,other=null,thread=null;
 await db.connect();
 try{
  await db.query("insert into public.ingredients(id,business_id,name,base_unit)"+
   " values($1,$2,$3,'ml')",[id.ingredient,cafe.businessId,item]);
  for(const [quote,name,price] of [[id.quoteA,supplierA,450],[id.quoteB,supplierB,475]]){
   await db.query("insert into public.ai_supplier_quotes"+
    " (id,business_id,owner_user_id,client_request_id,supplier_name,item_name,ingredient_id,"+
    " price_cents,package_count,package_unit,source_kind,quoted_on,currency_code,"+
    " valid_until,available_status,available_checked_at,delivery_on)"+
    " values($1,$2,$3,$4,$5,$6,$7,$8,1,'gal','supplier_quote',$9::date,$10,"+
    " $11::date,'confirmed',$9::date,$12::date)",
    [quote,cafe.businessId,cafe.owner.userId,randomUUID(),name,item,
     id.ingredient,price,now,cafe.currency,shift(now,5),shift(now,2)]);
  }
  connection=await login(browser,cafe);
  thread=await createdThread(connection.context);
  const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId:thread};
  const counts=()=>query(db,"select "+
   " (select count(*)::int from public.pantry_stock_purchases where business_id=$1) stock,"+
   " (select count(*)::int from public.expenses where business_id=$1) expenses",
   [cafe.businessId]);
  const before=(await counts())[0];
  const first=await ownerTurn(connection.page,thread,
   "Investigate verified supplier quotes for exactly five gallons of "+item+
   " needed by "+needed+". Compare options, then prepare a purchase order for my approval. Do NOT send or receive it.");
  const firstTrace=verifyTask14bToolTrace(first.names);
  const usage1=await modelUsage(db,scope,first);
  let rows=await savedProposals(db,scope);
  if(rows.length!==1||rows[0].status!=="draft")fail("model_did_not_save_one_approval_draft");
  const original=verifyTask14bScope(rows[0],scope);
  await savedModelCard(db,scope,first,original.id);
  const validEffect=(p,quantity)=>p.canonical_effect_payload?.supplierName===supplierA&&
   p.canonical_effect_payload?.currency===cafe.currency&&
   p.canonical_effect_payload?.subtotalCents===quantity*450&&
   p.canonical_effect_payload?.lines?.length===1&&
   p.canonical_effect_payload.lines[0].quoteId===id.quoteA&&
   p.canonical_effect_payload.lines[0].packs===quantity;
  if(!validEffect(original,5))fail("source_comparison_or_pack_math_unverified");
  if((await query(db,"select id from public.purchase_orders where business_id=$1"+
      " and proposal_id=$2",[cafe.businessId,original.id])).length)
   fail("unapproved_order_written");
  const second=await ownerTurn(connection.page,thread,
   "Correction to that existing "+item+" order: change it to SEVEN gallons, "+
   "not a separate purchase. Recheck the saved draft and quotes. Leave it pending my approval.");
  const secondTrace=verifyTask14bToolTrace(second.names,{correction:true});
  const usage2=await modelUsage(db,scope,second);
  rows=await savedProposals(db,scope);
  const corrected=rows.find(x=>x.id!==original.id&&x.status==="draft");
  if(rows.length!==2||rows.find(x=>x.id===original.id)?.status!=="rejected"||
    !corrected||!validEffect(corrected,7))fail("owner_correction_not_durable_atomic");
  verifyTask14bScope(corrected,scope);
  await savedModelCard(db,scope,second,corrected.id);
  const link=await query(db,"select previous_id,replacement_id from public.supplier_po_draft_replacements"+
   " where business_id=$1 and previous_id=$2",[cafe.businessId,original.id]);
  if(link.length!==1||link[0].replacement_id!==corrected.id)
   fail("original_approval_not_retired");
  await connection.page.goto("/en?thread="+encodeURIComponent(thread));
  const approval=connection.page.getByRole("button",{name:"Approve purchase order"});
  await approval.first().waitFor({timeout:30_000});
  if(await approval.count()!==1)fail("ambiguous_owner_click");
  const awaited=connection.page.waitForResponse(response=>
    new URL(response.url()).pathname==="/api/ai/threads/"+thread+"/proposals"&&
    response.request().method()==="POST");
  await approval.click();const clicked=await awaited;
  if(clicked.status()!==200)fail("owner_click_not_applied");
  const order=await query(db,"select id,status,subtotal_cents,currency_code"+
   " from public.purchase_orders where business_id=$1 and proposal_id=$2",
   [cafe.businessId,corrected.id]);
  if(order.length!==1||order[0].status!=="approved_for_ordering"||
    Number(order[0].subtotal_cents)!==3150||order[0].currency_code!==cafe.currency)
   fail("approved_po_receipt_not_verified");
  await connection.page.reload();
  await connection.page.getByText("Approved for ordering — NOT sent to supplier",{exact:false})
    .first().waitFor({timeout:30_000});
  const after=(await counts())[0];
  if(after.stock!==before.stock||after.expenses!==before.expenses)
   fail("supplier_po_mutated_inventory_or_expenses");
  other=await login(browser,foreign);
  const foreignRead=await other.context.request.get("/api/ai/threads/"+thread+
    "/proposals?ids="+corrected.id);
  if(foreignRead.status()===200)fail("cross_cafe_read_leak");
  const third=await ownerTurn(connection.page,thread,
   "Check the saved supplier order. Was it sent or received, and what is actually approved?");
  if(!third.names.includes("get_supplier_purchase_orders"))
   fail("status_question_without_canonical_order_read");
  const usage3=await modelUsage(db,scope,third);
  const evidence={kind:"task14b_paid_local_objective",headSha:env.HEAD_SHA,
   model:usage1.model,passed:true,parityWithGrokMuse:"unverified_no_competitor_sessions",
   checks:{firstLiveTools:firstTrace,correctionLiveTools:secondTrace,
    usageModelCalls:[usage1.modelCalls,usage2.modelCalls,usage3.modelCalls],
    exactSavedProposal:true,savedOwnerApprovalCards:true,retiredOldDraft:true,authenticatedOwnerClick:true,
    persistedPO:true,reopenedOwnerCard:true,crossCafeDenied:true,
    unapprovedStockAndExpenseEffects:0,canonicalStatusTool:true},
   conclusion:"Objective real-model purchasing smoke only. Human quality grading, independent provider attestation, off-turn proactivity and same-task Grok/Muse comparison remain separate gates."};
  writeFileSync(file,JSON.stringify(evidence,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Task14B local real-model purchasing smoke PASS; redacted evidence written outside repo. Competitor parity NOT claimed.");
 }finally{
  await other?.context.close().catch(()=>{});
  await connection?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  // This database is disposable by preflight; retain failure rows for private diagnosis.
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 measure().catch(e=>{console.error(e instanceof Error?e.message:"task14b_live:unknown");process.exitCode=1;});
}
