import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import pg from "pg";
const base={host:process.env.PGHOST??"127.0.0.1",port:Number(process.env.PGPORT??5432),user:"postgres",password:"postgres",database:"postgres"};
const admin=new pg.Client(base),database="aicafe_gateway_"+randomUUID().replace(/-/gu,"").slice(0,16);
const config={...base,database},db=new pg.Client(config),other=new pg.Client(config);
const B="11111111-1111-4111-8111-111111111111",B2="22222222-2222-4222-8222-222222222222";
const OWNER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",OWNER2="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD="33333333-3333-4333-8333-333333333333",THREAD2="44444444-4444-4444-8444-444444444444";
const factor="55555555-5555-4555-8555-555555555555",mandate="66666666-6666-4666-8666-666666666666",mandate2="77777777-7777-4777-8777-777777777777";
const policyA="a".repeat(64),policyB="b".repeat(64);
const rpcTransition="select public.supervisor_transition_proposal($1,$2,$3,$4,$5,$6) as value";
const rpcChallenge="select public.supervisor_create_mandate_challenge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) as value";
const rpcComplete="select to_jsonb(public.supervisor_complete_mandate_challenge($1,$2,$3,$4,$5)) as value";
const rpcClaim="select public.supervisor_claim_effect($1,$2,$3,$4,$5,$6) as value";
const rpcFinish="select to_jsonb(public.supervisor_finish_effect_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)) as value";
const rpcRevoke="select to_jsonb(public.supervisor_revoke_mandate($1,$2,$3,$4)) as value";
const rpcStaff="select public.supervisor_gateway_commit_staff($1,$2,$3,$4,$5) as value";
const rpcReconcile="select to_jsonb(public.supervisor_reconcile_effect_attempt($1,$2,$3,$4,$5)) as value";
async function withService(client,fn){
 await client.query("begin");
 try{await client.query("set local role service_role");
  await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  const value=await fn(client);await client.query("commit");return value;
 }catch(error){await client.query("rollback");throw error;}
}
async function withAuthenticated(client,userId,fn){
 await client.query("begin");
 try{
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await client.query("select set_config('request.jwt.claim.sub',$1,true)",[userId]);
  const result=await fn(client);await client.query("commit");return result;
 }catch(error){await client.query("rollback");throw error;}
}
async function expectError(fn,code){let actual=null;try{await fn();}catch(error){actual=error.code;}assert.equal(actual,code,"expected SQLSTATE "+code);}
async function seedProposal(business,owner,thread,id,capability="leo.goal.v1",effect={goal:"increase_orders",target:5}){
 const hash=createHash("sha256").update(JSON.stringify(effect)+id).digest("hex");
 await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) values($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8,$9::jsonb,$10::jsonb,'en')",
 [id,business,owner,thread,randomUUID(),capability,JSON.stringify(effect),hash,JSON.stringify({source:"metric_catalog"}),JSON.stringify({durationDays:1,metricScope:"goal"})]);
}
async function issueChallenge(opts={}){
 const business=opts.business??B,owner=opts.owner??OWNER,challengeId=randomUUID();
 const action=opts.action??"grant",mandateId=opts.mandateId??mandate,revision=opts.revision??0;
 const limit=opts.limit??5,policyHash=opts.policyHash??policyA,factorId=opts.factorId??factor,providerId=opts.providerId??"provider-"+randomUUID();
 const mandateExpiry=new Date(Date.now()+86400000).toISOString(),challengeExpiry=new Date(Date.now()+300000).toISOString();
 const args=[business,owner,challengeId,action,mandateId,revision,"leo.goal.v1",1,policyHash,limit,"cafe_day",mandateExpiry,factorId,providerId,challengeExpiry];
 await withService(db,async c=>c.query(rpcChallenge,args));
 return {business,owner,challengeId,mandateId,revision:revision===0?1:revision+1,factorId,providerId,mandateExpiry};
}
async function complete(ch,{business=ch.business,owner=ch.owner,factorId=ch.factorId,providerId=ch.providerId}={}){
 return withService(db,async c=>(await c.query(rpcComplete,[business,owner,ch.challengeId,factorId,providerId])).rows[0].value);
}
async function claim(business,owner,thread,id,revision=1,kind="mandate",client=db){
 return withService(client,async c=>(await c.query(rpcClaim,[business,owner,thread,id,revision,kind])).rows[0].value);
}
async function finish(business,owner,thread,id,claimValue,state,nextStatus=null,startDate=null){
 return withService(db,async c=>(await c.query(rpcFinish,[business,owner,thread,id,claimValue.attempt_key,claimValue.proposal.revision,state,nextStatus,startDate])).rows[0].value);
}
try{
 await admin.connect();await admin.query("create database "+database);await db.connect();await other.connect();
 await db.query([
  "create extension if not exists pgcrypto",
  "do $$ begin create role anon nologin; exception when duplicate_object then null; end $$",
  "do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$",
  "do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$",
  "create schema auth","create table auth.users(id uuid primary key)",
  "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$",
  "create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon') $$",
  "create table public.businesses(id uuid primary key,timezone text not null,is_demo boolean not null default false)",
  "create table public.memberships(business_id uuid not null references businesses(id),user_id uuid not null references auth.users(id),role text not null,primary key(business_id,user_id))",
  "create table public.ai_threads(id uuid primary key,business_id uuid not null references businesses(id),owner_user_id uuid not null references auth.users(id),unique(business_id,id,owner_user_id))",
  "create table public.locations(id uuid primary key,business_id uuid not null references businesses(id))",
  "create table public.pantry_stock_purchases(id uuid primary key default gen_random_uuid(),business_id uuid not null,ingredient_id uuid not null,line_id uuid not null,purchase_date date not null,entered_quantity numeric not null,entered_unit text not null,cost_cents bigint,source text not null,voided_at timestamptz,unique(business_id,line_id))",
  "create table public.menu_price_history(id uuid primary key default gen_random_uuid(),business_id uuid not null,menu_item_id uuid not null,old_price_cents bigint not null,new_price_cents bigint not null,source_type text not null,source_provider text,changed_at timestamptz not null default now())",
  "create table public.menu_items(id uuid primary key,business_id uuid not null,price_cents bigint not null)",
  "alter table public.menu_price_history enable row level security",
  "create policy \"members write price history\" on public.menu_price_history for all to authenticated using(true) with check(true)",
  "grant usage on schema public,auth to authenticated",
  "grant insert,select,update,delete on public.menu_price_history to authenticated",
  "grant select on public.memberships to authenticated",
  "grant execute on function auth.uid() to authenticated",
  "grant usage on schema auth,public to service_role",
  "grant execute on function auth.uid() to service_role","grant execute on function auth.role() to service_role",
  "grant select on public.memberships to service_role",
 ].join(";"));
 await db.query(readFileSync(new URL("../supabase/migrations/20261020000074_supervisor_execution_loop.sql",import.meta.url),"utf8"));
 await db.query(readFileSync(new URL("../supabase/migrations/20261023000083_approval_lifecycle_atomicity.sql",import.meta.url),"utf8"));
  await db.query("create function public.supervisor_commit_staff_proposal(uuid,uuid,uuid,uuid,integer) returns jsonb language plpgsql as $stub$ declare p public.supervisor_proposals; begin update public.supervisor_proposals set status='executing',revision=revision+1,updated_at=now() where business_id=$1 and owner_user_id=$2 and thread_id=$3 and id=$4 and revision=$5 and status='approved' returning * into p; if p.id is null then raise exception 'stub_revision_conflict' using errcode='P0001'; end if; update public.supervisor_proposals set status='committed',revision=revision+1,committed_at=now(),monitoring_start_date=current_date+1,updated_at=now() where id=p.id returning * into p; return jsonb_build_object('state','applied','proposal',to_jsonb(p)); end $stub$");
 await db.query(readFileSync(new URL("../supabase/migrations/20261111000206_supervisor_effect_gateway.sql",import.meta.url),"utf8"));
 await db.query(readFileSync(new URL("../supabase/migrations/20261112000301_supervisor_effect_reconciliation.sql",import.meta.url),"utf8"));
 await db.query("insert into businesses(id,timezone,is_demo) values($1,'UTC',false),($2,'UTC',false)",[B,B2]);
 await db.query("insert into auth.users(id) values($1),($2)",[OWNER,OWNER2]);
 await db.query("insert into memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[B,OWNER,B2,OWNER2]);
 await db.query("insert into ai_threads(id,business_id,owner_user_id) values($1,$2,$3),($4,$5,$6)",[THREAD,B,OWNER,THREAD2,B2,OWNER2]);

 await expectError(()=>issueChallenge({limit:4}),"22023");
 const first=await issueChallenge();
 await expectError(()=>complete(first,{factorId:"88888888-8888-4888-8888-888888888888"}),"42501");
 const granted=await complete(first);assert.equal(granted.id,mandate);assert.equal(granted.revision,1);assert.equal(granted.limit_value,5);
 await expectError(()=>complete(first),"42501");
 const ids=[
  "90000000-0000-4000-8000-000000000001","90000000-0000-4000-8000-000000000002",
  "90000000-0000-4000-8000-000000000003","90000000-0000-4000-8000-000000000004",
  "90000000-0000-4000-8000-000000000005","90000000-0000-4000-8000-000000000006",
 ];
 for(const id of ids)await seedProposal(B,OWNER,THREAD,id);
 const firstFour=[];
 for(const id of ids.slice(0,4))firstFour.push(await claim(B,OWNER,THREAD,id));
 const raced=await Promise.allSettled([
  claim(B,OWNER,THREAD,ids[4]),
  claim(B,OWNER,THREAD,ids[5],1,"mandate",other),
 ]);
 assert.equal(raced.filter(x=>x.status==="fulfilled").length,1);
 assert.equal(raced.filter(x=>x.status==="rejected").length,1);
 const winner=raced.find(x=>x.status==="fulfilled").value;
 assert.equal(winner.proposal.status,"executing");
 const uncertain=await finish(B,OWNER,THREAD,winner.proposal.id,winner,"uncertain");
 assert.equal(uncertain.status,"executing");
 const attempt=(await db.query("select state,authorization_kind,mandate_id,mandate_revision from supervisor_effect_attempts where attempt_key=$1",[winner.attempt_key])).rows[0];
 assert.deepEqual(attempt,{state:"uncertain",authorization_kind:"mandate",mandate_id:mandate,mandate_revision:"1"});
 await expectError(()=>claim(B,OWNER,THREAD,winner.proposal.id,winner.proposal.revision),"42501");
 const nextDay=(await db.query("select ((now() at time zone timezone)::date+1) as next_day from businesses where id=$1",[B])).rows[0].next_day;
 const verified=await finish(B,OWNER,THREAD,ids[0],firstFour[0],"verified","committed",nextDay);
 assert.equal(verified.status,"committed");

 // A revised mandate keeps the same fixed cap. Earlier revisions' executing,
 // verified and uncertain attempts continue to consume today's five-start quota.
 const revise=await issueChallenge({action:"revise",mandateId:mandate,revision:1,limit:5,policyHash:policyB});
 const revised=await complete(revise);
 assert.equal(revised.revision,2);assert.equal(revised.limit_value,5);
 const afterRevision="90000000-0000-4000-8000-000000000011";
 await seedProposal(B,OWNER,THREAD,afterRevision);
 await expectError(()=>claim(B,OWNER,THREAD,afterRevision),"42501");

 const staleChallenge=await issueChallenge({action:"revise",mandateId:mandate,revision:2,limit:5,policyHash:"c".repeat(64)});
 const revoked=await withService(db,async c=>(await c.query(rpcRevoke,[B,OWNER,mandate,2])).rows[0].value);
 assert.ok(revoked.revoked_at);assert.equal(revoked.revision,3);
 await expectError(()=>complete(staleChallenge),"P0001");
 await expectError(()=>claim(B,OWNER,THREAD,afterRevision),"42501");

 // Five starts are a CAFÉ cap, not five for each owner of that café.
 const sharedThread="55555555-5555-4555-8555-555555555556";
 const sharedMandateId="66666666-6666-4666-8666-666666666667";
 const sharedGoal="90000000-0000-4000-8000-000000000012";
 await db.query("insert into memberships(business_id,user_id,role) values($1,$2,'owner')",[B,OWNER2]);
 await db.query("insert into ai_threads(id,business_id,owner_user_id) values($1,$2,$3)",
   [sharedThread,B,OWNER2]);
 const shared=await issueChallenge({business:B,owner:OWNER2,mandateId:sharedMandateId,limit:5});
 await complete(shared);
 await seedProposal(B,OWNER2,sharedThread,sharedGoal);
 await expectError(()=>claim(B,OWNER2,sharedThread,sharedGoal),"42501");

 const independent=await issueChallenge({business:B2,owner:OWNER2,mandateId:mandate2,limit:5});
 await complete(independent);
 const foreignGoal="90000000-0000-4000-8000-000000000010";
 await seedProposal(B2,OWNER2,THREAD2,foreignGoal);
 const foreignClaim=await claim(B2,OWNER2,THREAD2,foreignGoal);
 assert.equal(foreignClaim.proposal.status,"executing");
 await expectError(()=>withService(db,c=>c.query(rpcClaim,[B2,OWNER,THREAD2,foreignGoal,1,"mandate"])),"42501");

 const clickId="90000000-0000-4000-8000-000000000009";
 await seedProposal(B,OWNER,THREAD,clickId,"alex.menu_price_change.v1");
 await withService(db,c=>c.query(rpcTransition,[B,OWNER,clickId,1,"approve",null]));
 const clickClaim=await claim(B,OWNER,THREAD,clickId,2,"click");
 assert.equal(clickClaim.authorization_kind,"click");
 const approval=(await db.query("select authorization_kind,approved_revision from supervisor_approvals where proposal_id=$1",[clickId])).rows[0];
 assert.equal(approval.authorization_kind,"click");assert.equal(approval.approved_revision,1);
 await expectError(()=>withService(db,c=>c.query(rpcTransition,[B,OWNER,clickId,3,"claim_commit",null])),"42501");
 await finish(B,OWNER,THREAD,clickId,clickClaim,"verified","manual_pending",null);

 const staffMandateId="90000000-0000-4000-8000-000000000007";
 await seedProposal(B,OWNER,THREAD,staffMandateId,"olivia.staff_propose_schedule.v2");
 const staffRow=(await db.query("select effect_hash from supervisor_proposals where id=$1",[staffMandateId])).rows[0];
 await db.query("insert into supervisor_approvals(business_id,proposal_id,owner_user_id,approved_revision,effect_hash,authorization_kind,mandate_id,mandate_revision) values($1,$2,$3,1,$4,'mandate',$5,1)",
  [B,staffMandateId,OWNER,staffRow.effect_hash,mandate]);
 await db.query("update supervisor_proposals set status='approved',approved_at=now(),approved_by=$2,revision=2 where id=$1",[staffMandateId,OWNER]);
 await expectError(()=>withService(db,c=>c.query(rpcStaff,[B,OWNER,THREAD,staffMandateId,2])),"42501");
 assert.equal((await db.query("select count(*)::integer as n from supervisor_effect_attempts where proposal_id=$1",[staffMandateId])).rows[0].n,0);

 const staffClickId="90000000-0000-4000-8000-000000000008";
 await seedProposal(B,OWNER,THREAD,staffClickId,"olivia.staff_propose_schedule.v2");
 await withService(db,c=>c.query(rpcTransition,[B,OWNER,staffClickId,1,"approve",null]));
 const staffResult=await withService(db,async c=>(await c.query(rpcStaff,[B,OWNER,THREAD,staffClickId,2])).rows[0].value);
 assert.equal(staffResult.state,"applied");assert.equal(staffResult.proposal.status,"committed");
 const staffAttempt=(await db.query("select state,authorization_kind from supervisor_effect_attempts where proposal_id=$1",[staffClickId])).rows[0];
 assert.deepEqual(staffAttempt,{state:"verified",authorization_kind:"click"});

 // A lost response for an inert goal recovers from its durable scoped claim.
 // Revocation must not erase in-flight evidence or free a spent daily quota.
 await db.query("update supervisor_effect_attempts set created_at = now()-interval '10 minutes' where attempt_key=$1",[winner.attempt_key]);
 const recoveredGoal=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,winner.proposal.id,winner.proposal.revision])).rows[0].value);
 assert.equal(recoveredGoal.status,"committed");
 assert.equal((await db.query("select state from supervisor_effect_attempts where attempt_key=$1",[winner.attempt_key])).rows[0].state,"verified");
 const recoveredAgain=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,winner.proposal.id,recoveredGoal.revision])).rows[0].value);
 assert.equal(recoveredAgain.revision,recoveredGoal.revision,"a verified receipt must be idempotent");
 await expectError(()=>withService(db,c=>c.query(rpcReconcile,[B2,OWNER,THREAD,winner.proposal.id,recoveredGoal.revision])),"42501");

 // A just-claimed request must not be preempted by reconciliation; after
 // timeout, an inert goal can be completed without calling commit a second time.
 const pending=await withService(db,async c=>(await c.query(rpcReconcile,[B2,OWNER2,THREAD2,foreignGoal,foreignClaim.proposal.revision])).rows[0].value);
 assert.equal(pending.status,"executing");
 await db.query("update supervisor_effect_attempts set created_at=now()-interval '10 minutes' where attempt_key=$1",[foreignClaim.attempt_key]);
 const afterCrash=await withService(db,async c=>(await c.query(rpcReconcile,[B2,OWNER2,THREAD2,foreignGoal,foreignClaim.proposal.revision])).rows[0].value);
 assert.equal(afterCrash.status,"committed");

 // For a real purchase only the canonical unique (business_id,line_id)
 // row with every matching immutable field is authoritative evidence.
 const purchaseId="90000000-0000-4000-8000-000000000013";
 const ingredientId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
 const wrongIngredientId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
 const purchaseDate=(await db.query("select current_date::text as d")).rows[0].d;
 const purchasePayload={ingredientId,name:"Beans",date:purchaseDate,quantity:2,unit:"kg",costCents:1234,source:"chat_text"};
 await seedProposal(B,OWNER,THREAD,purchaseId,"maya.inventory_purchase.v1",purchasePayload);
 await withService(db,c=>c.query(rpcTransition,[B,OWNER,purchaseId,1,"approve",null]));
 const purchaseClaim=await claim(B,OWNER,THREAD,purchaseId,2,"click");
 await finish(B,OWNER,THREAD,purchaseId,purchaseClaim,"uncertain");
 const noProof=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,purchaseId,3])).rows[0].value);
 assert.equal(noProof.status,"executing","missing durable receipt cannot be reported as success");
 const receiptId=randomUUID();
 await db.query("insert into pantry_stock_purchases(id,business_id,ingredient_id,line_id,purchase_date,entered_quantity,entered_unit,cost_cents,source) values($1,$2,$3,$4,$5,2,'kg',1234,'chat_text')",
  [receiptId,B,wrongIngredientId,purchaseId,purchaseDate]);
 const wrongProof=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,purchaseId,3])).rows[0].value);
 assert.equal(wrongProof.status,"executing","mismatching purchase identity is not proof");
 await db.query("update pantry_stock_purchases set ingredient_id=$2 where id=$1",[receiptId,ingredientId]);
 const saved=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,purchaseId,3])).rows[0].value);
 assert.equal(saved.status,"committed");
 const purchaseReceipt=(await db.query("select state,receipt_ref from supervisor_effect_attempts where proposal_id=$1",[purchaseId])).rows[0];
 assert.deepEqual(purchaseReceipt,{state:"verified",receipt_ref:"pantry_stock_purchases:"+receiptId});
 await expectError(()=>withService(db,c=>c.query(rpcReconcile,[B,OWNER2,THREAD,purchaseId,4])),"P0001");

 // An unresolved price write needs both a proposal-scoped history receipt
 // and a matching canonical menu price; either one alone cannot verify.
 // The old all-member history write policy must be narrowed. A staff member
 // cannot forge an owner price receipt, but the owner writer retains INSERT.
 const staffId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 await db.query("insert into auth.users(id) values($1)",[staffId]);
 await db.query("insert into memberships(business_id,user_id,role) values($1,$2,'staff')",[B,staffId]);
 await expectError(()=>withAuthenticated(db,staffId,c=>c.query(
  "insert into menu_price_history(business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider) values($1,$2,450,500,'owner_manual','forged')",
  [B,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"])),"42501");
 const ownerHistoryId=randomUUID();
 await withAuthenticated(db,OWNER,c=>c.query(
  "insert into menu_price_history(id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider) values($1,$2,$3,450,500,'owner_manual','owner-unit-proof')",
  [ownerHistoryId,B,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"]));
 const staffUpdate=await withAuthenticated(db,staffId,c=>c.query(
  "update menu_price_history set source_provider='forged' where id=$1",[ownerHistoryId]));
 assert.equal(staffUpdate.rowCount,0,"staff cannot tamper with history after migration");
 const staffDelete=await withAuthenticated(db,staffId,c=>c.query(
  "delete from menu_price_history where id=$1",[ownerHistoryId]));
 assert.equal(staffDelete.rowCount,0,"history must remain append-only for staff");

 const priceId="90000000-0000-4000-8000-000000000014";
 const menuId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 await seedProposal(B,OWNER,THREAD,priceId,"alex.menu_price_change.v1",
   {productId:menuId,oldPriceCents:450,newPriceCents:500,currency:"USD"});
 await db.query("insert into menu_items(id,business_id,price_cents) values($1,$2,450)",[menuId,B]);
 await withService(db,c=>c.query(rpcTransition,[B,OWNER,priceId,1,"approve",null]));
 const priceClaim=await claim(B,OWNER,THREAD,priceId,2,"click");
 await finish(B,OWNER,THREAD,priceId,priceClaim,"uncertain");
 const priceRecovery=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,priceId,3])).rows[0].value);
 assert.equal(priceRecovery.status,"executing");
 assert.equal((await db.query("select state from supervisor_effect_attempts where proposal_id=$1",[priceId])).rows[0].state,"uncertain");
 // Matching price is not evidence. A false provider or foreign café must not verify.
 const historyId=randomUUID();
 await db.query("insert into menu_price_history(id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider) values($1,$2,$3,450,500,'owner_manual','Alex (owner approved)')",[historyId,B,menuId]);
 assert.equal((await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,priceId,3])).rows[0].value)).status,"executing");
 await db.query("update menu_price_history set source_provider=$2 where id=$1",[
   historyId,"Alex (owner approved; proposal "+priceId+")"]);
 const noPricePostcondition=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,priceId,3])).rows[0].value);
 assert.equal(noPricePostcondition.status,"executing","history alone does not prove that the current price was applied");
 await db.query("update menu_items set price_cents=500 where business_id=$1 and id=$2",[B,menuId]);
 const recoveredPrice=await withService(db,async c=>(await c.query(rpcReconcile,[B,OWNER,THREAD,priceId,3])).rows[0].value);
 assert.equal(recoveredPrice.status,"committed");
 const priceReceipt=(await db.query("select state,receipt_ref from supervisor_effect_attempts where proposal_id=$1",[priceId])).rows[0];
 assert.deepEqual(priceReceipt,{state:"verified",receipt_ref:"menu_price_history:"+historyId});

 const columns=await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='supervisor_mandate_challenges' and (column_name ilike '%code%' or column_name ilike '%otp%')");
 assert.equal(columns.rowCount,0,"No OTP plaintext/code column may be stored");
 console.log("Supervisor effect gateway PostgreSQL: owner/café/action binding, MFA challenge replay protection, per-café-day quota race, revocation, uncertainty, authoritative purchase receipt reconciliation, safe inert recovery and cross-tenant denial passed.");
}finally{
 await other.end().catch(()=>{});await db.end().catch(()=>{});
 await admin.query("drop database if exists "+database+" with (force)").catch(()=>{});
 await admin.end().catch(()=>{});
}
