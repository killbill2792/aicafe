/** Disposable migrated schema/RLS and actual receiving gateway effects. */
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
if(process.env.TASK14D_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
 user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
const uid=()=>randomUUID();
const a={business:uid(),owner:uid(),thread:uid(),proposal:uid(),supplier:uid(),ingredient:uid(),quote:uid(),po:uid(),line:uid()};
const b={business:uid(),owner:uid(),thread:uid(),proposal:uid(),supplier:uid(),ingredient:uid(),quote:uid(),po:uid(),line:uid()};
const hash="a".repeat(64);
const tables=["purchase_receipts","purchase_receipt_lines","supplier_invoices","supplier_invoice_lines","purchase_reconciliation_events"];
let count=0;
const check=(value,label)=>{assert.ok(value,label);count++;};
const one=async(sql,args=[])=>((await db.query(sql,args)).rows[0]??null);
async function attempt(fn,expectedError=null,role=null,user=null){
 await db.query("SAVEPOINT task14d_attempt");
 try{
  if(role){await db.query("SET LOCAL ROLE "+role);
   await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
   await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);}
  const result=await fn();
  await db.query("ROLLBACK TO SAVEPOINT task14d_attempt");
  await db.query("RELEASE SAVEPOINT task14d_attempt");
  if(expectedError)throw Error("Expected SQL rejection "+expectedError);
  return result;
 }catch(err){
  // An unexpected JavaScript assertion after release must remain a failure.
  if(!err.code)throw err;
  await db.query("ROLLBACK TO SAVEPOINT task14d_attempt");
  await db.query("RELEASE SAVEPOINT task14d_attempt");
  assert.equal(err.code,expectedError);
  count++;
 }
}
async function seed(x){
 await db.query(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())`,
 [x.owner,x.owner+"@example.invalid"]);
 await db.query("insert into public.businesses(id,name,is_demo,timezone,currency) values($1,'Task14D Local',false,'UTC','CAD')",[x.business]);
 await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[x.business,x.owner]);
 await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[x.thread,x.business,x.owner,uid()]);
 await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,'Local Dairy')",[x.supplier,x.business]);
 await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','ml')",[x.ingredient,x.business]);
 await db.query(`insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,
 supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,quoted_on,currency_code)
 values($1,$2,$3,$4,'Local Dairy','Milk',$5,2000,10,'liter','supplier_quote',current_date,'CAD')`,
 [x.quote,x.business,x.owner,uid(),x.ingredient]);
 await db.query(`insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
 values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,'{}'::jsonb,$6,'{}'::jsonb,
 '{"durationDays":1,"metricScope":"supplier_purchase_order"}'::jsonb,'en','committed',4)`,
 [x.proposal,x.business,x.owner,x.thread,uid(),hash]);
 await db.query(`insert into public.purchase_orders(id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,
 proposal_id,effect_hash,status,revision,currency_code,subtotal_cents,needed_by)
 values($1,$2,$3,$4,'Local Dairy',$5,$6,'approved_for_ordering',1,'CAD',20000,current_date)`,
 [x.po,x.business,x.owner,x.supplier,x.proposal,hash]);
 await db.query(`insert into public.purchase_order_lines(id,business_id,purchase_order_id,quote_id,ingredient_id,
 ordinal,item_name_snapshot,needed_base_quantity,base_unit,packs,pack_quantity,pack_unit,unit_price_cents,
 subtotal_cents,quoted_on) values($1,$2,$3,$4,$5,1,'Milk',100000,'ml',10,10,'liter',2000,20000,current_date)`,
 [x.line,x.business,x.po,x.quote,x.ingredient]);
}
const receiptSQL=`insert into public.purchase_receipts(id,business_id,purchase_order_id,supplier_id,owner_user_id,
 receiving_reference,revision,received_on,source_ref,source_sha256,verification_kind,verification_ref,verified_at)
 values($1,$2,$3,$4,$5,$6,$7,current_date,'local-test-source',$8,$9,'local-test-confirmation',now())`;
const receiptArgs=(x,id,ref,rev=1,kind="owner_confirmed")=>[id,x.business,x.po,x.supplier,x.owner,ref,rev,hash,kind];
const lineSQL=`insert into public.purchase_receipt_lines(business_id,purchase_order_id,receipt_id,source_line_key,
 order_line_id,ingredient_id,source_item_name,received_base4,accepted_base4,damaged_base4)
 values($1,$2,$3,$4,$5,$6,'Milk',$7,$8,$9)`;
const invoiceSQL=`insert into public.supplier_invoices(id,business_id,purchase_order_id,supplier_id,owner_user_id,
 invoice_reference,revision,issued_on,currency_code,subtotal_cents,tax_cents,freight_cents,discount_cents,total_cents,
 source_ref,source_sha256,identity_verification_ref)
 values($1,$2,$3,$4,$5,$6,$7,current_date,'CAD',20000,0,0,0,20000,'local-invoice',$8,'local-identity')`;
const invoiceArgs=(x,id,ref,rev=1)=>[id,x.business,x.po,x.supplier,x.owner,ref,rev,hash];
try{
 await db.connect();await db.query("BEGIN");
 for(const table of tables){
  check((await one("select relrowsecurity enabled from pg_class where oid=$1::regclass",["public."+table])).enabled,table+" RLS");
  for(const role of ["anon","authenticated","service_role"]){
   for(const privilege of ["INSERT","UPDATE","DELETE"])check(!(await one(
    "select has_table_privilege($1,$2,$3) allowed",[role,"public."+table,privilege])).allowed,
    role+" cannot directly "+privilege+" "+table);
  }
 }
 await seed(a);await seed(b);
 const receipt=uid(),invoice=uid();
 await db.query(receiptSQL,receiptArgs(a,receipt,"delivery-1"));
 await db.query(lineSQL,[a.business,a.po,receipt,"1",a.line,a.ingredient,600000000,600000000,0]);
 await db.query(invoiceSQL,invoiceArgs(a,invoice,"inv-1"));
 await db.query(`insert into public.supplier_invoice_lines(business_id,purchase_order_id,invoice_id,
 source_line_key,order_line_id,ingredient_id,source_item_name,quantity_base4,subtotal_cents)
 values($1,$2,$3,'1',$4,$5,'Milk',1000000000,20000)`,[a.business,a.po,invoice,a.line,a.ingredient]);
 await db.query(`insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
 event_key,event_kind,source_ref,source_revision) values($1,$2,$3,$4,'e1','evidence_observed','local-test',1)`,
 [a.business,a.po,a.supplier,a.owner]);
 for(const table of tables){
  const own=await attempt(()=>db.query("select id from public."+table+" where business_id=$1",[a.business]),null,"authenticated",a.owner);
  check(own.rows.length===1,"owner sees own "+table);
  const foreign=await attempt(()=>db.query("select id from public."+table+" where business_id=$1",[a.business]),null,"authenticated",b.owner);
  check(foreign.rows.length===0,"other café cannot see "+table);
 }
 await attempt(()=>db.query(receiptSQL,receiptArgs(a,uid(),"delivery-1")),"23505");
 await attempt(()=>db.query(invoiceSQL,invoiceArgs(a,uid(),"inv-1")),"23505");
 await attempt(()=>db.query(receiptSQL,receiptArgs(a,uid(),"supplier-email",1,"supplier_email")),"23514");
 await attempt(()=>db.query(receiptSQL,receiptArgs({...a,supplier:b.supplier},uid(),"wrong-supplier")),"23503");
 await attempt(()=>db.query(lineSQL,[a.business,a.po,receipt,"2",b.line,b.ingredient,10,10,0]),"23503");
 await attempt(()=>db.query(lineSQL,[a.business,a.po,receipt,"2",a.line,a.ingredient,10,10,5]),"23514");
 await db.query(receiptSQL,receiptArgs(a,uid(),"delivery-1",2));
 await db.query(receiptSQL,receiptArgs(a,uid(),"delivery-2"));
 await db.query(invoiceSQL,invoiceArgs(a,uid(),"inv-1",2));
 check(Number((await one("select count(*) n from public.purchase_receipts where business_id=$1",[a.business])).n)===3,"installments and historical revisions retained");
 check(Number((await one("select count(*) n from public.supplier_invoices where business_id=$1",[a.business])).n)===2,"invoice corrections retained");
 for(const table of ["pantry_stock_purchases","expenses"])check(Number((await one("select count(*) n from public."+table+" where business_id=$1",[a.business])).n)===0,"source-only fixture never writes "+table);
 // Existing routine projection is durable and idempotent, not a new queue.
 await db.query("SET LOCAL ROLE service_role");
 await db.query("select set_config('request.jwt.claim.role','service_role',true)");
 const sync="select public.supervisor_sync_supplier_receiving_tasks($1,$2,now()) n";
 check(Number((await one(sync,[a.business,a.owner])).n)===1,"new document evidence creates a durable operating task");
 check(Number((await one(sync,[a.business,a.owner])).n)===0,"unchanged replay creates no duplicate task");
 check(Number((await one(sync,[b.business,b.owner])).n)===0,"internal PO without order or receipt evidence does not imply delivery");
 await db.query("RESET ROLE");
 const task=await one("select id,status,owner_user_id from public.operating_tasks where business_id=$1 and kind='supplier_receiving'",[a.business]);
 check(task.id==="supplier-receiving:"+a.po&&task.status==="watching"&&task.owner_user_id===a.owner,"one exact owner-scoped source task");
 const close=await attempt(()=>db.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2 returning id",[a.business,task.id]),null,"authenticated",a.owner);
 check(close.rows.length===0,"generic inbox cannot falsely close receiving discrepancy");
 await attempt(()=>db.query(sync,[a.business,a.owner]),"42501","authenticated",a.owner);

 // Exercise actual click approval and the canonical receiving effect, not
 // database fixture inserts. Successful role-scoped calls retain writes.
 async function asRoleKeep(role,user,fn){
  await db.query("SAVEPOINT task14d_keep");
  try{
   await db.query("SET LOCAL ROLE "+role);
   await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
   await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);
   const result=await fn();
   await db.query("RESET ROLE");
   await db.query("select set_config('request.jwt.claim.role','',true),set_config('request.jwt.claim.sub','',true)");
   await db.query("RELEASE SAVEPOINT task14d_keep");return result;
  }catch(e){await db.query("ROLLBACK TO SAVEPOINT task14d_keep");await db.query("RELEASE SAVEPOINT task14d_keep");throw e;}
 }
 const service=fn=>asRoleKeep("service_role",null,fn);
 const owner=fn=>asRoleKeep("authenticated",b.owner,fn);
 const date=(await one("select current_date::text d")).d;
 async function draft(capability,effect){
  const id=uid(),effectHash=createHash("sha256").update(JSON.stringify(effect)).digest("hex");
  await db.query(`insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
   capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision)
   values($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8,'{}'::jsonb,'{"durationDays":1,"metricScope":"supplier_purchase_order"}'::jsonb,'en','draft',1)`,
   [id,b.business,b.owner,b.thread,uid(),capability,JSON.stringify(effect),effectHash]);
  return {id,effectHash};
 }
 async function claim(p){
  await service(()=>one("select public.supervisor_transition_proposal($1,$2,$3,1,'approve',null)",[b.business,b.owner,p.id]));
  return (await service(()=>one("select public.supervisor_claim_effect($1,$2,$3,$4,2,'click') value",[b.business,b.owner,b.thread,p.id]))).value;
 }
 const receive="select public.supervisor_commit_supplier_receiving($1,$2,$3,$4) value";
 const receiveArgs=p=>[b.business,b.thread,p.id,p.effectHash];
 const effect=(reference,revision,quantity)=>({purchaseOrderId:b.po,poRevision:1,supplierId:b.supplier,receivingReference:reference,
  expectedReceiptRevision:revision,receivedOn:date,lines:[{orderLineId:b.line,ingredientId:b.ingredient,baseUnit:"ml",
   receivedBase4:quantity,acceptedBase4:quantity,damagedBase4:0}]});
 const first=await draft("maya.supplier_receiving.v1",effect("live-a",0,600000000));
 await attempt(()=>one(receive,receiveArgs(first)),"42501","authenticated",b.owner);
 const c1=await claim(first);
 await attempt(()=>one(receive,receiveArgs(first)),"42501","authenticated",a.owner);
 const receipt1=(await owner(()=>one(receive,receiveArgs(first)))).value;
 check(receipt1.revision===1,"actual approved physical receiving");
 check((await owner(()=>one(receive,receiveArgs(first)))).value.receiptId===receipt1.receiptId,"identical retry does not create another receipt");
 const qty=async()=>Number((await one("select coalesce(sum(quantity_base),0) n from public.pantry_stock_purchases where business_id=$1 and voided_at is null",[b.business])).n);
 check(await qty()===60000,"actual canonical partial stock increment");
 const proof=await service(()=>one("select public.supervisor_supplier_receiving_effect_proof($1,$2,$3) id",[b.business,first.id,first.effectHash]));
 check(proof.id===receipt1.receiptId,"independent canonical receipt readback");
 await service(()=>one("select public.supervisor_finish_effect_attempt($1,$2,$3,$4,$5,$6,'uncertain',null,null)",
  [b.business,b.owner,b.thread,first.id,c1.attempt_key,c1.proposal.revision]));
 const recovered=await service(()=>one("select to_jsonb(public.supervisor_reconcile_supplier_receiving($1,$2,$3,$4,$5)) value",
  [b.business,b.owner,b.thread,first.id,c1.proposal.revision]));
 check(recovered.value.status==="committed"&&await qty()===60000,"uncertain outcome recovered from readback without a replay");
 const duplicate=await draft("maya.supplier_receiving.v1",effect("live-a",0,600000000));
 await claim(duplicate);await attempt(()=>one(receive,receiveArgs(duplicate)),"P0001","authenticated",b.owner);
 check(await qty()===60000,"duplicate semantic receipt rejected");
 const second=await draft("maya.supplier_receiving.v1",effect("live-b",0,400000000));
 await claim(second);await owner(()=>one(receive,receiveArgs(second)));
 check(await qty()===100000,"distinct installment increments stock exactly once");
 const corrected=await draft("maya.supplier_receiving.v1",effect("live-a",1,500000000));
 await claim(corrected);await owner(()=>one(receive,receiveArgs(corrected)));
 check(await qty()===90000,"correction replaces old stock quantity rather than adding it");
 check(Number((await one("select count(*) n from public.expenses where business_id=$1",[b.business])).n)===0,"receiving does not invent an expense");

 const messageId=uid();
 await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$4,'owner','text',$5,$6)",
  [messageId,b.business,b.thread,b.owner,"Confirm invoice live-inv, CAD 200.00, 100 litres of milk.",uid()]);
 const invoiceEffect=(revision,total,recognize)=>({purchaseOrderId:b.po,poRevision:1,supplierId:b.supplier,
  invoiceReference:"live-inv",expectedInvoiceRevision:revision,issuedOn:date,dueOn:null,currency:"CAD",
  subtotalCents:total,taxCents:0,freightCents:0,discountCents:0,totalCents:total,
  sourceKind:"owner_report",sourceRef:"owner-message:"+messageId,sourceSha256:hash,
  expenseDate:recognize?date:null,existingExpenseId:null,expenseDedupeKey:recognize?
   createHash("sha256").update(b.business+"|"+date+"|"+total+"|local dairy").digest("hex"):null,
  lines:[{orderLineId:b.line,ingredientId:b.ingredient,baseUnit:"ml",sourceItemName:"Milk",quantityBase4:1000000000,subtotalCents:total}]});
 const invoiceCommit="select public.supervisor_commit_supplier_invoice($1,$2,$3,$4) value";
 const bill=await draft("maya.supplier_invoice.v1",invoiceEffect(0,20000,false));
 await attempt(()=>one(invoiceCommit,receiveArgs(bill)),"42501","authenticated",b.owner);
 await claim(bill);
 const bill1=(await owner(()=>one(invoiceCommit,receiveArgs(bill)))).value;
 check(bill1.revision===1&&await qty()===90000,"invoice evidence does not move stock");
 check(Number((await one("select count(*) n from public.expenses where business_id=$1",[b.business])).n)===0,"documentary invoice alone does not recognize an expense");
 const recognize=await draft("maya.supplier_invoice.v1",invoiceEffect(1,20000,true));
 await claim(recognize);const bill2=(await owner(()=>one(invoiceCommit,receiveArgs(recognize)))).value;
 const invoiceProof=await service(()=>one("select public.supervisor_supplier_invoice_effect_proof($1,$2,$3) id",
  [b.business,recognize.id,recognize.effectHash]));
 check(invoiceProof.id===bill2.invoiceId,"explicitly approved expense has canonical invoice proof");
 const expense=await one("select id,amount_cents,status from public.expenses where business_id=$1",[b.business]);
 check(Number(expense.amount_cents)===20000&&expense.status==="actual","recognized actual expense uses canonical expenses");
 const invoiceCorrection=await draft("maya.supplier_invoice.v1",invoiceEffect(2,21000,true));
 await claim(invoiceCorrection);await owner(()=>one(invoiceCommit,receiveArgs(invoiceCorrection)));
 const expenses=await db.query("select id,amount_cents from public.expenses where business_id=$1",[b.business]);
 check(expenses.rows.length===1&&expenses.rows[0].id===expense.id&&Number(expenses.rows[0].amount_cents)===21000,
  "revised invoice corrects the same expense rather than adding a duplicate");
 check(await qty()===90000,"invoice recognition and revision never change Pantry");

 // Same Gmail gateway, separate discrepancy reservation. No provider traffic.
 const contactId=uid(),accountId=uid(),email="orders@receiving.example.invalid",mailbox="owner@receiving.example.invalid";
 await db.query("insert into public.cafe_supplier_order_contacts(id,business_id,supplier_id,owner_user_id,channel,email,verified_at) values($1,$2,$3,$4,'gmail',$5,now())",
  [contactId,b.business,b.supplier,b.owner,email]);
 await db.query("insert into public.connector_accounts(id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,enabled_operations,status,generation) values($1,$2,$3,'gmail','14d-local-only',$4,array['https://www.googleapis.com/auth/gmail.modify']::text[],array['send','read']::text[],'active',1)",
  [accountId,b.business,b.owner,mailbox]);
 const followup={operation:"send",action:null,to:[email],cc:[],bcc:[],
  subject:"Purchase order follow-up "+b.po,body:"Please clarify the remaining delivery and revised invoice.",
  messageId:null,threadId:null,labelId:null,labelName:null,accountId,generation:1,from:mailbox,
  supplierFollowup:{purchaseOrderId:b.po,contactId,poRevision:1,
   receiptVersions:Number((await one("select count(*) n from public.purchase_receipts where business_id=$1 and purchase_order_id=$2",[b.business,b.po])).n),
   invoiceVersions:Number((await one("select count(*) n from public.supplier_invoices where business_id=$1 and purchase_order_id=$2",[b.business,b.po])).n)}};
 const follow=await draft("alex.gmail_effect.v1",followup);
 const guard="select public.supervisor_guard_supplier_followup_send($1,$2,$3,$4,$5) allowed";
 const sendArgs=(p,reserve)=>[b.business,b.owner,p.id,p.effectHash,reserve];
 check((await service(()=>one(guard,sendArgs(follow,true)))).allowed===false,"follow-up cannot reserve without exact owner click");
 await attempt(()=>one(guard,sendArgs(follow,true)),"42501","authenticated",b.owner);
 await claim(follow);
 check((await service(()=>one(guard,sendArgs(follow,false)))).allowed===false,"no send preflight without reservation");
 check((await service(()=>one(guard,sendArgs(follow,true)))).allowed===true,"exact owner approval reserves one discrepancy follow-up");
 check((await service(()=>one(guard,sendArgs(follow,true)))).allowed===false,"same proposal cannot reserve twice");
 check((await service(()=>one(guard,sendArgs(follow,false)))).allowed===true,"live contact and source version checked before POST");
 const repeat=await draft("alex.gmail_effect.v1",followup);await claim(repeat);
 check((await service(()=>one(guard,sendArgs(repeat,true)))).allowed===false,"different proposal cannot resend the same discrepancy");
 check((await service(()=>one(guard,[a.business,a.owner,follow.id,follow.effectHash,false]))).allowed===false,"foreign owner/cafe reservation denied");
 await db.query("update public.cafe_supplier_order_contacts set revoked_at=now() where id=$1",[contactId]);
 check((await service(()=>one(guard,sendArgs(follow,false)))).allowed===false,"revocation immediately fences provider POST");
 await db.query("update public.cafe_supplier_order_contacts set revoked_at=null where id=$1",[contactId]);
 await db.query("update public.connector_accounts set enabled_operations=array['read']::text[] where id=$1",[accountId]);
 check((await service(()=>one(guard,sendArgs(follow,false)))).allowed===false,"current send permission withdrawal fences POST");
 check(Number((await one("select count(*) n from public.connector_provider_receipts where business_id=$1 and proposal_id=$2",[b.business,follow.id])).n)===0,"reservation is not a provider receipt or delivery");
 await db.query("ROLLBACK");
 console.log("Task14D source schema, receiving and invoice gateway assertions passed: "+count);
}catch(e){try{await db.query("ROLLBACK")}catch{}throw e;}finally{await db.end();}
