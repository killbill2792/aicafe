#!/usr/bin/env node
/** Task 8A shared acceptance. Real registered Supervisor and real local
 * worker, with a source-shaped disposable Toast checkpoint fixture. No live
 * Toast API call, production café, new approval, or mock model. Task17C
 * separately exercises actual provider importer, scheduler and process loss. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {writeFileSync,existsSync,realpathSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
const fail=code=>{throw Error("task8a_live:"+code);};
const expectedTools=["get_price_monitor_status","describe_data"];
async function query(db,sql,params=[]){return (await db.query(sql,params)).rows;}

async function login(browser,cafe){
 // Authenticate with the desktop-visible café header first, then verify the
 // actual Supervisor owner experience at a 390px mobile viewport.
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",
  serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30_000});
 await page.setViewportSize({width:390,height:844});
 return {context,page};
}
async function createThread(context){
 const response=await context.request.post("/api/ai/threads",{
  headers:{Origin:"http://127.0.0.1:3000"},
  data:{requestId:randomUUID(),title:"Task 8A observed price follow-up"}});
 if(response.status()!==201)fail("authenticated_thread_creation_failed");
 const id=(await response.json()).thread?.id;
 if(typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id))
  fail("authenticated_thread_identity_invalid");
 return id;
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async input=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),170_000);
  let buffer="",done=null,error=null;const names=[];
  try{
   const response=await fetch("/api/ai/threads/"+input.thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:abort.signal,
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({text:input.text,locale:"en",attachmentIds:[],
      clientMessageId:input.clientMessageId})});
   if(!response.ok||!response.body)
    return {names,done,error:"agent_http_"+response.status};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});
    let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,end).split("\n");buffer=buffer.slice(end+2);
     const event=lines.find(line=>line.startsWith("event: "))?.slice(7);
     const value=lines.find(line=>line.startsWith("data: "));
     let data=null;try{data=JSON.parse(value?.slice(6)??"null");}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=data?.code??"agent_error";break;}
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"stream_without_completion")};
  }catch{return {names,done,error:"transport_failed"};}
  finally{clearTimeout(timer);}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
   !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))
  fail("real_registered_supervisor_turn_incomplete");
 return {...result,clientMessageId};
}
function evidencePath(flag,name){
 const args=process.argv.slice(2);
 const i=args.indexOf(flag);
 if(i<0||typeof args[i+1]!=="string"||!args[i+1])fail("missing_"+name+"_path");
 const p=resolve(args[i+1]),parent=realpathSync(dirname(p)),root=realpathSync(process.cwd());
 if(parent===root||parent.startsWith(root+sep)||existsSync(p))
  fail("private_fresh_"+name+"_path_required");
 return p;
}

const worker=(mode,asOf)=>{
 const result=spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run",
  "lib/ai/supervisor/loop/experimentCutover.test.ts","-t","8a disposable real cron worker","--reporter=verbose"],{
  env:{...process.env,AICAFE_8A_DISPOSABLE_WORKER:"1",AICAFE_8A_WORKER_MODE:mode,AICAFE_8A_AS_OF:asOf},
  encoding:"utf8",timeout:150000,maxBuffer:4*1024*1024});
 if(result.error||result.status!==0)fail("real_worker_failed:"+String(result.stderr||result.stdout||result.error).slice(-2000));
};
const iso=n=>new Date(n).toISOString();
const DAY=86400000;
async function fixture(db,cafe,threadId,approved){
 const businessId=cafe.businessId,ownerUserId=cafe.owner.userId;
 const restaurant=randomUUID(),itemId=randomUUID(),historyId=randomUUID(),proposalId=randomUUID();
 const pos="toast:"+restaurant+":"+randomUUID()+":size:"+randomUUID();
 const location=(await query(db,"select id from public.locations where business_id=$1 order by id limit 1",[businessId]))[0]?.id;
 if(!location)fail("seed_location_missing");
 const observed=iso(Date.now()-(approved?12:8)*DAY),approvedAt=iso(Date.parse(observed)-3*3600000);
 const publication=iso(Date.parse(observed)-60000),completed=iso(Date.parse(observed)+60000);
 await db.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc) values($1,'https://fixture.invalid','8a-fixture','not-a-provider-key') on conflict (business_id) do nothing",[businessId]);
 await db.query("insert into public.toast_location_mappings(business_id,location_id,restaurant_guid,verified_at) values($1,$2,$3,$4)",[businessId,location,restaurant,approvedAt]);
 await db.query("insert into public.toast_optional_sync_state(business_id,restaurant_guid,menu_last_updated,menu_copied_at,menu_checked_local_day) values($1,$2,$3,$4,null)",[businessId,restaurant,publication,observed]);
 await db.query("insert into public.menu_items(id,business_id,pos_item_id,name,base_name,price_cents,catalog_source,is_active,pos_pricing_strategy,toast_publication_state,toast_publication_version,toast_publication_observed_at) values($1,$2,$3,'8A Large Latte','8A Latte',550,'toast',true,'SIZE_PRICE','active',$4,$5)",[itemId,businessId,pos,publication,observed]);
 // Source fixture writes a real connected_pos history event, then the
 // canonical Toast verifier and actual completion trigger prove it.
 await db.query("insert into public.menu_price_history(id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,changed_at) values($1,$2,$3,500,550,'connected_pos','toast',$4)",[historyId,businessId,itemId,observed]);
 await db.query("insert into public.supervisor_toast_price_context_changes(business_id,menu_item_id,old_pos_item_id,new_pos_item_id,old_pricing_strategy,new_pricing_strategy,old_catalog_source,new_catalog_source,old_is_active,new_is_active,old_price_cents,new_price_cents,old_publication_state,new_publication_state,observed_at) values($1,$2,$3,$3,'SIZE_PRICE','SIZE_PRICE','toast','toast',true,true,500,550,'active','active',$4)",[businessId,itemId,pos,observed]);
 await db.query("insert into public.supervisor_experiment_cutover_cafes(business_id,mode,parity_proven_at,rollback_proven_at,release_approved_at,toast_observation_enabled_at) values($1,'new',now(),now(),now(),$2) on conflict(business_id) do update set mode='new',parity_proven_at=now(),rollback_proven_at=now(),release_approved_at=now(),toast_observation_enabled_at=$2",[businessId,approvedAt]);
 if(approved)await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,approved_at) values($1,$2,$3,$4,$5,'alex.menu_price_change.v1',1,$6::jsonb,$7,'{}'::jsonb,$8::jsonb,'en','manual_pending',$9)",[proposalId,businessId,ownerUserId,threadId,randomUUID(),JSON.stringify({productId:itemId,productName:"8A Large Latte",oldPriceCents:500,newPriceCents:550,currency:cafe.currency}),"a".repeat(64),JSON.stringify({durationDays:10,metricScope:itemId}),approvedAt]);
 // Deliberately fail before completion; a partial stamp may exist but
 // must not produce an independent watch.
 await db.query("begin");
 try{
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  const result=await query(db,"select public.toast_verify_existing_price_history($1,$2,$3,$4,$5,550) as ok",[businessId,restaurant,pos,publication,observed]);
  assert.equal(result[0]?.ok,true,"canonical price receipt");
  await db.query("commit");
 }catch(error){await db.query("rollback");throw error;}
 const pending=await query(db,"select toast_publication_completed_at from public.menu_price_history where id=$1",[historyId]);
 assert.equal(pending[0]?.toast_publication_completed_at,null);
 if(!approved){
  worker("observation",completed);
  assert.equal((await query(db,"select count(*)::int n from public.supervisor_monitor_windows where business_id=$1 and source_id=$2",[businessId,historyId]))[0].n,0);
 }
 await db.query("update public.toast_optional_sync_state set menu_checked_local_day=$3::date,menu_copied_at=$4 where business_id=$1 and restaurant_guid=$2",[businessId,restaurant,observed.slice(0,10),completed]);
 const receipt=(await query(db,"select toast_publication_completed_at,toast_publication_pos_item_id from public.menu_price_history where id=$1",[historyId]))[0];
 assert.ok(receipt.toast_publication_completed_at);
 assert.equal(receipt.toast_publication_pos_item_id,pos);
 // Seed source-shaped canonical sales lines with exact instants and actual
 // daily source coverage. The independent oracle is not the worker formula.
 const length=approved?10:7;
 for(let i=-7;i<length;i++){
  const start=Date.parse(observed)+i*DAY,at=iso(start+3600000);
  const date=(await query(db,"select ($1::timestamptz at time zone $2)::date::text as date",[at,cafe.timezone]))[0].date;
  const orderId=randomUUID(),units=i<0?10:8,net=i<0?5000:4400;
  await db.query("insert into public.orders(id,business_id,location_id,pos_order_id,closed_at,business_date,gross_sales_cents,discounts_cents,refunds_cents,tax_cents,tip_cents,net_sales_cents) values($1,$2,$3,$4,$5,$6,$7,0,0,0,0,$7)",[orderId,businessId,location,"8a-"+orderId,iso(start+7200000),date,net]);
  await db.query("insert into public.order_lines(id,order_id,menu_item_id,pos_item_id,name,quantity,net_sales_cents,modifiers,voided,ordered_at) values($1,$2,$3,$4,'8A Large Latte',$5,$6,'[]'::jsonb,false,$7)",[randomUUID(),orderId,itemId,pos,units,net,at]);
  await db.query("insert into public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status) values($1,$2,$3,1,$4,0,0,0,0,0,'actual') on conflict(business_id,business_date) do update set net_sales_cents=public.daily_rollups.net_sales_cents+excluded.net_sales_cents,orders_count=public.daily_rollups.orders_count+1,drinks_count=public.daily_rollups.drinks_count+excluded.drinks_count,sales_data_status='actual'",[businessId,date,net,units]);
 }
 // Ensure both local dates touched by half-open intervals have certified
 // sales coverage; an intentionally missing-day variant is owned by 17C.
 for(let i=-8;i<=length;i++){
  const date=(await query(db,"select ($1::timestamptz at time zone $2)::date::text as date",[iso(Date.parse(observed)+i*DAY),cafe.timezone]))[0].date;
  await db.query("insert into public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status) values($1,$2,0,0,0,0,0,0,0,0,'actual') on conflict(business_id,business_date) do nothing",[businessId,date]);
 }
 return {businessId,ownerUserId,threadId,historyId,proposalId,itemId,observed,completed,length};
}
export async function runTask8a(approved=false){
 const env=process.env,id=approved?"8a-approved-experiment":"8a-price-observation";
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||
  env.AICAFE_SHARED_LUNA_SCENARIO!==id)fail("owner_gated_shared_runner_required");
 const proofPath=evidencePath("--output","proof"),scopePath=evidencePath("--scope-output","scope");
 if(proofPath===scopePath||process.argv.slice(2).length!==4)fail("fresh_distinct_outputs_required");
 const [{default:pg},{chromium},{createClient}]=await Promise.all([import("pg"),import("@playwright/test"),import("@supabase/supabase-js")]);
 const first=TEST_CAFES[0],foreign=TEST_CAFES[1];
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let owner=null,outsider=null;
 await db.connect();
 try{
  owner=await login(browser,first);
  const threadId=await createThread(owner.context);
  const scope=await fixture(db,first,threadId,approved);
  const sourceId=approved?scope.proposalId:scope.historyId,kind=approved?"approved_price":"toast_price_observation";
  const windows=()=>query(db,"select window_index,start_at,end_at,coverage_status,units,revenue_cents,source_reference from public.supervisor_monitor_windows where business_id=$1 and source_id=$2 and monitor_kind=$3 order by window_index",[scope.businessId,sourceId,kind]);
  if(approved){
   worker("approved",iso(Date.now()));
  }else{
   worker("observation",scope.completed);
   assert.equal((await windows()).length,7);
   assert.equal((await query(db,"select count(*)::int n from public.supervisor_experiment_notice_receipts where business_id=$1 and source_id=$2 and state='posted'",[scope.businessId,sourceId]))[0].n,1);
   for(let i=1;i<=7;i++)worker("observation",iso(Date.parse(scope.observed)+i*DAY+1));
  }
  const saved=await windows();
  assert.equal(saved.length,scope.length);
  for(let i=0;i<saved.length;i++){
   assert.equal(Number(saved[i].window_index),i);
   assert.equal(saved[i].end_at.getTime()-saved[i].start_at.getTime(),DAY);
   assert.equal(saved[i].coverage_status,"actual");
   assert.equal(Number(saved[i].units),8);
   assert.equal(Number(saved[i].revenue_cents),4400);
  }
  const ownerMessageCount=async()=>Number((await query(db,"select count(*)::int n from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and role='supervisor'",[scope.businessId,scope.ownerUserId,threadId]))[0].n);
  const messageCount=await ownerMessageCount();
  if(approved){
   assert.equal(Number((await query(db,"select count(*)::int n from public.supervisor_monitor_windows where business_id=$1 and monitor_kind='toast_price_observation' and source_id=$2",[scope.businessId,scope.historyId]))[0].n),0);
   const report=(await query(db,"select status,report from public.supervisor_reports where business_id=$1 and proposal_id=$2",[scope.businessId,scope.proposalId]))[0];
   assert.equal(report.status,"complete");assert.equal(report.report.observedRevenueCents,44000);
   assert.equal(report.report.observedUnits,80);assert.equal(report.report.nonCausal,true);
   worker("approved",iso(Date.now()));
  }else{
   const notices=await query(db,"select kind,slot,state,message_id,task_id from public.supervisor_experiment_notice_receipts where business_id=$1 and source_id=$2 order by kind,slot",[scope.businessId,sourceId]);
   assert.equal(notices.length,9);assert.ok(notices.every(n=>n.state==="posted"&&n.message_id&&n.task_id));
   assert.deepEqual(notices.filter(n=>n.kind==="toast_price_daily").map(n=>Number(n.slot)),[1,2,3,4,5,6,7]);
   assert.equal(saved[0].source_reference.cumulative.observedUnits,56);
   assert.equal(saved[0].source_reference.cumulative.observedRevenueCents,30800);
   assert.equal(saved[0].source_reference.cumulative.baselineUnits,70);
   assert.equal(saved[0].source_reference.cumulative.baselineRevenueCents,35000);
   worker("observation",iso(Date.now()));
  }
  assert.equal(await ownerMessageCount(),messageCount,"replay must not send duplicate owner messages");
  assert.equal((await query(db,"select count(*)::int n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,threadId]))[0].n,approved?1:0);
  const turn=await ownerTurn(owner.page,threadId,"Read the saved price monitoring status for 8A Large Latte using get_price_monitor_status. Also use describe_data to check the available authoritative menu and sales data sources. Explain the observed sales evidence, distinguish an independent observation from an approved experiment, state missing historical costs and do not claim causation. This is read-only; do not create, approve, or restart any proposal or change any price.");
  for(const tool of expectedTools)if(!turn.names.includes(tool))fail("model_missing_"+tool);
  const ownerRows=await query(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",[scope.businessId,threadId,turn.clientMessageId]);
  if(ownerRows.length!==1)fail("owner_message_missing");
  const usage=await readPersistedModelUsage(db,scope.businessId,ownerRows[0].id);
  requireObservedProductionModel(usage.model,"gpt-6-luna");
  const providerCalls=Number(usage.model_call_count);
  if(providerCalls<2||providerCalls>18)fail("actual_model_calls_outside_cap");
  const replyId=turn.done.reply.id;
  assert.equal((await query(db,"select count(*)::int n from public.ai_messages where id=$1 and business_id=$2 and owner_user_id=$3 and thread_id=$4 and role='supervisor'",[replyId,scope.businessId,scope.ownerUserId,threadId]))[0].n,1);
  assert.equal((await query(db,"select price_cents from public.menu_items where id=$1 and business_id=$2",[scope.itemId,scope.businessId]))[0].price_cents,550);
  assert.equal((await query(db,"select count(*)::int n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,threadId]))[0].n,approved?1:0);
  const foreignDb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const signed=await foreignDb.auth.signInWithPassword({email:foreign.owner.email,password:foreign.owner.password});
  if(signed.error||signed.data.user?.id!==foreign.owner.userId)fail("real_foreign_login_failed");
  const denied=await foreignDb.from("supervisor_monitor_windows").select("id").eq("business_id",scope.businessId).eq("source_id",sourceId);
  assert.equal(denied.error,null);assert.deepEqual(denied.data,[]);
  outsider=await login(browser,foreign);
  const deniedThread=await outsider.context.request.get("/api/ai/threads/"+threadId);
  if(![401,403,404].includes(deniedThread.status()))fail("foreign_thread_not_denied");
  await owner.page.goto("/en?thread="+encodeURIComponent(threadId));
  await owner.page.getByText("8A Large Latte",{exact:false}).first().waitFor({timeout:30000});
  await owner.page.setViewportSize({width:390,height:844});
  assert.ok(await owner.page.evaluate(()=>document.documentElement.scrollWidth)<=391,"mobile thread overflow");
  writeFileSync(proofPath,JSON.stringify({schema_version:1,scenario:id,status:"passed",head_sha:env.HEAD_SHA,
   observed_model:usage.model,provider_calls:providerCalls,provider_selected_tools:[...new Set(turn.names)].sort(),
   sourceShapedFixture:true,actualWorker:true,exactElapsedWindows:true,ownerMessages:messageCount,noDuplicateReplay:true,
   foreignOwnerRlsDenied:true,realOwnerThread:true,noUnauthorizedEffect:true},null,2)+"\n",{flag:"wx",mode:0o600});
  writeFileSync(scopePath,JSON.stringify({businessId:scope.businessId,foreignBusinessId:foreign.businessId,ownerUserId:scope.ownerUserId,
   threadId,historyId:scope.historyId,sourceId,replyId,itemId:scope.itemId,expectedProviderCalls:providerCalls},null,2)+"\n",{flag:"wx",mode:0o600});
 }finally{
  await outsider?.context.close().catch(()=>{});await owner?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 runTask8a(false).catch(e=>{console.error(e instanceof Error?e.message:"8a_unknown");process.exitCode=1;});
