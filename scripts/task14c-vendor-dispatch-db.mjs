/**
 * Task14C actual migrated PostgreSQL security/one-shot Gmail dispatch proof.
 * TASK14C_DISPOSABLE_DB=1 node scripts/task14c-vendor-dispatch-db.mjs
 * All writes occur in a ROLLBACK-only transaction on local Supabase.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
if(process.env.TASK14C_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
 user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
const id={business:randomUUID(),otherBusiness:randomUUID(),owner:randomUUID(),
 outsider:randomUUID(),thread:randomUUID(),oldProposal:randomUUID(),
 gmailProposal:randomUUID(),supplier:randomUUID(),ingredient:randomUUID(),
 quote:randomUUID(),po:randomUUID(),contact:randomUUID(),dispatch:randomUUID(),
 account:randomUUID(),attempt:randomUUID(),receipt:randomUUID()};
const poHash="a".repeat(64),gmailHash="b".repeat(64);
let count=0;
const check=(condition,label)=>{assert.ok(condition,label);count++};
const one=async(query,params=[])=>((await db.query(query,params)).rows[0]??null);
async function asRole(role,user,fn){
 await db.query("SAVEPOINT task14c_role");
 try{
  await db.query("SET LOCAL ROLE "+role);
  await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);
  const result=await fn();
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14c_role");
  return result;
 }catch(e){
  await db.query("ROLLBACK TO SAVEPOINT task14c_role");
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14c_role");
  throw e;
 }
}
async function fails(fn,code,label){
 let err=null;
 try{await fn()}catch(e){err=e.code}
 assert.equal(err,code,label);count++;
}
const sql="select public.supervisor_reserve_supplier_gmail_send($1,$2,$3,$4) as reserved";
const args=[id.business,id.owner,id.gmailProposal,gmailHash];
try{
 await db.connect();
 await db.query("BEGIN");
 check((await one("select to_regprocedure('public.supervisor_reserve_supplier_gmail_send(uuid,uuid,uuid,text)') is not null as present")).present,
  "14C unique scoped supplier Gmail sender gate is installed");
 for(const table of ["cafe_supplier_order_contacts","purchase_order_dispatches","purchase_order_channel_reports"]){
  check((await one("select relrowsecurity as enabled from pg_class where oid=$1::regclass",
    ["public."+table])).enabled,table+" has RLS");
 }
 await db.query(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14c-owner@example.invalid','',now(),now()),
 ($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14c-other@example.invalid','',now(),now())`,
 [id.owner,id.outsider]);
 await db.query("insert into public.businesses(id,name,is_demo,timezone,currency) values($1,'Task14C Local A',false,'UTC','USD'),($2,'Task14C Local B',false,'UTC','USD')",
 [id.business,id.otherBusiness]);
 await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
 [id.business,id.owner,id.otherBusiness,id.outsider]);
 await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
 [id.thread,id.business,id.owner,randomUUID()]);
 await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,'Task14C Farm')",
 [id.supplier,id.business]);
 await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','ml')",
 [id.ingredient,id.business]);
 await db.query(`insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,
 supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,
 quoted_on,currency_code)
 values($1,$2,$3,$4,'Task14C Farm','Milk',$5,250,1,'gal','supplier_quote',current_date,'USD')`,
 [id.quote,id.business,id.owner,randomUUID(),id.ingredient]);
 await db.query(`insert into public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
 canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
 values($1,$3,$4,$5,$6,'maya.supplier_purchase_order.v1',1,
 '{}'::jsonb,$7,'{}'::jsonb,'{"durationDays":1,"metricScope":"supplier_purchase_order"}'::jsonb,
 'en','committed',4),
 ($2,$3,$4,$5,$8,'alex.gmail_effect.v1',1,
 $9::jsonb,$10,'{}'::jsonb,'{"durationDays":1,"metricScope":"gmail_provider_receipt"}'::jsonb,
 'en','executing',3)`,
 [id.oldProposal,id.gmailProposal,id.business,id.owner,id.thread,randomUUID(),
  poHash,randomUUID(),JSON.stringify({
   operation:"send",action:null,to:["orders@task14c.example"],cc:[],bcc:[],
   subject:"Purchase order "+id.po,body:"Purchase order ID: "+id.po,
   messageId:null,threadId:null,
   labelId:null,labelName:null,accountId:id.account,generation:1,from:"owner@task14c.example"
  }),gmailHash]);
 await db.query(`insert into public.purchase_orders(
 id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,proposal_id,effect_hash,
 status,revision,currency_code,subtotal_cents,needed_by)
 values($1,$2,$3,$4,'Task14C Farm',$5,$6,'approved_for_ordering',1,'USD',250,current_date+3)`,
 [id.po,id.business,id.owner,id.supplier,id.oldProposal,poHash]);
 await db.query(`insert into public.purchase_order_lines(
 business_id,purchase_order_id,quote_id,ingredient_id,ordinal,item_name_snapshot,
 needed_base_quantity,base_unit,packs,pack_quantity,pack_unit,unit_price_cents,
 subtotal_cents,quoted_on)
 values($1,$2,$3,$4,1,'Milk',3785.4,'ml',1,1,'gal',250,250,current_date)`,
 [id.business,id.po,id.quote,id.ingredient]);
 await db.query(`insert into public.cafe_supplier_order_contacts(
 id,business_id,supplier_id,owner_user_id,channel,email)
 values($1,$2,$3,$4,'gmail','orders@task14c.example')`,
 [id.contact,id.business,id.supplier,id.owner]);
 await db.query(`insert into public.connector_accounts(
 id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,
 enabled_operations,status,generation)
 values($1,$2,$3,'gmail','task14c-owner','owner@task14c.example',
 array['https://www.googleapis.com/auth/gmail.modify']::text[],
 array['read','send']::text[],'active',1)`,
 [id.account,id.business,id.owner]);
 await db.query(`insert into public.purchase_order_dispatches(
 id,business_id,purchase_order_id,owner_user_id,contact_id,proposal_id,po_revision,
 po_effect_hash,recipient_email,state)
 values($1,$2,$3,$4,$5,$6,1,$7,'orders@task14c.example','prepared')`,
 [id.dispatch,id.business,id.po,id.owner,id.contact,id.gmailProposal,poHash]);
 // The owner must be able to correct an UNSENT email without creating
 // another PO or silently leaving the first approval actionable.
 const rebindSql="select public.supervisor_rebind_supplier_gmail_draft($1,$2,$3,$4) as rebound";
 const testRebind=async(scenario)=>{
   const nextProposal=randomUUID(),nextEmail=scenario==="corrected_email"?
     "corrected@task14c.example":"orders@task14c.example";
   await db.query("SAVEPOINT task14c_rebind_case");
   try{
     await db.query("update public.supervisor_proposals set status=$1,revision=revision+1 where id=$2",
       [scenario==="cancelled"?"rejected":"draft",id.gmailProposal]);
     if(scenario==="corrected_email")await db.query(
       "update public.cafe_supplier_order_contacts set email=$1 where id=$2",
       [nextEmail,id.contact]);
     await db.query(`insert into public.supervisor_proposals(
       id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
       canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
       values($1,$2,$3,$4,$5,'alex.gmail_effect.v1',1,$6::jsonb,$7,
        '{}'::jsonb,'{"durationDays":1,"metricScope":"gmail_provider_receipt"}'::jsonb,
        'en','draft',1)`,[nextProposal,id.business,id.owner,id.thread,randomUUID(),JSON.stringify({
       operation:"send",action:null,to:[nextEmail],cc:[],bcc:[],
       subject:"Purchase order "+id.po,body:"Purchase order ID: "+id.po,
       messageId:null,threadId:null,labelId:null,labelName:null,
       accountId:id.account,generation:1,from:"owner@task14c.example"
     }),"c".repeat(64)]);
     await fails(()=>asRole("authenticated",id.owner,()=>one(rebindSql,
       [id.business,id.owner,id.po,nextProposal])),"42501",
       "Only service-role gateway may atomically replace a supplier approval");
     const rebound=await asRole("service_role",id.owner,()=>one(rebindSql,
       [id.business,id.owner,id.po,nextProposal]));
     check(rebound?.rebound===true,scenario+": provably unsent draft can be replaced");
     const state=await one(`select d.proposal_id,d.state,d.recipient_email,p.status as old_status
       from public.purchase_order_dispatches d
       join public.supervisor_proposals p on p.id=$2
       where d.id=$1`,[id.dispatch,id.gmailProposal]);
     check(state.proposal_id===nextProposal&&state.recipient_email===nextEmail&&
       state.state==="prepared"&&state.old_status==="rejected",
       scenario+": old card revoked, one new draft, no provider send");
     const replay=await asRole("service_role",id.owner,()=>one(rebindSql,
       [id.business,id.owner,id.po,nextProposal]));
     check(replay?.rebound===true,scenario+": identical saved draft replay is idempotent");
     // A privileged malformed proposal with NULL subject must not sneak
     // through PostgreSQL three-valued OR checks.
     const malformedId=randomUUID();
     await db.query(`insert into public.supervisor_proposals(
       id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
       canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
       values($1,$2,$3,$4,$5,'alex.gmail_effect.v1',1,$6::jsonb,$7,
        '{}'::jsonb,'{"durationDays":1,"metricScope":"gmail_provider_receipt"}'::jsonb,
        'en','draft',1)`,[malformedId,id.business,id.owner,id.thread,
       randomUUID(),JSON.stringify({operation:"send",action:null,to:[nextEmail],cc:[],bcc:[],
         subject:null,body:"untrusted",messageId:null,threadId:null,labelId:null,labelName:null,
         accountId:id.account,generation:1,from:"owner@task14c.example"}),"d".repeat(64)]);
     await fails(()=>asRole("service_role",id.owner,()=>one(rebindSql,
       [id.business,id.owner,id.po,malformedId])),"P0001",
       "Malformed null-subject draft cannot be rebound to a supplier PO");
     check((await one(`select count(*)::int as n from public.purchase_order_dispatches
       where business_id=$1 and purchase_order_id=$2`,[id.business,id.po])).n===1,
       scenario+": exactly one PO dispatch remains");
   }finally{
     await db.query("ROLLBACK TO SAVEPOINT task14c_rebind_case");
     await db.query("RELEASE SAVEPOINT task14c_rebind_case");
   }
 };
 await testRebind("cancelled");
 await testRebind("corrected_email");
 await fails(()=>asRole("authenticated",id.owner,()=>one(sql,args)),
  "42501","Authenticated SQL caller cannot bypass the effect gateway");
 await fails(()=>asRole("service_role",id.owner,()=>one(sql,args)),
  "P0001","Service role still needs the saved owner-click gateway attempt");
 await db.query(`insert into public.supervisor_approvals(
 business_id,proposal_id,owner_user_id,approved_revision,effect_hash,authorization_kind)
 values($1,$2,$3,1,$4,'click')`,
 [id.business,id.gmailProposal,id.owner,gmailHash]);
 await db.query(`insert into public.supervisor_effect_attempts(
 attempt_key,business_id,proposal_id,effect_hash,authorization_kind,business_date,state)
 values($1,$2,$3,$4,'click',current_date,'executing')`,
 [id.attempt,id.business,id.gmailProposal,gmailHash]);
 await fails(()=>asRole("service_role",id.outsider,()=>one(sql,
  [id.business,id.outsider,id.gmailProposal,gmailHash])),
  "42501","Other café cannot reserve an outbound supplier send");
 // Non-negotiable: a previously approved click cannot send if any canonical
 // PO, contact or gateway evidence is changed by the time of reservation.
 async function denyAfterChange(query,params,label){
   await db.query("SAVEPOINT vendor_approval_mutation");
   try{
     await db.query(query,params);
     await fails(()=>asRole("service_role",id.owner,()=>one(sql,args)),
       "P0001",label);
   }finally{
     await db.query("ROLLBACK TO SAVEPOINT vendor_approval_mutation");
     await db.query("RELEASE SAVEPOINT vendor_approval_mutation");
   }
 }
 await denyAfterChange(
   "update public.cafe_supplier_order_contacts set revoked_at=now() where id=$1",
   [id.contact],"Revoked supplier contact blocks prior send approval");
 await denyAfterChange(
   "update public.cafe_supplier_order_contacts set email='wrong@task14c.example' where id=$1",
   [id.contact],"Recipient change blocks stale approval");
 await denyAfterChange(
   "update public.purchase_orders set status='cancelled' where id=$1",
   [id.po],"Cancelled PO cannot be sent using prior approval");
 await denyAfterChange(
   "update public.purchase_orders set revision=2 where id=$1",
   [id.po],"Revised PO cannot be sent using prior approval");
 await denyAfterChange(
   "update public.supervisor_proposals set status='rejected',revision=revision+1 where id=$1",
   [id.gmailProposal],"Revoked Gmail approval cannot authorize a vendor send");
 const reserved=await asRole("service_role",id.owner,()=>one(sql,args));
 check(reserved.reserved===true,"Exact owner-click send reserves exactly one PO");
 await fails(()=>asRole("service_role",id.owner,()=>one(sql,args)),
  "P0001","Concurrent/replayed click cannot reserve this PO twice");
 await fails(()=>asRole("service_role",id.owner,()=>one(rebindSql,
   [id.business,id.owner,id.po,randomUUID()])),"P0001",
   "Reserved or uncertain provider effect can never be rebound to a new approval");
 const pending=await one("select state,provider_accepted_at from public.purchase_order_dispatches where id=$1",[id.dispatch]);
 check(pending.state==="reserved"&&pending.provider_accepted_at===null,
  "A reserved or timed-out send is NOT a provider-confirmed sent message");
 const foreign=await asRole("authenticated",id.outsider,()=>db.query(
  "select * from public.purchase_order_dispatches where business_id=$1",[id.business]));
 check(foreign.rows.length===0,"Other café cannot enumerate dispatches");
 await fails(()=>asRole("authenticated",id.outsider,()=>db.query(`
  insert into public.purchase_order_channel_reports(business_id,purchase_order_id,owner_user_id,channel,outcome,note)
  values($1,$2,$3,'portal','supplier_accepted','forged')`,
 [id.business,id.po,id.outsider])),"42501",
 "Other café cannot invent a supplier-accepted report for this PO");
 await db.query(`insert into public.connector_provider_receipts(
 id,account_id,business_id,owner_user_id,proposal_id,effect_hash,account_generation,
 operation,rfc_message_id,state)
 values($1,$2,$3,$4,$5,$6,1,'send','<task14c@aicafe.example>','pending')`,
 [id.receipt,id.account,id.business,id.owner,id.gmailProposal,gmailHash]);
 const beforeVerified=await one("select state from public.purchase_order_dispatches where id=$1",[id.dispatch]);
 check(beforeVerified.state==="reserved","A pending Gmail provider receipt cannot prove a send");
 await db.query(`update public.connector_provider_receipts
 set state='verified',provider_message_id='gmail-test-message',provider_thread_id='gmail-test-thread',
     provider_accepted_at=now()
 where id=$1`,[id.receipt]);
 const accepted=await one("select state,provider_receipt_id,provider_accepted_at from public.purchase_order_dispatches where id=$1",[id.dispatch]);
 check(accepted.state==="provider_accepted"&&accepted.provider_receipt_id===id.receipt&&
   accepted.provider_accepted_at!==null,"ONLY independently persisted Gmail acceptance marks a PO sent");
 check((await one("select count(*)::int as n from public.purchase_order_channel_reports where purchase_order_id=$1",
  [id.po])).n===0,"Gmail acceptance is never promoted to supplier acceptance");
 await asRole("authenticated",id.owner,()=>db.query(`
  insert into public.purchase_order_channel_reports(business_id,purchase_order_id,owner_user_id,channel,outcome,note)
  values($1,$2,$3,'phone','supplier_acknowledged','Owner called the supplier; acceptance still unconfirmed')`,
 [id.business,id.po,id.owner]));
 const report=await one("select channel,outcome from public.purchase_order_channel_reports where purchase_order_id=$1",[id.po]);
 check(report.channel==="phone"&&report.outcome==="supplier_acknowledged",
  "A phone negotiation stays explicitly owner-reported, not a Gmail receipt");
 check((await one("select count(*)::int as n from public.purchase_order_dispatches where purchase_order_id=$1",
 [id.po])).n===1,"Exactly one canonical PO dispatch row exists");
 // Existing proactive routine must not silently drop a canonical approved PO
 // simply because its supplier uses phone, a portal, or no Gmail history.
 await db.query("update public.purchase_orders set approved_at=now()-interval '3 hours' where id=$1",[id.po]);
 const sourceReason="Approved order unresolved: was the supplier contacted by Gmail, phone or portal, and what did they confirm?";
 const noticeArgs=[id.business,id.owner,id.thread,"supplier_dispatch",id.po,
   poHash,gmailHash,sourceReason,new Date().toISOString()];
 const firstNotice=await asRole("service_role",id.owner,()=>one(
   "select public.post_supervisor_priority_notice($1,$2,$3,$4,$5,$6,$7,$8,$9) as posted",noticeArgs));
 check(firstNotice?.posted===true,
   "Existing routine writes a real owner question for an unresolved 3-hour supplier PO");
 const duplicateNotice=await asRole("service_role",id.owner,()=>one(
   "select public.post_supervisor_priority_notice($1,$2,$3,$4,$5,$6,$7,$8,$9) as posted",noticeArgs));
 check(duplicateNotice?.posted===false,
   "Proactive vendor question is durable and deduplicated in the existing owner inbox");
 const ownerNotice=await one("select id,payload from public.operating_tasks where business_id=$1 and id=$2",
  [id.business,"priority:"+gmailHash]);
 check(ownerNotice?.payload?.title===sourceReason,
   "Owner-facing supplier question names Gmail, phone or portal rather than silently failing");
 await asRole("authenticated",id.owner,()=>db.query(`
   insert into public.purchase_order_channel_reports(business_id,purchase_order_id,owner_user_id,channel,outcome,note)
   values($1,$2,$3,'phone','supplier_accepted','Owner confirmed by phone')`,
   [id.business,id.po,id.owner]));
 const handledNotice=await one("select status,resolved_at,payload from public.operating_tasks"+
   " where business_id=$1 and id=$2",[id.business,"priority:"+gmailHash]);
 // These reports are inserted in ONE rolled-back test transaction. SQL now()
 // assigns the same timestamp to both; "order by reported_at" alone cannot
 // identify the accepted report. Verify its exact scoped evidence instead.
 const ownerOutcome=await one("select business_id,owner_user_id,purchase_order_id,channel,outcome,note"+
   " from public.purchase_order_channel_reports where business_id=$1 and purchase_order_id=$2"+
   " and outcome='supplier_accepted' and note='Owner confirmed by phone'",
   [id.business,id.po]);
 check(handledNotice?.status==="handled"&&handledNotice.resolved_at!==null,
   "Owner-confirmed acceptance moves its exact Needs-you supplier question to Handled");
 check(JSON.stringify(handledNotice?.payload)===JSON.stringify(ownerNotice?.payload),
   "Closing a supplier notice preserves the immutable original source evidence");
 check(ownerOutcome?.owner_user_id===id.owner&&ownerOutcome.purchase_order_id===id.po&&
   ownerOutcome.channel==="phone"&&ownerOutcome.outcome==="supplier_accepted"&&
   ownerOutcome.note==="Owner confirmed by phone",
   "Closure attribution remains in the exact owner-reported phone acceptance record");
 const noMore=await asRole("service_role",id.owner,()=>one(
   "select public.post_supervisor_priority_notice($1,$2,$3,$4,$5,$6,$7,$8,$9) as posted",
   [...noticeArgs.slice(0,6),"c".repeat(64),sourceReason,noticeArgs[8]]));
 check(noMore?.posted===false,
   "Once the owner reports supplier acceptance, old source cannot generate a new reminder");
 console.log("Task14C real migrated Postgres: "+count+" security, uncertainty, provider receipt and owner-channel checks passed");
}finally{
 await db.query("ROLLBACK").catch(()=>{});
 await db.end().catch(()=>{});
}
