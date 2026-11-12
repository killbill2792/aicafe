/**
 * Task 8a database acceptance: run ONLY against fully migrated, disposable
 * local Supabase at 127.0.0.1:54322. No production or hosted connection.
 *
 * TASK8A_DISPOSABLE_DB=1 node scripts/test-supervisor-experiment-cutover-db.mjs
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";

if(process.env.TASK8A_DISPOSABLE_DB!=="1")
 throw Error("TASK8A_DISPOSABLE_DB=1 is required for destructive fixture tests");
const config={host:"127.0.0.1",port:54322,database:"postgres",
 user:"postgres",password:"postgres",connectionTimeoutMillis:5000};
const admin=new pg.Client(config),workerA=new pg.Client(config),workerB=new pg.Client(config);
const ids={business:randomUUID(),foreignBusiness:randomUUID(),owner:randomUUID(),
 foreignOwner:randomUUID(),thread:randomUUID(),foreignThread:randomUUID(),
 location:randomUUID(),foreignLocation:randomUUID(),restaurant:randomUUID(),
 foreignRestaurant:randomUUID(),item:randomUUID(),manualItem:randomUUID(),
 history:randomUUID()};
const pos="toast:"+ids.restaurant+":"+randomUUID(),version="2026-11-12T15:00:00Z";
const observed=new Date(Math.floor((Date.now()-5*60000)/1000)*1000).toISOString();
const approved=new Date(Date.parse(observed)-5*60000).toISOString();
const proposalIds=[];
let assertions=0,seeded=false;
function check(value,reason){assert.ok(value,reason);assertions++;}
async function result(client,sql,args=[]){return (await client.query(sql,args)).rows;}
async function one(client,sql,args=[]){return (await result(client,sql,args))[0];}
async function role(client,kind,owner,action){
 await client.query("begin");
 try{
  if(kind!=="authenticated"&&kind!=="service_role")
   throw Error("Unexpected database role");
  await client.query("set local role "+kind);
  await client.query("select set_config('request.jwt.claim.role',$1,true)",[kind]);
  if(owner)await client.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
  const value=await action(client);
  await client.query("commit");return value;
 }catch(error){await client.query("rollback");throw error;}
}
async function expectSqlState(task,expected){
 let actual=null;
 try{await task();}catch(error){actual=error.code??null;}
 assert.equal(actual,expected,"expected SQLSTATE "+expected);
 assertions++;
}
async function expectSourceBoundary(task,reason){
 let failure=null;
 try{await task();}catch(error){failure=error;}
 assert.equal(failure?.code,"42501",reason+" must fail with access denied");
 assert.match(failure.message,/toast_(menu|history)_source_service_role_only/,
  reason+" must be blocked by the source-provenance guard");
 assertions++;
}
async function proposal(capability,product,target=500,cafe=ids.business,owner=ids.owner,
 thread=ids.thread){
 const id=randomUUID();proposalIds.push(id);
 const effect={productId:product,productName:"Latte",
  oldPriceCents:450,newPriceCents:target,currency:"USD"};
 await admin.query("insert into public.supervisor_proposals (id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,approved_at) values($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8,$9::jsonb,$10::jsonb,'en','manual_pending',$11)",
  [id,cafe,owner,thread,randomUUID(),capability,JSON.stringify(effect),
   "a".repeat(64),JSON.stringify({source:"menu_items"}),
   JSON.stringify({durationDays:7,metricScope:product}),approved]);
 return id;
}
const transition=(revision=1)=>
 "select (public.supervisor_transition_proposal($1,$2,$3,"+Number(revision)+",'manual_confirmed',current_date)).status as status";
async function activate(id,client=workerA){
 return role(client,"service_role",null,async c=>
  one(c,transition(),[ids.business,ids.owner,id]));
}
const claimSql="select public.supervisor_8a_claim_notice($1,$2,$3,$4,$5,$6) as id";
async function claim(client,id,kind="price_reminder",slot=1,cafe=ids.business,owner=ids.owner,date=null){
 const day=date??observed.slice(0,10);
 return role(client,"service_role",null,async c=>
  (await one(c,claimSql,[cafe,owner,id,kind,day,slot])).id);
}
async function seed(){
 await admin.query("begin");
 try{
  // The database MUST already have every production migration locally,
  // including Task 10's existing effect reconciliation and this Task 8a SQL.
  check((await one(admin,"select to_regclass('public.supervisor_experiment_notice_receipts') is not null as ok")).ok,
   "Task 8a migration installed");
  check((await one(admin,"select to_regprocedure('public.supervisor_reconcile_effect_attempt(uuid,uuid,uuid,uuid,integer)') is not null as ok")).ok,
   "merged Task 10 reconciliation retained");
  await admin.query("insert into auth.users(id,email,aud,role) values($1,$2,'authenticated','authenticated'),($3,$4,'authenticated','authenticated')",
   [ids.owner,"task8a-"+ids.owner+"@example.invalid",
    ids.foreignOwner,"task8a-"+ids.foreignOwner+"@example.invalid"]);
  await admin.query("insert into public.businesses(id,name,is_demo,timezone) values($1,'Task8a ephemeral A',false,'America/Los_Angeles'),($2,'Task8a ephemeral B',false,'UTC')",
   [ids.business,ids.foreignBusiness]);
  await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
   [ids.business,ids.owner,ids.foreignBusiness,ids.foreignOwner]);
  await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,'Task8a A'),($5,$6,$7,$8,'Task8a B')",
   [ids.thread,ids.business,ids.owner,randomUUID(),
    ids.foreignThread,ids.foreignBusiness,ids.foreignOwner,randomUUID()]);
  await admin.query("insert into public.locations(id,business_id,name) values($1,$2,'A'),($3,$4,'B')",
   [ids.location,ids.business,ids.foreignLocation,ids.foreignBusiness]);
  await admin.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc) values($1,'https://synthetic.example','test-a','test-encrypted'),($2,'https://synthetic.example','test-b','test-encrypted')",
   [ids.business,ids.foreignBusiness]);
  await admin.query("insert into public.toast_location_mappings(business_id,location_id,restaurant_guid,verified_at) values($1,$2,$3,now()),($4,$5,$6,now())",
   [ids.business,ids.location,ids.restaurant,
    ids.foreignBusiness,ids.foreignLocation,ids.foreignRestaurant]);
  await admin.query("insert into public.toast_optional_sync_state(business_id,restaurant_guid,menu_last_updated,menu_copied_at) values($1,$2,$3,$4)",
   [ids.business,ids.restaurant,version,observed]);
  await admin.query("insert into public.menu_items(id,business_id,pos_item_id,name,base_name,price_cents,catalog_source,is_active,pos_pricing_strategy,toast_publication_state,toast_publication_version,toast_publication_observed_at) values($1,$2,$3,'Latte','Latte',500,'toast',true,'BASE_PRICE','active',$4,$5)",
   [ids.item,ids.business,pos,version,observed]);
  await admin.query("insert into public.menu_items(id,business_id,name,base_name,price_cents,catalog_source,is_active) values($1,$2,'Manual latte','Manual latte',450,'manual',true)",
   [ids.manualItem,ids.business]);
  await admin.query("insert into public.menu_price_history(id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,changed_at,toast_restaurant_guid,toast_publication_version,toast_observed_at) values($1,$2,$3,450,500,'connected_pos','toast',$4,$5,$6,$4)",
   [ids.history,ids.business,ids.item,observed,ids.restaurant,version]);
  await admin.query("insert into public.supervisor_experiment_cutover_cafes(business_id,mode) values($1,'legacy')",
   [ids.business]);
  await admin.query("commit");seeded=true;
 }catch(error){await admin.query("rollback");throw error;}
}
async function run(){
 await seed();
 check((await one(admin,"select count(*)::int as n from public.supervisor_monitor_windows where business_id=$1",
  [ids.business])).n===0,"no synthetic window exists before activation");
 // Owner and tenant RLS: owner can see own gate, not another café;
 // authenticated client can neither insert nor mutate service-owned rows.
 const own=await role(workerA,"authenticated",ids.owner,async c=>
  one(c,"select count(*)::int as n from public.supervisor_experiment_cutover_cafes"));
 check(own.n===1,"owner reads own cutover gate");
 const foreign=await role(workerA,"authenticated",ids.foreignOwner,async c=>
  one(c,"select count(*)::int as n from public.supervisor_experiment_cutover_cafes"));
 check(foreign.n===0,"other café owner cannot read cutover");
 check(!(await one(admin,"select has_table_privilege('authenticated','public.supervisor_monitor_windows','INSERT') as allowed")).allowed,
  "authenticated cannot forge monitoring windows");
 check(!(await one(admin,"select has_function_privilege('authenticated','public.supervisor_8a_claim_notice(uuid,uuid,uuid,text,date,smallint)','EXECUTE') as allowed")).allowed,
  "authenticated cannot claim notices");
 // Reproduce Codex P1 #4556916767 at the REAL database write boundary:
 // RLS may permit a cafe member to UPDATE menu_items and INSERT imported
 // price history, but cannot grant authority to invent a Toast publication.
 const writeAsOwner=(sql,params)=>role(workerA,"authenticated",ids.owner,
  async c=>c.query(sql,params));
 const attackHistory="insert into public.menu_price_history (business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,changed_at,toast_restaurant_guid,toast_publication_version,toast_observed_at) values($1,$2,450,500,'connected_pos','toast',$3,$4,$5,$3)";
 await expectSourceBoundary(()=>writeAsOwner(attackHistory,
  [ids.business,ids.item,observed,ids.restaurant,version]),
  "member-inserted forged Toast price-history publication");
 await expectSourceBoundary(()=>writeAsOwner(
  "insert into public.menu_price_history (business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,toast_restaurant_guid,toast_publication_version,toast_observed_at) values($1,$2,450,500,'imported','csv',$3,$4,$5)",
  [ids.business,ids.item,ids.restaurant,version,observed]),
  "member-imported row with forged Toast provenance fields");
 await expectSourceBoundary(()=>writeAsOwner(
  "update public.menu_items set price_cents=501 where id=$1",[ids.item]),
  "member-mutated Toast price");
 // A SECURITY DEFINER RPC retains the signed-in user's auth claim even
 // when its effective SQL role is privileged. Do not let it launder writes.
 await expectSourceBoundary(()=>role(workerA,"service_role",null,async c=>{
  await c.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await c.query("update public.menu_items set price_cents=501 where id=$1",[ids.item]);
 }),"authenticated claim through privileged function context");
 await expectSourceBoundary(()=>writeAsOwner(
  "update public.menu_items set pos_pricing_strategy='TIME_SPECIFIC_PRICE' where id=$1",
  [ids.item]),"member-mutated Toast strategy");
 await expectSourceBoundary(()=>writeAsOwner(
  "update public.menu_items set toast_publication_version='fake-menu-version' where id=$1",
  [ids.item]),"member-forged Toast publication version");
 await expectSourceBoundary(()=>writeAsOwner(
  "insert into public.menu_items (id,business_id,name,base_name,price_cents,catalog_source,pos_item_id,toast_publication_state) values($1,$2,'Fake Toast item','Fake Toast item',500,'toast',$3,'active')",
  [randomUUID(),ids.business,pos]),"member-inserted fake Toast item");
 const original=await one(admin,
  "select price_cents,pos_pricing_strategy,toast_publication_version from public.menu_items where id=$1",
  [ids.item]);
 check(Number(original.price_cents)===500&&original.pos_pricing_strategy==="BASE_PRICE"&&
  original.toast_publication_version===version,
  "attacks did not change the authoritative Toast menu state");
 // Existing legitimate owner editing and non-Toast CSV imports must survive.
 await writeAsOwner("update public.menu_items set price_cents=451 where id=$1",
  [ids.manualItem]);
 check(Number((await one(admin,"select price_cents from public.menu_items where id=$1",
  [ids.manualItem])).price_cents)===451,"manual menu price edit is still allowed");
 await writeAsOwner(
  "insert into public.menu_price_history (business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider) values($1,$2,450,451,'connected_pos','other_import')",
  [ids.business,ids.manualItem]);
 check(Number((await one(admin,
  "select count(*)::integer as n from public.menu_price_history where business_id=$1 and menu_item_id=$2 and source_provider='other_import'",
  [ids.business,ids.manualItem])).n)===1,
  "authenticated non-Toast connected_pos import is still permitted");
 // Both price capabilities must reject an owner Done without exact matching
 // source publication; no source-history claim from local/cross-café money.
 for(const cap of ["alex.menu_price_change.v1","alex.drink_price_experiment.v1"]){
  const invalid=await proposal(cap,ids.item,600);
  await expectSqlState(()=>activate(invalid),"23514");
  const remains=await one(admin,"select status from public.supervisor_proposals where id=$1",[invalid]);
  check(remains.status==="manual_pending",cap+" remains unverified after rejected Done");
 }
 const good=await proposal("alex.menu_price_change.v1",ids.item);
 const confirmed=await activate(good);
 check(confirmed.status==="manual_confirmed",
  "same-café, same-version verified publication permits source-confirmed transition");
 const manual=await proposal("alex.menu_price_change.v1",ids.manualItem,550);
 check((await activate(manual)).status==="manual_confirmed",
  "disconnected/manual café retains existing lifecycle");
 // An effect-claimed Toast handoff is INERT. The gateway must be able
 // to restore manual_pending from an uncertain claim without inventing
 // an owner_manual price history or replaying a canonical price effect.
 const inert=await proposal("alex.menu_price_change.v1",ids.item);
 // Exact gateway claim order: approved proposal -> reserved attempt INSERT ->
 // executing proposal / uncertain attempt. Sign the source at reservation,
 // not from a mutable catalog snapshot during a later recovery.
 await admin.query("update public.supervisor_proposals set status='approved',revision=revision+1 where id=$1",[inert]);
 await admin.query("insert into public.supervisor_effect_attempts(business_id,proposal_id,effect_hash,authorization_kind,business_date,state,created_at) values($1,$2,$3,'click',current_date,'reserved',now()-interval '10 minutes')",
  [ids.business,inert,"a".repeat(64)]);
 const sealed=await one(admin,"select attempt_key,receipt_ref from public.supervisor_effect_attempts where proposal_id=$1",[inert]);
 check(sealed.receipt_ref==="inert-toast-claim:"+sealed.attempt_key,
  "reserved Toast handoff receives immutable original source identity");
 await admin.query("update public.supervisor_proposals set status='executing',revision=revision+1 where id=$1",[inert]);
 await admin.query("update public.supervisor_effect_attempts set state='uncertain' where proposal_id=$1",[inert]);
 const reconcile="select (public.supervisor_reconcile_effect_attempt($1,$2,$3,$4,$5)).status as status";
 const recover=(owner,id,revision)=>role(workerA,"service_role",null,async c=>
  one(c,reconcile,[ids.business,owner,ids.thread,id,revision]));
 const prePriceCount=(await one(admin,"select count(*)::int as n from public.menu_price_history where business_id=$1 and menu_item_id=$2",
  [ids.business,ids.item])).n;
 check((await recover(ids.owner,inert,3)).status==="manual_pending",
  "uncertain inert Toast handoff recovers through the existing Task10 gateway");
 const attempt=await one(admin,"select state,receipt_ref from public.supervisor_effect_attempts where proposal_id=$1",[inert]);
 check(attempt.state==="verified"&&attempt.receipt_ref==="inert-toast-price-handoff:"+sealed.attempt_key,
  "recovery writes a stable proof tied to the claimed effect attempt");
 check((await recover(ids.owner,inert,4)).status==="manual_pending",
  "recovered handoff reconciliation is idempotent");
 check((await one(admin,"select count(*)::int as n from public.menu_price_history where business_id=$1 and menu_item_id=$2",
  [ids.business,ids.item])).n===prePriceCount,
  "inert handoff neither creates Toast history nor repeats a price write");
 // Existing Task 10 manual-owner CAS receipts still require their original
 // proposal-stamped history: current source price alone is not proof.
 const localPending=await proposal("alex.menu_price_change.v1",ids.manualItem,550);
 await admin.query("update public.supervisor_proposals set status='approved',revision=revision+1 where id=$1",[localPending]);
 await admin.query("insert into public.supervisor_effect_attempts(business_id,proposal_id,effect_hash,authorization_kind,business_date,state,created_at) values($1,$2,$3,'click',current_date,'reserved',now()-interval '10 minutes')",
  [ids.business,localPending,"a".repeat(64)]);
 check((await one(admin,"select receipt_ref from public.supervisor_effect_attempts where proposal_id=$1",[localPending])).receipt_ref===null,
  "manual-price claim never receives a Toast recovery stamp");
 await admin.query("update public.supervisor_proposals set status='executing',revision=revision+1 where id=$1",[localPending]);
 await admin.query("update public.supervisor_effect_attempts set state='uncertain' where proposal_id=$1",[localPending]);
 check((await recover(ids.owner,localPending,3)).status==="executing",
  "manual-price recovery still refuses to infer a write from current price");
 await admin.query("update public.menu_items set price_cents=550 where id=$1",[ids.manualItem]);
 await admin.query("insert into public.menu_price_history(business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,changed_at) values($1,$2,450,550,'owner_manual',$3,now())",
  [ids.business,ids.manualItem,"Alex (owner approved; proposal "+localPending+")"]);
 check((await recover(ids.owner,localPending,3)).status==="committed",
  "Task10 canonical owner_manual history still authoritatively recovers a committed price");
 // Anchor already proved by the canonical source may survive a later revert
 // without retroactively declaring the full seven-day window complete.
 const pinned=await proposal("alex.drink_price_experiment.v1",ids.item);
 const reference={businessId:ids.business,menuItemId:ids.item,
  historyId:ids.history,restaurantGuid:ids.restaurant,posItemId:pos,
  publicationVersion:version,observedAt:observed,
  oldPriceCents:450,newPriceCents:500};
 await admin.query("insert into public.supervisor_monitor_windows(business_id,owner_user_id,monitor_kind,source_id,window_index,source_reference,start_at,end_at) values($1,$2,'approved_price',$3,0,$4::jsonb,$5,$5::timestamptz+interval '24 hours')",
  [ids.business,ids.owner,pinned,JSON.stringify(reference),observed]);
 await admin.query("update public.menu_items set price_cents=400,pos_pricing_strategy='TIME_SPECIFIC_PRICE',toast_publication_state='inactive' where id=$1",[ids.item]);
 check((await one(admin,"select count(*)::int as n from public.supervisor_toast_price_context_changes where business_id=$1 and menu_item_id=$2",
  [ids.business,ids.item])).n>0,"actual canonical source context mutation is durably audited");
 check((await activate(pinned)).status==="manual_confirmed",
  "pinned source activation recovers after current price/strategy/unpublication changes");
 // A verified source receipt must cancel an otherwise pending reminder
 // even if the cron read manual_pending before the source publication.
 const publishedPending=await proposal("alex.menu_price_change.v1",ids.item,500);
 check((await claim(workerA,publishedPending))===null,
  "published exact approved price cannot generate a stale reminder");
 // No-claim on posted, expired lease reclaim, and no reclaim once owner
 // cancels/changes state. All claims use SQL's real service-role boundary.
 const pending=await proposal("alex.menu_price_change.v1",ids.item,600);
 const initial=await claim(workerA,pending);
 check(typeof initial==="string","first pending reminder has a claim UUID");
 check((await claim(workerA,pending))===null,"duplicate cron cannot claim a live lease");
 await admin.query("update public.supervisor_experiment_notice_receipts set state='failed',claimed_at=now()-interval '10 minutes',retry_at=now()-interval '1 minute' where id=$1",[initial]);
 check((await claim(workerA,pending))===initial,"retry retains original receipt identity");
 await admin.query("update public.supervisor_proposals set status='rejected',revision=revision+1 where id=$1",[pending]);
 await admin.query("update public.supervisor_experiment_notice_receipts set state='failed',claimed_at=now()-interval '10 minutes',retry_at=now()-interval '1 minute' where id=$1",[initial]);
 check((await claim(workerA,pending))===null,
  "expired lease cannot bypass fresh proposal eligibility after rejection");
 const raced=await proposal("alex.menu_price_change.v1",ids.item,600);
 const [a,b]=await Promise.all([claim(workerA,raced),claim(workerB,raced)]);
 check([a,b].filter(Boolean).length===1,
  "two real PostgreSQL sessions cannot both claim the same reminder slot");
 const slot2=await claim(workerA,raced,"price_reminder",2);
 check(typeof slot2==="string"&&slot2!==a&&slot2!==b,
  "second slot remains separately deduplicated");
 check((await claim(workerA,raced,"price_reminder",1))===null,
  "per-slot replay cannot create a third notice");
 const differentDay=await claim(workerA,raced,"price_reminder",1,ids.business,ids.owner,"2026-11-13");
 check(typeof differentDay==="string","café-local next date is independently keyed");
 const foreignClaim=await claim(workerA,raced,"price_reminder",1,ids.foreignBusiness,ids.foreignOwner);
 check(foreignClaim===null,"foreign café owner cannot claim another café's proposal");
 const observedClaim=await claim(workerA,ids.history,"toast_price_initial",0);
 check(typeof observedClaim==="string","source-verified unsolicited observation is separately keyed");
 check((await claim(workerA,ids.history,"toast_price_initial",0))===null,
  "replaying the same initial observation does not produce another receipt");
 const ownWindow=await role(workerA,"authenticated",ids.owner,async c=>
  one(c,"select count(*)::int as n from public.supervisor_monitor_windows where business_id=$1",[ids.business]));
 check(ownWindow.n===1,"correct owner reads pinned receipt");
 const otherWindow=await role(workerA,"authenticated",ids.foreignOwner,async c=>
  one(c,"select count(*)::int as n from public.supervisor_monitor_windows where business_id=$1",[ids.business]));
 check(otherWindow.n===0,"other owner cannot see pinned receipt");
 console.log("PASS Task8a migrated SQL acceptance: "+assertions+
  " checks (source guard, pinned recovery, RLS/tenant, claims, real two-session race)");
}
async function cleanup(){
 if(!seeded)return;
 // This optional sync row references the location mapping without cascading;
 // remove the synthetic source snapshot before deleting its café.
 await admin.query("delete from public.toast_optional_sync_state where business_id=$1 or business_id=$2",
  [ids.business,ids.foreignBusiness]);
 await admin.query("delete from public.businesses where id=$1 or id=$2",
  [ids.business,ids.foreignBusiness]);
 await admin.query("delete from auth.users where id=$1 or id=$2",
  [ids.owner,ids.foreignOwner]);
}
try{
 await Promise.all([admin.connect(),workerA.connect(),workerB.connect()]);
 await run();
}catch(error){console.error("FAIL Task8a migrated SQL acceptance:",error);process.exitCode=1;
}finally{
 try{await cleanup();}catch(error){console.error("FAIL Task8a cleanup:",error);process.exitCode=1;}
 await Promise.allSettled([admin.end(),workerA.end(),workerB.end()]);
}
