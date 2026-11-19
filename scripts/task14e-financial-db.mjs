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
 async function draftInvoice(e,capability='maya.supplier_invoice.v1'){
  await db.query("RESET ROLE");
  const id=randomUUID(),hash=createHash("sha256").update(JSON.stringify(e)).digest("hex");
  await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision) values($1,$2,$3,$4,$5,$8,1,$6::jsonb,$7,'{}'::jsonb,'{\"durationDays\":1,\"metricScope\":\"supplier_invoice\"}'::jsonb,'en','draft',1)",
   [id,a.business,a.owner,thread,randomUUID(),JSON.stringify(e),hash,capability]);
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
 // Documentary settlement uses the same owner-click proposal/attempt, not direct DB mutation.
 const effectSettlement={financialKind:"settlement_evidence_linked",invoiceId:revision.invoiceId,invoiceRevision:2,
  supplierId:supplier,supplierName:"Local rent supplier",invoiceReference:"standalone-rent",invoiceTotalCents:11000,
  uploadId:saved.id,rowIndex:0,allocationCents:600,reversesId:null,currency:"CAD",sourceHash:args[2],accountKey:args[3],
  transactionDate:rows[0].date,transactionAmountCents:rows[0].amountCents,transactionBalanceCents:rows[0].balanceCents};
 const settlement="select public.supervisor_commit_financial_settlement($1,$2,$3,$4) id";
 const settlementProof="select public.supervisor_financial_settlement_proof($1,$2,$3) id";
 const draftSettlement=e=>draftInvoice(e,"leo.financial_settlement.v1");
 const link=await draftSettlement(effectSettlement);
 await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(link)));
 await role("service_role");
 await denied(()=>one("select public.supervisor_claim_effect($1,$2,$3,$4,1,'mandate')",[a.business,a.owner,thread,link.id]));
 await claimInvoice(link);await role("authenticated",b.owner);await denied(()=>one(settlement,commitArgs(link)));
 await role("authenticated",a.owner);const first=(await one(settlement,commitArgs(link))).id;
 assert.ok(first);assert.equal((await one(settlement,commitArgs(link))).id,first);
 await role("service_role");assert.equal((await one(settlementProof,[a.business,link.id,link.hash])).id,first);
 const attempt=(await one("select attempt_key from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",[a.business,link.id]));
 const proposal=(await one("select revision from public.supervisor_proposals where business_id=$1 and id=$2",[a.business,link.id]));
 await one("select public.supervisor_finish_effect_attempt($1,$2,$3,$4,$5,$6,'uncertain',null,null)",[a.business,a.owner,thread,link.id,attempt.attempt_key,proposal.revision]);
 assert.equal((await one("select to_jsonb(public.supervisor_reconcile_supplier_receiving($1,$2,$3,$4,$5)) p",[a.business,a.owner,thread,link.id,proposal.revision])).p.status,"committed");
 const over=await draftSettlement({...effectSettlement,allocationCents:500});
 await claimInvoice(over);await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(over)));
 const second=await draftSettlement({...effectSettlement,allocationCents:400});
 await claimInvoice(second);await role("authenticated",a.owner);assert.ok((await one(settlement,commitArgs(second))).id);
 await role("service_role");
 const repeated=(await one(capture,[...args.slice(0,2),"e".repeat(64),"f".repeat(64),...args.slice(4)])).id;
 const overlapping=await draftSettlement({...effectSettlement,uploadId:repeated,sourceHash:"e".repeat(64),accountKey:"f".repeat(64),allocationCents:1});
 await claimInvoice(overlapping);await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(overlapping)));
 const reversal={...effectSettlement,financialKind:"settlement_evidence_reversed",rowIndex:1,allocationCents:300,reversesId:first,
  transactionDate:rows[1].date,transactionAmountCents:rows[1].amountCents,transactionBalanceCents:rows[1].balanceCents};
 const rev=await draftSettlement(reversal);
 await claimInvoice(rev);await role("authenticated",a.owner);assert.ok((await one(settlement,commitArgs(rev))).id);
 const excessiveReversal=await draftSettlement({...reversal,allocationCents:301});
 await claimInvoice(excessiveReversal);await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(excessiveReversal)));
 const totals=await one("select sum(case when financial_kind='settlement_evidence_linked' then financial_allocation_cents else -financial_allocation_cents end) n,count(*) as count from public.purchase_reconciliation_events where business_id=$1 and financial_invoice_id=$2",[a.business,revision.invoiceId]);
 assert.equal(Number(totals.n),700);assert.equal(Number(totals.count),3);
 await role("authenticated",b.owner);assert.equal(await one("select id from public.purchase_reconciliation_events where id=$1",[first]),null);
 // A new revision must not inherit old evidence or allocate another posting over it.
 const newRevision=await draftInvoice({...effect,expectedInvoiceRevision:2,totalCents:12000,subtotalCents:12000,lines:[{...effect.lines[0],subtotalCents:12000}]});
 await claimInvoice(newRevision);await role("authenticated",a.owner);const newInvoice=(await one(commit,commitArgs(newRevision))).value;
 const staleLink=await draftSettlement({...effectSettlement,allocationCents:1});
 await claimInvoice(staleLink);await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(staleLink)));
 await role("service_role");
 const newSourceRows=[{i:0,date:"2026-01-03",amountCents:-500,balanceCents:10500},{i:1,date:"2026-01-04",amountCents:1,balanceCents:10501}];
 const newSource=(await one(capture,[a.business,a.owner,"9".repeat(64),args[3],"CAD","2026-01-03","2026-01-04",11000,10501,JSON.stringify(newSourceRows)])).id;
 const changed=await draftSettlement({...effectSettlement,invoiceId:newInvoice.invoiceId,invoiceRevision:3,invoiceTotalCents:12000,uploadId:newSource,sourceHash:"9".repeat(64),
  allocationCents:500,transactionDate:"2026-01-03",transactionAmountCents:-500,transactionBalanceCents:10500});
 await claimInvoice(changed);await role("authenticated",a.owner);await denied(()=>one(settlement,commitArgs(changed)));
 const billEffect={payee:"municipality",reference:"tax-2026",expectedRevision:0,issuedOn:"2026-01-01",dueOn:"2026-02-01",
  amountCents:4200,currency:"CAD",sourceKind:"owner_report",sourceRef:"owner-message:"+message,sourceSha256:"7".repeat(64)};
 const billCommit="select public.supervisor_commit_financial_bill($1,$2,$3,$4) id";
 const bill=await draftInvoice(billEffect,"leo.financial_bill.v1");
 await role("authenticated",a.owner);await denied(()=>one(billCommit,commitArgs(bill)));
 await claimInvoice(bill);await role("authenticated",b.owner);await denied(()=>one(billCommit,commitArgs(bill)));
 await role("authenticated",a.owner);const billId=(await one(billCommit,commitArgs(bill))).id;assert.ok(billId);
 assert.equal((await one(billCommit,commitArgs(bill))).id,billId);
 assert.equal(Number((await one("select financial_bill_amount_cents from public.uploads where id=$1",[billId])).financial_bill_amount_cents),4200);
 await role("service_role");assert.equal((await one("select public.supervisor_financial_bill_proof($1,$2,$3) id",[a.business,bill.id,bill.hash])).id,billId);
 const billDuplicate=await draftInvoice(billEffect,"leo.financial_bill.v1");
 await claimInvoice(billDuplicate);await role("authenticated",a.owner);await denied(()=>one(billCommit,commitArgs(billDuplicate)));
 await role("authenticated",b.owner);assert.equal(await one("select id from public.uploads where id=$1",[billId]),null);
 await role("service_role");
 // Independently verified full coverage closes the exact current invoice; a credit reopens it.
 const closedEffect={...effect,invoiceReference:"closure-check",expectedInvoiceRevision:0,totalCents:1000,subtotalCents:1000,lines:[{...effect.lines[0],subtotalCents:1000}]};
 const closeInvoice=await draftInvoice(closedEffect);await claimInvoice(closeInvoice);
 await role("authenticated",a.owner);const closureInvoice=(await one(commit,commitArgs(closeInvoice))).value;
 await role("service_role");
 const closureRows=[{i:0,date:"2026-02-01",amountCents:-1000,balanceCents:8000},{i:1,date:"2026-02-02",amountCents:200,balanceCents:8200}];
 const closureUpload=(await one(capture,[a.business,a.owner,"6".repeat(64),args[3],"CAD","2026-02-01","2026-02-02",9000,8200,JSON.stringify(closureRows)])).id;
 const closureLink={...effectSettlement,invoiceId:closureInvoice.invoiceId,invoiceRevision:1,invoiceReference:"closure-check",invoiceTotalCents:1000,uploadId:closureUpload,sourceHash:"6".repeat(64),allocationCents:1000,transactionDate:closureRows[0].date,transactionAmountCents:-1000,transactionBalanceCents:8000};
 const closureProposal=await draftSettlement(closureLink);await claimInvoice(closureProposal);
 await role("authenticated",a.owner);const closureEvent=(await one(settlement,commitArgs(closureProposal))).id;
 await role("service_role");
 async function verifyReceipt(proposal){
  const attempt=await one("select attempt_key from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",[a.business,proposal.id]);
  const current=await one("select revision from public.supervisor_proposals where business_id=$1 and id=$2",[a.business,proposal.id]);
  await one("select public.supervisor_finish_effect_attempt($1,$2,$3,$4,$5,$6,'uncertain',null,null)",[a.business,a.owner,thread,proposal.id,attempt.attempt_key,current.revision]);
  assert.equal((await one("select to_jsonb(public.supervisor_reconcile_supplier_receiving($1,$2,$3,$4,$5)) p",[a.business,a.owner,thread,proposal.id,current.revision])).p.status,"committed");
 }
 const closureTask=()=>one("select status,resolved_at from public.operating_tasks where business_id=$1 and entity_type='supplier_invoice' and entity_id=$2",[a.business,closureInvoice.invoiceId]);
 await one(sync,[a.business,a.owner]);assert.equal((await closureTask()).status,"watching");
 await verifyReceipt(closureProposal);await one(sync,[a.business,a.owner]);
 assert.equal((await closureTask()).status,"handled");assert.ok((await closureTask()).resolved_at);
 const reopen=await draftSettlement({...closureLink,financialKind:"settlement_evidence_reversed",rowIndex:1,allocationCents:200,reversesId:closureEvent,transactionDate:closureRows[1].date,transactionAmountCents:200,transactionBalanceCents:8200});
 await claimInvoice(reopen);await role("authenticated",a.owner);assert.ok((await one(settlement,commitArgs(reopen))).id);
 await role("service_role");await verifyReceipt(reopen);await one(sync,[a.business,a.owner]);
 assert.equal((await closureTask()).status,"watching");assert.equal((await closureTask()).resolved_at,null);
 assert.equal((await one("select status from public.operating_tasks where business_id=$1 and id=$2",[a.business,"financial-review:"+a.owner])).status,"watching");
 await db.query("delete from public.memberships where business_id=$1 and user_id=$2",[a.business,a.owner]);
 await denied(()=>one(capture,args));
 assert.equal(Number((await one("select count(*) n from public.expenses where business_id=$1",[a.business])).n),0);
 console.log("Task14E statement chain, standalone invoice and documentary settlement/reversal gateway, recovery, worker trigger and owner scope passed");
}finally{await db.query("ROLLBACK").catch(()=>{});await db.end();}
