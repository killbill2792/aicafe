import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
if(process.env.TASK14E_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
const a={business:randomUUID(),owner:randomUUID()},b={business:randomUUID(),owner:randomUUID()};
const one=async(sql,args=[])=>((await db.query(sql,args)).rows[0]??null);
const role=async(name,user="")=>{
 await db.query("SET LOCAL ROLE "+name);
 await db.query("select set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",[name,user]);
};
async function denied(fn){
 await db.query("SAVEPOINT finance_negative");
 try{await assert.rejects(fn);}finally{await db.query("ROLLBACK TO SAVEPOINT finance_negative");await db.query("RELEASE SAVEPOINT finance_negative");}
}
const capture="select public.supervisor_record_statement_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) id";
const rows=[{i:0,date:"2026-01-01",amountCents:-1000,balanceCents:9000},{i:1,date:"2026-01-02",amountCents:2000,balanceCents:11000}];
const args=[a.business,a.owner,"a".repeat(64),"b".repeat(64),"CAD","2026-01-01","2026-01-02",10000,11000,JSON.stringify(rows)];
try{
 await db.connect();await db.query("BEGIN");
 for(const x of [a,b]){
  await db.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[x.owner,x.owner+"@example.invalid"]);
  await db.query("insert into public.businesses(id,name,is_demo,timezone,currency) values($1,'Disposable finance',false,'UTC','CAD')",[x.business]);
  await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[x.business,x.owner]);
 }
 await role("service_role");
 const saved=await one(capture,args);assert.ok(saved.id);
 assert.equal((await one(capture,args)).id,saved.id,"idempotent source replay");
 await denied(()=>one(capture,[...args.slice(0,3),"c".repeat(64),...args.slice(4)]));
 await denied(()=>one(capture,[...args.slice(0,2),"d".repeat(64),...args.slice(3,8),99999,args[9]]));
 await denied(()=>one(capture,[b.business,...args.slice(1)]));
 const sync="select public.supervisor_sync_financial_review($1,$2,now()) n";
 assert.equal(Number((await one(sync,[a.business,a.owner])).n),1);
 assert.equal(Number((await one(sync,[a.business,a.owner])).n),0);
 assert.equal(Number((await one(sync,[b.business,b.owner])).n),0);
 await role("authenticated",a.owner);
 const read="select financial_closing_cents,financial_to from public.uploads where id=$1";
 assert.equal(Number((await one(read,[saved.id])).financial_closing_cents),11000);
 await denied(()=>one(capture,args));
 assert.equal((await db.query("update public.uploads set financial_closing_cents=123 where id=$1",[saved.id])).rowCount,0);
 assert.equal((await db.query("delete from public.uploads where id=$1",[saved.id])).rowCount,0);
 assert.equal((await db.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",[a.business,"financial-review:"+a.owner])).rowCount,0);
 await role("authenticated",b.owner);
 assert.equal(await one(read,[saved.id]),null);
 assert.equal(await one("select id from public.operating_tasks where business_id=$1 and id=$2",[a.business,"financial-review:"+a.owner]),null);
 await db.query("RESET ROLE");
 const supplier=randomUUID(),thread=randomUUID(),message=randomUUID();
 await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,'Local rent supplier')",[supplier,a.business]);
 await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[thread,a.business,a.owner,randomUUID()]);
 await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$4,'owner','text',$5,$6)",[message,a.business,thread,a.owner,"Owner supplied standalone rent invoice 2026-01-02, CAD 100.",randomUUID()]);
 const effect={purchaseOrderId:null,poRevision:null,standaloneSupplierName:"Local rent supplier",supplierId:supplier,supplierName:"Local rent supplier",
  invoiceReference:"standalone-rent",expectedInvoiceRevision:0,issuedOn:"2026-01-02",dueOn:null,currency:"CAD",subtotalCents:10000,
  taxCents:0,freightCents:0,discountCents:0,totalCents:10000,sourceKind:"owner_report",sourceRef:"owner-message:"+message,
  sourceSha256:"a".repeat(64),expenseDate:null,existingExpenseId:null,expenseDedupeKey:null,
  lines:[{sourceItemName:"Rent",orderLineId:null,ingredientId:null,baseUnit:null,quantityBase4:null,subtotalCents:10000}]};
 async function draftInvoice(e){
  await db.query("RESET ROLE");
  const id=randomUUID(),hash=createHash("sha256").update(JSON.stringify(e)).digest("hex");
  await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision) values($1,$2,$3,$4,$5,'maya.supplier_invoice.v1',1,$6::jsonb,$7,'{}'::jsonb,'{\"durationDays\":1,\"metricScope\":\"supplier_invoice\"}'::jsonb,'en','draft',1)",
   [id,a.business,a.owner,thread,randomUUID(),JSON.stringify(e),hash]);
  return {id,hash};
 }
 async function claimInvoice(p){
  await role("service_role");
  await one("select public.supervisor_transition_proposal($1,$2,$3,1,'approve',null)",[a.business,a.owner,p.id]);
  await one("select public.supervisor_claim_effect($1,$2,$3,$4,2,'click') value",[a.business,a.owner,thread,p.id]);
 }
 const commit="select public.supervisor_commit_supplier_invoice($1,$2,$3,$4) value";
 const commitArgs=p=>[a.business,thread,p.id,p.hash];
 const p=await draftInvoice(effect);
 await role("authenticated",a.owner);await denied(()=>one(commit,commitArgs(p)));
 await claimInvoice(p);
 await role("authenticated",b.owner);await denied(()=>one(commit,commitArgs(p)));
 await role("authenticated",a.owner);const invoice=(await one(commit,commitArgs(p))).value;
 assert.ok(invoice.invoiceId);assert.equal(invoice.purchaseOrderId,null);assert.equal(invoice.revision,1);
 assert.equal((await one(commit,commitArgs(p))).value.invoiceId,invoice.invoiceId);
 assert.equal((await one("select purchase_order_id,canonical_expense_id from public.supplier_invoices where business_id=$1 and id=$2",[a.business,invoice.invoiceId])).canonical_expense_id,null);
 assert.ok(await one("select id from public.supplier_invoice_lines where business_id=$1 and invoice_id=$2",[a.business,invoice.invoiceId]));
 await role("service_role");
 assert.equal((await one("select public.supervisor_supplier_invoice_effect_proof($1,$2,$3) id",[a.business,p.id,p.hash])).id,invoice.invoiceId);
 const duplicate=await draftInvoice(effect);await claimInvoice(duplicate);
 await role("authenticated",a.owner);await denied(()=>one(commit,commitArgs(duplicate)));
 const revised=await draftInvoice({...effect,expectedInvoiceRevision:1,totalCents:11000,subtotalCents:11000,lines:[{...effect.lines[0],subtotalCents:11000}]});
 await claimInvoice(revised);await role("authenticated",a.owner);
 const revision=(await one(commit,commitArgs(revised))).value;assert.equal(revision.revision,2);
 assert.equal(Number((await one("select total_cents from public.supplier_invoices where business_id=$1 and id=$2",[a.business,revision.invoiceId])).total_cents),11000);
 await role("authenticated",b.owner);assert.equal(await one("select id from public.supplier_invoices where business_id=$1 and id=$2",[a.business,revision.invoiceId]),null);
 await role("service_role");
 await db.query("delete from public.memberships where business_id=$1 and user_id=$2",[a.business,a.owner]);
 await denied(()=>one(capture,args));
 assert.equal(Number((await one("select count(*) n from public.expenses where business_id=$1",[a.business])).n),0);
 console.log("Task14E statement chain, standalone invoice gateway, idempotency, worker trigger and owner scope passed");
}finally{await db.query("ROLLBACK").catch(()=>{});await db.end();}
