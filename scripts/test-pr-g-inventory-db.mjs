import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
const O="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",X="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ING="33333333-3333-4333-8333-333333333333",FOREIGN="44444444-4444-4444-8444-444444444444";
const LINE="55555555-5555-4555-8555-555555555555",GROUP="66666666-6666-4666-8666-666666666666";
const ONE="77777777-7777-4777-8777-777777777777",TWO="88888888-8888-4888-8888-888888888888";
const RECIPE="99999999-9999-4999-8999-999999999999",OTHER_RECIPE="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const db=new pg.Client({host:process.env.PGHOST||"127.0.0.1",port:Number(process.env.PGPORT||5432),
 user:"postgres",password:"postgres",database:"postgres"});
const call=(name,n)=>"select public."+name+"("+Array.from({length:n},(_,i)=>"$"+(i+1)).join(",")+") as value";
const stock=(line=LINE,cost=500,price=500000,date="2026-10-25",expected=null)=>
 [A,line,ING,date,1,"each",1,cost,price,"bulk",null,null,expected];
const receipt=(line,index,cost,name)=>
 [A,line,ING,"2026-10-25",1,"each",1,cost,cost*1000000,
  GROUP,index,"Test Supplier",2500,"pr-g-test-chat-receipt",name];
async function as(actor,fn){
 await db.query("begin");
 try{
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
  await fn();
  await db.query("commit");
 }catch(e){await db.query("rollback");throw e;}
}
async function reject(sql,args,code){
 await db.query("savepoint expect_failure");
 let actual;
 try{await db.query(sql,args);}catch(error){actual=error.code;}
 await db.query("rollback to savepoint expect_failure");
 await db.query("release savepoint expect_failure");
 assert.equal(actual,code,"Unexpected SQLSTATE");
}
try{
 await db.connect();
 const setup=[
  "create extension if not exists pgcrypto",
  "create schema auth",
  "create role authenticated nologin",
  "create role anon nologin",
  "create role service_role nologin",
  "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$",
  "create table businesses(id uuid primary key,is_demo boolean not null default false,timezone text not null default 'America/Los_Angeles')",
  "create table memberships(business_id uuid references businesses(id),user_id uuid,role text,primary key(business_id,user_id))",
  "create function public.is_member(target uuid) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from memberships where business_id=target and user_id=auth.uid()) $$",
  "create table ingredients(id uuid primary key,business_id uuid not null references businesses(id),name text not null,base_unit text not null,unique(id,business_id))",
  "create table ingredient_prices(id uuid primary key default gen_random_uuid(),ingredient_id uuid not null references ingredients(id),effective_from date not null,cost_per_base_unit_micros bigint not null,source text not null,source_expense_line_id uuid)",
  "create table expense_categories(code text primary key)",
  "insert into expense_categories values ('ingredients')",
  "create table expenses(id uuid primary key default gen_random_uuid(),business_id uuid not null references businesses(id),spent_on date not null,amount_cents bigint not null,vendor text,category_code text references expense_categories(code),source text not null,status text not null,dedupe_key text not null,unique(business_id,dedupe_key))",
  "create table expense_lines(id uuid primary key default gen_random_uuid(),expense_id uuid not null references expenses(id),description text not null,quantity numeric(12,4),unit text,amount_cents bigint not null,ingredient_id uuid references ingredients(id))",
  "create table pantry_stock_purchases(id uuid primary key default gen_random_uuid(),business_id uuid not null references businesses(id),ingredient_id uuid not null,purchase_date date not null,quantity_base numeric(18,4) not null,entered_quantity numeric(18,4) not null,entered_unit text not null,created_at timestamptz not null default now(),foreign key(ingredient_id,business_id) references ingredients(id,business_id))",
  "create table modifier_recipes(id uuid primary key,business_id uuid not null references businesses(id))",
  "create table toast_catalog_facts(business_id uuid,restaurant_guid uuid,provider_guid uuid,linked_modifier_recipe_id uuid,kind text)",
  "create table toast_labor_entries(business_id uuid,external_time_entry_id uuid,clock_in timestamptz,clock_out timestamptz,location_id uuid,external_employee_id uuid,restaurant_guid uuid,deleted boolean default false)",
  "create table toast_employee_directory(business_id uuid,restaurant_guid uuid,employee_guid uuid,deleted boolean default false,display_name text)",
  "create table daily_rollups(business_id uuid,business_date date,sales_data_status text)",
  "create table supervisor_proposals(id uuid primary key,business_id uuid,owner_user_id uuid,thread_id uuid,capability_id text,status text,revision integer,canonical_effect_payload jsonb,effect_hash text,updated_at timestamptz)",
  "grant usage on schema public,auth to authenticated",
  "grant execute on function auth.uid() to authenticated",
  "grant select on businesses,memberships,ingredients,modifier_recipes to authenticated",
  "alter table pantry_stock_purchases enable row level security",
  "create policy owners_insert on pantry_stock_purchases for insert to authenticated with check(exists(select 1 from memberships m where m.business_id=pantry_stock_purchases.business_id and m.user_id=auth.uid() and m.role='owner'))",
  "create policy members_select on pantry_stock_purchases for select to authenticated using(public.is_member(business_id))",
  "grant select,insert on pantry_stock_purchases to authenticated"
 ];
 for(const statement of setup)await db.query(statement);
 await db.query("insert into businesses(id) values($1),($2)",[A,B]);
 await db.query("insert into memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[A,O,B,X]);
 await db.query("insert into ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','each'),($3,$4,'Other milk','each')",[ING,A,FOREIGN,B]);
 await db.query("insert into modifier_recipes values($1,$2),($3,$4)",[RECIPE,A,OTHER_RECIPE,B]);
 const migration=readFileSync(new URL("../supabase/migrations/20261027000100_inventory_purchases.sql",import.meta.url),"utf8");
 await db.query(migration);
 await db.query(migration);
 const w=call("pantry_write_purchase_line",13),q=call("pantry_write_receipt_chat_line",15);
 await as(O,async()=>{
  const first=await db.query(w,stock());
  await db.query(w,stock());
  assert.equal((await db.query("select count(*)::int n from pantry_stock_purchases where line_id=$1",[LINE])).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from ingredient_prices where source_stock_line_id=$1",[LINE])).rows[0].n,1);
  await reject(w,stock(LINE,700,700000),"40001");
  await reject(w,[A,LINE,FOREIGN,...stock().slice(3)],"22023");
  await reject(w,stock(LINE,500,500000,"2026-10-25","2000-01-01T00:00:00Z"),"40001");
  await db.query(w,stock(LINE,600,600000,"2026-10-25",first.rows[0].value));
  assert.equal((await db.query("select cost_cents from pantry_stock_purchases where line_id=$1",[LINE])).rows[0].cost_cents,"600");
  await db.query(call("pantry_void_purchase_line",2),[A,LINE]);
  await db.query(call("pantry_void_purchase_line",2),[A,LINE]);
  assert.equal((await db.query("select count(*)::int n from ingredient_prices where source_stock_line_id=$1",[LINE])).rows[0].n,0);
  await reject(w,stock(),"40001");
  await db.query(q,receipt(ONE,0,1000,"Milk"));
  await db.query(q,receipt(ONE,0,1000,"Milk"));
  await db.query(q,receipt(TWO,1,1500,"Milk"));
  assert.equal((await db.query("select count(*)::int n from expenses")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from expense_lines")).rows[0].n,2);
  assert.equal((await db.query("select count(*)::int n from pantry_stock_purchases where expense_line_id is not null")).rows[0].n,2);
  await reject(q,receipt(TWO,1,1600,"Milk"),"40001");
  const links=await db.query("select l.expense_id from pantry_stock_purchases p join expense_lines l on p.expense_line_id=l.id where p.source='receipt_chat'");
  assert.equal(links.rowCount,2);
  assert.equal(links.rows[0].expense_id,links.rows[1].expense_id);
  await db.query("insert into pantry_modifier_links(business_id,provider,location_ref,pos_modifier_id,modifier_recipe_id) values($1,'square','loc1','mod1',$2)",[A,RECIPE]);
  await reject("insert into pantry_modifier_links(business_id,provider,location_ref,pos_modifier_id,modifier_recipe_id) values($1,'square','loc2','mod2',$2)",[A,OTHER_RECIPE],"42501");
  assert.equal((await db.query(call("pantry_usage_sales_evidence",3),[A,"2026-10-25","2026-10-25"])).rows[0].value.covered,false);
 });
 await as(X,async()=>{
  await reject(w,stock(),"42501");
  await reject(q,receipt(ONE,0,1000,"Milk"),"42501");
  assert.equal((await db.query("select count(*)::int n from pantry_stock_purchases where business_id=$1",[A])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from pantry_modifier_links where business_id=$1",[A])).rows[0].n,0);
 });
 await db.query("insert into daily_rollups values($1,'2026-10-25','actual')",[A]);
 await as(O,async()=>{assert.equal((await db.query(call("pantry_usage_sales_evidence",3),[A,"2026-10-25","2026-10-25"])).rows[0].value.covered,true);});
 console.log("PR G PostgreSQL: replay, RLS, stock/price CAS, voids, linked receipts, zero-sales coverage PASS");
}finally{await db.end();}
