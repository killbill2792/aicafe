/**
 * Task 14B real migrated Postgres acceptance. LOCAL disposable Supabase only.
 * TASK14B_DISPOSABLE_DB=1 node scripts/task14b-procurement-db.mjs
 * All fixture changes are rolled back, including the service gateway receipts.
 */
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";

if(process.env.TASK14B_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
 user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
const id={cafe:randomUUID(),otherCafe:randomUUID(),owner:randomUUID(),
 otherOwner:randomUUID(),thread:randomUUID(),ingredient:randomUUID(),
 quote:randomUUID(),proposal:randomUUID(),request:randomUUID(),attempt:randomUUID()};
let checks=0;
const check=(test,label)=>{assert.ok(test,label);checks++};
const iso=(shift=0)=>new Date(Date.now()+shift*86400000).toISOString().slice(0,10);
const currency="CAD"; // Disposable café fixture; runtime always reads businesses.currency.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?
 Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
 .map(([key,x])=>[key,canonical(x)])):value;
const fingerprint=effect=>createHash("sha256").update(JSON.stringify(canonical(effect))).digest("hex");
const one=async(sql,params=[])=>((await db.query(sql,params)).rows[0]??null);
async function asRole(role,user,fn){
 await db.query("SAVEPOINT task14b_role");
 try{
  await db.query("SET LOCAL ROLE "+role);
  await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);
  const value=await fn();
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14b_role");
  return value;
 }catch(error){
  await db.query("ROLLBACK TO SAVEPOINT task14b_role");
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14b_role");
  throw error;
 }
}
async function fails(fn,code,label){
 let actual=null;
 try{await fn()}catch(e){actual=e.code;}
 assert.equal(actual,code,label);checks++;
}
const args=(business=id.cafe,owner=id.owner,proposal=id.proposal,hash)=>[
 business,owner,id.thread,proposal,hash
];
const effect=Object.freeze({
 supplierName:"Farm A",currency,neededBy:iso(3),subtotalCents:2250,
 totalCents:null,shippingCents:null,taxCents:null,
 limitations:["owner_reported_not_supplier_verified","shipping_unknown","tax_unknown","landed_total_not_comparable"],
 lines:[{quoteId:id.quote,ingredientId:id.ingredient,itemName:"Milk",
  neededBaseQuantity:5*3785.411784,baseUnit:"ml",packs:5,
  packQuantity:1,packUnit:"gal",priceCents:450,lineSubtotalCents:2250,
  quotedOn:iso(-1),deliveryOn:iso(2)}],
});
const hash=fingerprint(effect);
try{
 await db.connect();
 await db.query("BEGIN");
 check((await one("select to_regprocedure('public.supervisor_commit_supplier_po(uuid,uuid,uuid,uuid,text)') is not null as present")).present,
  "Task14B migration creates the canonical owner-approval writer");
 check((await one("select to_regprocedure('public.supervisor_reconcile_supplier_po(uuid,uuid,uuid,uuid,integer)') is not null as present")).present,
  "Task14B migration creates receipt-only recovery");
 for(const table of ["cafe_suppliers","purchase_orders","purchase_order_lines","purchase_order_events"]){
  check((await one("select relrowsecurity as enabled from pg_class where oid=$1::regclass",["public."+table])).enabled,
   table+" is covered by row-level security");
 }
 await db.query(\`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14b-owner@example.invalid','',now(),now()),
 ($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14b-other@example.invalid','',now(),now())\`,
 [id.owner,id.otherOwner]);
 await db.query("insert into public.businesses(id,name,is_demo,timezone,currency) values($1,'Task14B Local A',false,'UTC',$3),($2,'Task14B Local B',false,'UTC',$3)",
 [id.cafe,id.otherCafe,currency]);
 await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
 [id.cafe,id.owner,id.otherCafe,id.otherOwner]);
 await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
 [id.thread,id.cafe,id.owner,randomUUID()]);
 await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','ml')",
 [id.ingredient,id.cafe]);
 await db.query(\`insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,
 supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,
 quoted_on,currency_code,valid_until,available_status,available_checked_at,delivery_on)
 values($1,$2,$3,$4,'Farm A','Milk',$5,450,1,'gal','supplier_quote',
 $6,$7,$8,'confirmed',$9,$10)\`,
 [id.quote,id.cafe,id.owner,randomUUID(),id.ingredient,iso(-1),currency,iso(7),iso(-1),iso(2)]);
 await db.query(\`insert into public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
 canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
 values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,$6::jsonb,$7,
 '{}'::jsonb,'{"durationDays":1,"metricScope":"supplier_purchase_order"}'::jsonb,
 'en','executing',3)\`,
 [id.proposal,id.cafe,id.owner,id.thread,id.request,JSON.stringify(effect),hash]);
 const fullArgs=args(id.cafe,id.owner,id.proposal,hash);
 const before=await one("select count(*)::int as n from public.pantry_stock_purchases where business_id=$1",[id.cafe]);
 const bills=await one("select count(*)::int as n from public.expenses where business_id=$1",[id.cafe]);
 await fails(()=>asRole("authenticated",id.owner,()=>
   db.query("select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5)",fullArgs)),
  "42501","Authenticated owner cannot call service-only PO writer");
 await fails(()=>asRole("service_role",id.owner,()=>
   db.query("select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5)",fullArgs)),
  "42501","Even service role cannot write before a gateway click attempt");
 check((await one("select count(*)::int as n from public.purchase_orders where business_id=$1",[id.cafe])).n===0,
  "Unauthorized calls did not create a PO");
 await db.query(\`insert into public.supervisor_approvals(
 business_id,proposal_id,owner_user_id,approved_revision,effect_hash,authorization_kind)
 values($1,$2,$3,1,$4,'click')\`,[id.cafe,id.proposal,id.owner,hash]);
 await db.query(\`insert into public.supervisor_effect_attempts(
 attempt_key,business_id,proposal_id,effect_hash,authorization_kind,business_date,state,created_at)
 values($1,$2,$3,$4,'click',$5,'executing',now()-interval '6 minutes')\`,
 [id.attempt,id.cafe,id.proposal,hash,iso()]);
 await fails(()=>asRole("service_role",id.otherOwner,()=>
   db.query("select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5)",
   args(id.otherCafe,id.otherOwner,id.proposal,hash))),
  "42501","Foreign café owner cannot forge an approval");
 const first=await asRole("service_role",id.owner,()=>one(
  "select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5) as receipt",fullArgs));
 check(first.receipt.status==="approved_for_ordering"&&first.receipt.subtotalCents===2250&&
  first.receipt.currency===currency,"Approved PO returns the scoped verified immutable subtotal receipt");
 const repeated=await asRole("service_role",id.owner,()=>one(
  "select public.supervisor_commit_supplier_po($1,$2,$3,$4,$5) as receipt",fullArgs));
 check(repeated.receipt.orderId===first.receipt.orderId,"Repeated gateway receipt cannot double-create order");
 check((await one("select count(*)::int as n from public.purchase_orders where business_id=$1",[id.cafe])).n===1,
  "Exactly one PO despite repeated attempts");
 check((await one("select count(*)::int as n from public.purchase_order_lines where business_id=$1",[id.cafe])).n===1,
  "Exactly one itemized PO line");
 check((await one("select count(*)::int as n from public.purchase_order_events where business_id=$1",[id.cafe])).n===1,
  "One durable approval event, not append-per-retry");
 check((await one("select count(*)::int as n from public.pantry_stock_purchases where business_id=$1",[id.cafe])).n===before.n &&
  (await one("select count(*)::int as n from public.expenses where business_id=$1",[id.cafe])).n===bills.n,
  "Approval did NOT increment inventory or book a bill");
 const otherOrders=await asRole("authenticated",id.otherOwner,()=>db.query(
  "select id from public.purchase_orders where business_id=$1",[id.cafe]));
 check(otherOrders.rows.length===0,"Other café RLS cannot enumerate orders");
 const ownerOrders=await asRole("authenticated",id.owner,()=>db.query(
  "select id,subtotal_cents from public.purchase_orders where business_id=$1",[id.cafe]));
 check(ownerOrders.rows.length===1&&ownerOrders.rows[0].id===first.receipt.orderId,
  "Owner can see the persisted, scoped PO");
 await asRole("service_role",id.owner,()=>one(
  "select public.supervisor_reconcile_supplier_po($1,$2,$3,$4,$5) as completed",
  [id.cafe,id.owner,id.thread,id.proposal,3]));
 const reconciled=await one("select status,revision from public.supervisor_proposals where id=$1",[id.proposal]);
 check(reconciled.status==="committed"&&reconciled.revision===4,
  "Recovery promotes only after durable PO postcondition is verified");
 const receipt=await one("select state,receipt_ref from public.supervisor_effect_attempts where attempt_key=$1",[id.attempt]);
 check(receipt.state==="verified"&&receipt.receipt_ref==="purchase_orders:"+first.receipt.orderId,
  "Gateway receipt is bound to the precise saved PO");
 await fails(()=>asRole("authenticated",id.owner,()=>db.query(
  "insert into public.purchase_orders(business_id,owner_user_id,supplier_id,supplier_name_snapshot,proposal_id,effect_hash,currency_code,subtotal_cents) values($1,$2,$3,'Forged',$4,$5,$6,1)",
  [id.cafe,id.owner,randomUUID(),id.proposal,hash,currency])),
  "42501","Authenticated owner cannot write a forged PO");
 console.log("Task 14B migrated procurement DB: "+checks+" assertions passed");
} finally {
 try{await db.query("ROLLBACK")}catch{}
 await db.end().catch(()=>{});
}
