/** Task14B migrated, disposable Postgres. Never run on live databases. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
if(process.env.TASK14B_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
 user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
const id=()=>randomUUID();
const a={cafe:id(),owner:id(),thread:id(),ingredient:id(),quote:id(),proposal:id()};
const b={cafe:id(),owner:id(),thread:id()};
const date=n=>{const t=new Date();t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
const today=date(0),until=date(5),delivery=date(2),needed=date(3);
const hash="a".repeat(64);
const line={quoteId:a.quote,ingredientId:a.ingredient,itemName:"Milk",
 neededBaseQuantity:3785.411784,baseUnit:"ml",packs:1,packQuantity:1,packUnit:"gal",
 priceCents:450,lineSubtotalCents:450,quotedOn:today,deliveryOn:delivery};
const effect={supplierName:"Farm A",currency:"CAD",neededBy:needed,subtotalCents:450,
 shippingCents:null,taxCents:null,totalCents:null,limitations:["shipping_unknown"],lines:[line]};
let count=0;
const check=(v,m)=>{assert.ok(v,m);count++;};
const one=async(s,params=[])=>((await db.query(s,params)).rows[0]??null);
const fails=async(fn,re)=>{let m="";await db.query("SAVEPOINT task14b_expected");
 try{await fn();}catch(e){m=String(e.message);}
 await db.query("ROLLBACK TO SAVEPOINT task14b_expected");
 await db.query("RELEASE SAVEPOINT task14b_expected");
 assert.match(m,re);count++;};
async function asRole(user,fn){
 await db.query("SAVEPOINT task14b_role");
 try{
  await db.query("SET LOCAL ROLE authenticated");
  await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
  const result=await fn();
  // This helper only reads or verifies denials. Roll back even a successful
  // query so the calling session keeps its original service JWT context.
  await db.query("ROLLBACK TO SAVEPOINT task14b_role");
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14b_role");
  return result;
 }catch(e){
  await db.query("ROLLBACK TO SAVEPOINT task14b_role");
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14b_role");
  throw e;
 }
}
try{
 await db.connect();await db.query("BEGIN");
 await db.query("select set_config('request.jwt.claim.role','service_role',true)");
 check((await one("select to_regprocedure('public.supervisor_commit_supplier_po(uuid,uuid,uuid,uuid,text)') is not null as ok")).ok,"migration installed");
 for(const [owner,address] of [[a.owner,"task14b-a@example.invalid"],[b.owner,"task14b-b@example.invalid"]]){
  await db.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)"+
   " values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
   [owner,address]);
 }
 await db.query("insert into public.businesses(id,name,is_demo,timezone,currency)"+
  " values($1,'Sandbox A',false,'UTC','CAD'),($2,'Sandbox B',false,'UTC','CAD')",[a.cafe,b.cafe]);
 await db.query("insert into public.memberships(business_id,user_id,role)"+
  " values($1,$2,'owner'),($3,$4,'owner')",[a.cafe,a.owner,b.cafe,b.owner]);
 await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)"+
  " values($1,$2,$3,$4),($5,$6,$7,$8)",
  [a.thread,a.cafe,a.owner,id(),b.thread,b.cafe,b.owner,id()]);
 await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','ml')",
 [a.ingredient,a.cafe]);
 await db.query("insert into public.ai_supplier_quotes"+
  " (id,business_id,owner_user_id,client_request_id,supplier_name,item_name,price_cents,"+
  " package_count,package_unit,source_kind,quoted_on,currency_code,ingredient_id,"+
  " valid_until,available_status,available_checked_at,delivery_on)"+
  " values($1,$2,$3,$4,'Farm A','Milk',450,1,'gal','supplier_quote',"+
  " $5::date,'CAD',$6,$7::date,'confirmed',$5::date,$8::date)",
 [a.quote,a.cafe,a.owner,id(),today,a.ingredient,until,delivery]);
 await db.query("insert into public.supervisor_proposals"+
  " (id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,"+
  " canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)"+
  " values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,"+
  " $6::jsonb,$7,'{}'::jsonb,'{\"durationDays\":1,\"metricScope\":\"supplier_purchase_order\"}'::jsonb,'en','executing',3)",
 [a.proposal,a.cafe,a.owner,a.thread,id(),JSON.stringify(effect),hash]);
 // Runtime RPCs execute under the service JWT only after the gateway claim.
 await db.query("SET LOCAL ROLE service_role");
 await db.query("select set_config(\'request.jwt.claim.role\',\'service_role\',true)");
 const invoke=(cafe=a.cafe,owner=a.owner,thread=a.thread,proposal=a.proposal)=>
  one("select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5) as result",
   [cafe,owner,thread,proposal,hash]);
 await fails(()=>invoke(),/gateway_attempt_missing/);
 await db.query("insert into public.supervisor_effect_attempts"+
  " (business_id,proposal_id,effect_hash,authorization_kind,business_date,state)"+
  " values($1,$2,$3,'click',$4,'executing')",[a.cafe,a.proposal,hash,today]);
 await fails(()=>invoke(b.cafe,b.owner,b.thread),/purchase_proposal_invalid/);
 // A natural owner correction retires the previous draft atomically.
 // Both proposals are persisted under the same authenticated café/thread.
 const oldDraft=id(),correctedDraft=id();
 const createDraft=pid=>db.query("insert into public.supervisor_proposals"+
  " (id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,"+
  " canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)"+
  " select $1,business_id,owner_user_id,thread_id,$2,capability_id,capability_version,"+
  " canonical_effect_payload,effect_hash,'{}'::jsonb,monitor_spec,locale,'draft',1"+
  " from public.supervisor_proposals where id=$3",[pid,id(),a.proposal]);
 await createDraft(oldDraft);await createDraft(correctedDraft);
 const supersede=()=>one("select public.supervisor_supersede_supplier_draft($1,$2,$3,$4,1,$5) as decision",
  [a.cafe,a.owner,a.thread,oldDraft,correctedDraft]);
 check((await supersede())?.decision==="superseded","owner correction is atomic");
 check((await supersede())?.decision==="superseded","replayed correction is idempotent");
 const drafts=await db.query("select id,status,baseline from public.supervisor_proposals where id=any($1::uuid[])",
  [[oldDraft,correctedDraft]]);
 check(drafts.rows.find(x=>x.id===oldDraft)?.status==="rejected"&&
  drafts.rows.find(x=>x.id===correctedDraft)?.status==="draft"&&
  drafts.rows.find(x=>x.id===correctedDraft)?.baseline.editedFrom===oldDraft,
  "old approval card is retired and follows the corrected draft");
 await fails(()=>asRole(a.owner,()=>supersede()),/permission denied|service_role_only/);
 const before=await one("select (select count(*)::int from public.pantry_stock_purchases where business_id=$1) as stock,"+
  " (select count(*)::int from public.expenses where business_id=$1) as expenses",[a.cafe]);
 const first=(await invoke())?.result;
 check(first?.status==="approved_for_ordering"&&first?.subtotalCents===450&&first?.currency==="CAD",
  "exact canonical approved PO result");
 const second=(await invoke())?.result;
 check(second?.orderId===first.orderId,"retry cannot duplicate approved PO");
 const saved=await one("select (select count(*)::int from public.purchase_orders where business_id=$1) as orders,"+
  " (select count(*)::int from public.purchase_order_lines where business_id=$1) as lines,"+
  " (select count(*)::int from public.purchase_order_events where business_id=$1) as events",[a.cafe]);
 check(saved.orders===1&&saved.lines===1&&saved.events===1,"one PO, line and immutable history");
 const after=await one("select (select count(*)::int from public.pantry_stock_purchases where business_id=$1) as stock,"+
  " (select count(*)::int from public.expenses where business_id=$1) as expenses",[a.cafe]);
 check(before.stock===after.stock&&before.expenses===after.expenses,
  "approval never books a stock receipt or an expense");
 check((await asRole(b.owner,()=>db.query("select id from public.purchase_orders where business_id=$1",[a.cafe]))).rows.length===0,
  "foreign café owner cannot see this PO");
 check((await asRole(a.owner,()=>db.query("select id from public.purchase_orders where business_id=$1",[a.cafe]))).rows.length===1,
  "correct owner can inspect PO");
 await fails(()=>asRole(a.owner,()=>invoke()),/permission denied|service_role_only/);
 await db.query("update public.supervisor_effect_attempts set state='uncertain' where business_id=$1 and proposal_id=$2",
 [a.cafe,a.proposal]);
 const recovered=await one("select status,revision from public.supervisor_reconcile_supplier_po($1,$2,$3,$4,3)",
 [a.cafe,a.owner,a.thread,a.proposal]);
 check(recovered?.status==="committed"&&recovered.revision===4,
  "uncertain receipt is reconciled from durable PO proof, no second write");
 check((await one("select count(*)::int as n from public.purchase_orders where business_id=$1",[a.cafe])).n===1,
  "reconciliation cannot duplicate order");
 check((await one("select receipt_ref like 'purchase_orders:%' as ok"+
  " from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",
  [a.cafe,a.proposal]))?.ok,"receipt links canonical purchase order");
 console.log("Task14B DB: "+count+" assertions passed");
}finally{try{await db.query("ROLLBACK");}catch{}await db.end().catch(()=>{});}
