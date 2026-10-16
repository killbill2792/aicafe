import pg from "pg";
import assert from "node:assert/strict";
if(process.env.P1_DISPOSABLE_DB!=="1")throw Error("Requires explicit disposable test opt-in");
const cfg={host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres"};
const dbs=await Promise.all(Array.from({length:4},async()=>{const c=new pg.Client(cfg);await c.connect();return c;}));
const [admin,a,b,reader]=dbs;
const A="a12a12a1-1111-4111-8111-a12a12a12a12",B="b12b12b1-1111-4111-8111-b12b12b12b12";
const ownerA="a12a12a1-2222-4222-8222-a12a12a12a12";
const ownerB="b12b12b1-2222-4222-8222-b12b12b12b12";
const manager="a12a12a1-3333-4333-8333-a12a12a12a12";
const menu="a12a12a1-4444-4444-8444-a12a12a12a12";
const ingredient="a12a12a1-5555-4555-8555-a12a12a12a12";
const employee="a12a12a1-6666-4666-8666-a12a12a12a12";
const price="a12a12a1-7777-4777-8777-a12a12a12a12";
const job="a12a12a1-8888-4888-8888-a12a12a12a12";
let count=0;function check(condition,msg){assert.ok(condition,msg);count++;}
const value=(s,key,id)=>s.sources[key].find(v=>v.id===id);
const rev=async()=>BigInt((await admin.query(
 "SELECT revision::text FROM public.p1_business_source_epochs WHERE business_id=$1",[A])).rows[0].revision);
async function snapshot(business=A,user=ownerA){
 await reader.query("BEGIN");
 try{
   await reader.query("SET LOCAL ROLE authenticated");
   await reader.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
   const data=await reader.query(
     "SELECT public.p1_authoritative_source_snapshot($1) AS snapshot",[business]);
   await reader.query("COMMIT");
   return data.rows[0]?.snapshot??null;
 }catch(e){await reader.query("ROLLBACK");throw e;}
}
try{
 await admin.query("INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) VALUES ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','revowner-a@example.invalid','',now(),now()),($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','revowner-b@example.invalid','',now(),now()),($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','revmanager@example.invalid','',now(),now())",[ownerA,ownerB,manager]);
 await admin.query("INSERT INTO public.businesses(id,name,is_demo) VALUES($1,'P1 disposable A',false),($2,'P1 disposable B',false)",[A,B]);
 await admin.query("INSERT INTO public.memberships(business_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'manager'),($4,$5,'owner')",[A,ownerA,manager,B,ownerB]);
 await admin.query("INSERT INTO public.menu_items(id,business_id,name,base_name,price_cents,category) VALUES($1,$2,'Iced latte','Iced latte',525,'ESPRESSO_DRINK')",[menu,A]);
 await admin.query("INSERT INTO public.ingredients(id,business_id,name,base_unit) VALUES($1,$2,'Milk','ml')",[ingredient,A]);
 await admin.query("INSERT INTO public.ingredient_prices(id,ingredient_id,effective_from,cost_per_base_unit_micros,source) VALUES($1,$2,'2026-10-01',200,'manual')",[price,ingredient]);
 await admin.query("INSERT INTO public.recipe_lines(menu_item_id,ingredient_id,quantity) VALUES($1,$2,200)",[menu,ingredient]);
 await admin.query("INSERT INTO public.employees(id,business_id,display_name,active,default_hourly_wage_cents,wage_period,wage_amount_cents) VALUES($1,$2,'Sophie',true,1800,'hour',1800)",[employee,A]);

 const initial=await snapshot();
 check(initial?.contract==="p1.authoritative_snapshot.v1","recognized snapshot contract");
 check(BigInt(initial.revision)===await rev(),"snapshot epoch matches durable ledger");
 check(value(initial,"menu",menu)?.price_cents===525,"initial price");
 check(value(initial,"ingredientPrices",price)?.cost_per_base_unit_micros===200,"initial ingredient cost");
 check(value(initial,"employees",employee)?.default_hourly_wage_cents===1800,"initial wage");
 check(initial.coverage==="not_proven_by_revision"&&initial.sources.dailyRollups.length===0,
   "missing sales coverage remains unproven");

 await a.query("BEGIN");
 await a.query("UPDATE public.menu_items SET price_cents=600 WHERE id=$1",[menu]);
 await a.query("UPDATE public.ingredient_prices SET cost_per_base_unit_micros=250 WHERE id=$1",[price]);
 const during=await snapshot();
 check(during.revision===initial.revision&&value(during,"menu",menu).price_cents===525&&
   value(during,"ingredientPrices",price).cost_per_base_unit_micros===200,
   "concurrent read never observes uncommitted price or cost");
 await a.query("COMMIT");
 const current=await snapshot();
 check(BigInt(current.revision)>BigInt(initial.revision)&&
   value(current,"menu",menu).price_cents===600&&
   value(current,"ingredientPrices",price).cost_per_base_unit_micros===250,
   "price, cost and revision visible in one committed snapshot");

 await a.query("BEGIN");
 await a.query("UPDATE public.employees SET default_hourly_wage_cents=1900 WHERE id=$1",[employee]);
 await b.query("BEGIN");
 let finished=false;
 const conflicting=b.query("UPDATE public.businesses SET payroll_tax_rate=0.1300 WHERE id=$1",[A])
   .then(()=>{finished=true;});
 await new Promise(resolve=>setTimeout(resolve,250));
 check(!finished,"wage and payroll updates serialize on shared epoch");
 const beforeCommit=await snapshot();
 check(beforeCommit.revision===current.revision&&
   value(beforeCommit,"employees",employee).default_hourly_wage_cents===1800&&
   Number(beforeCommit.payroll.rate)===0.12,"concurrent payroll/wage snapshot not mixed");
 await a.query("COMMIT");
 await conflicting;
 await b.query("COMMIT");
 const after=await snapshot();
 check(BigInt(after.revision)>=BigInt(current.revision)+2n&&
   value(after,"employees",employee).default_hourly_wage_cents===1900&&
   Number(after.payroll.rate)===0.13,"both committed wage and burden are revisioned");

 await a.query("BEGIN");
 await a.query("UPDATE public.menu_items SET price_cents=999 WHERE id=$1",[menu]);
 await a.query("ROLLBACK");
 check(await rev()===BigInt(after.revision)&&
   value(await snapshot(),"menu",menu).price_cents===600,"rollback changes neither fact nor epoch");

 await a.query("BEGIN");
 await a.query("INSERT INTO public.csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count) VALUES($1,$2,'sales','processing','p1-e2e-synthetic',2,1)",[job,A]);
 await a.query("INSERT INTO public.orders(business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) VALUES($1,'p1-synthetic-csv',now(),'2026-10-15',1000,1000)",[A]);
 await a.query("UPDATE public.csv_import_jobs SET status='done' WHERE id=$1",[job]);
 const pending=await snapshot();
 check(pending.revision===after.revision&&pending.sources.imports.every(i=>i.id!==job),
   "uncommitted CSV canonical+job data not visible");
 await a.query("COMMIT");
 const imported=await snapshot();
 check(BigInt(imported.revision)>BigInt(after.revision)&&
   value(imported,"imports",job).status==="done","CSV canonical promotion+status advances revision");
 check(imported.coverage==="not_proven_by_revision",
   "CSV completion is not proof of complete historical POS coverage");

 // Actual reviewed CSV promotion RPC, invoked as the authenticated owner.
 const promotedJob="a12a12a1-9999-4999-8999-a12a12a12a12";
 await admin.query("INSERT INTO public.csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count) VALUES($1,$2,'sales','processing','p1-real-csv-rpc',2,1)",[promotedJob,A]);
 await admin.query("INSERT INTO public.csv_sales_import_groups(job_id,business_id,business_date,item_name,menu_item_id,quantity,net_sales_cents) VALUES($1,$2,'2026-10-14','Iced latte',$3,2,1200)",[promotedJob,A,menu]);
 const staged=await snapshot();
 await a.query("BEGIN");
 await a.query("SET LOCAL ROLE authenticated");
 await a.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ownerA]);
 const promoted=(await a.query("SELECT * FROM public.csv_finalize_sales_job($1)",[promotedJob])).rows[0];
 check(promoted?.imported_groups===1,"actual CSV finalize RPC promoted one reviewed staged group");
 check((await snapshot()).revision===staged.revision,
   "actual CSV order promotion invisible until its transaction commits");
 await a.query("COMMIT");
 const promotedSnapshot=await snapshot();
 check(BigInt(promotedSnapshot.revision)>BigInt(staged.revision)&&
   (await admin.query("SELECT count(*)::int AS count FROM public.order_lines ol JOIN public.orders o ON o.id=ol.order_id WHERE o.business_id=$1 AND o.pos_order_id LIKE 'csv-2026-10-14-%'",[A])).rows[0].count===1,
   "actual CSV promotion canonically writes order+line and changes epoch");
 check(promotedSnapshot.coverage==="not_proven_by_revision",
   "actual CSV promotion cannot prove complete historical POS coverage");
 await a.query("BEGIN");
 await a.query("SET LOCAL ROLE authenticated");
 await a.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ownerA]);
 const replay=(await a.query("SELECT * FROM public.csv_finalize_sales_job($1)",[promotedJob])).rows[0];
 await a.query("COMMIT");
 check(replay.imported_groups===0 && (await snapshot()).revision===promotedSnapshot.revision,
   "idempotent CSV finalizer does not invent an unnecessary epoch");

 await a.query("BEGIN");
 await a.query("DELETE FROM public.p1_business_source_epochs WHERE business_id=$1",[A]);
 await a.query("COMMIT");
 check(await snapshot()===null,"no authoritative revision means no snapshot");
 await admin.query("INSERT INTO public.p1_business_source_epochs(business_id,revision) VALUES($1,1)",[A]);
 check(await snapshot(B,ownerA)===null,"cross-business owner A denied");
 check(await snapshot(A,ownerB)===null,"cross-business owner B denied");
 check(await snapshot(A,manager)===null,"manager denied owner-only read");
 check(await snapshot(A,ownerA)!==null,"authorized owner remains able to read");
 const permissions=(await admin.query("SELECT has_table_privilege('authenticated','public.p1_business_source_epochs','SELECT') AS read,has_table_privilege('authenticated','public.p1_business_source_epochs','UPDATE') AS write,has_function_privilege('authenticated','public.p1_touch_business_epoch(uuid)','EXECUTE') AS touch")).rows[0];
 check(!permissions.read&&!permissions.write&&!permissions.touch,
   "clients cannot mutate authoritative revision ledger");
 // Simulate a privileged legacy import that linked a menu item to another
 // tenant's ingredient despite RLS. Never leak the foreign ingredient ID.
 const foreignIngredient="b12b12b1-5555-4555-8555-b12b12b12b12";
 await admin.query("INSERT INTO public.ingredients(id,business_id,name,base_unit) VALUES($1,$2,'Foreign-only milk','ml')",[foreignIngredient,B]);
 await admin.query("INSERT INTO public.recipe_lines(menu_item_id,ingredient_id,quantity) VALUES($1,$2,10)",[menu,foreignIngredient]);
 check(await snapshot(A)===null,"corrupt cross-tenant recipe relationship denies entire source snapshot");
 await admin.query("DELETE FROM public.recipe_lines WHERE menu_item_id=$1 AND ingredient_id=$2",[menu,foreignIngredient]);
 check(await snapshot(A)!==null,"repaired local recipe scope returns valid source snapshot");

 await admin.query("DELETE FROM public.businesses WHERE id=$1",[B]);
 check((await admin.query("SELECT count(*)::int AS count FROM public.p1_business_source_epochs WHERE business_id=$1",[B])).rows[0].count===0,
   "deleting a café cascades its ledger without resurrecting epoch rows");
 console.log("PASS "+count+" PostgreSQL source-revision, MVCC, import, rollback and tenant assertions");
}finally{
 for(const c of dbs){try{await c.query("ROLLBACK");}catch{}await c.end();}
}
