import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
const db=new pg.Client({host:process.env.PGHOST??"127.0.0.1",port:Number(process.env.PGPORT??5432),user:"postgres",password:"postgres",database:"postgres"});
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const latte="11111111-1111-4111-8111-222222222222",combo="11111111-1111-4111-8111-333333333333",foreignItem="22222222-2222-4222-8222-333333333333";
const latteSize="11111111-1111-4111-8111-555555555555";
const milkA="11111111-1111-4111-8111-444444444444",milkB="22222222-2222-4222-8222-444444444444";
async function ownerTx(fn,who=owner){
 await db.query("begin");try{
 await db.query("set local role authenticated");
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);
 const result=await fn();await db.query("commit");return result;
 }catch(error){await db.query("rollback");throw error;}
}
async function expectError(sql,values,code){await db.query("savepoint test_expected");
 let actual;try{await db.query(sql,values)}catch(e){actual=e.code;}
 await db.query("rollback to savepoint test_expected");
 await db.query("release savepoint test_expected");
 assert.equal(actual,code,`expected ${code} from ${sql}`);
}
const settings=(ingredientId,isDefault=false)=>({ingredientId,kind:"milk",enabled:true,isDefault,upchargeCents:75,displayUnit:"ml",displayQuantity:1});
try{
 await db.connect();
 await db.query(`
  create extension if not exists pgcrypto;
  create schema auth;
  create role authenticated nologin;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create table businesses(id uuid primary key);
  create table memberships(business_id uuid not null references businesses(id),user_id uuid not null,primary key(business_id,user_id));
  create function public.is_member(x uuid) returns boolean language sql security definer stable set search_path=public
    as $$ select exists(select 1 from memberships where business_id=x and user_id=auth.uid()) $$;
  create table menu_items(id uuid primary key,business_id uuid not null references businesses(id),
    name text not null,base_name text not null,price_cents bigint);
  create table ingredients(id uuid primary key,business_id uuid not null references businesses(id),
    name text not null,base_unit text not null);
 `);
 await db.query(readFileSync(new URL("../supabase/migrations/20261022000080_menu_options_combos.sql",import.meta.url),"utf8"));
 await db.query(`
  grant usage on schema auth,public to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant execute on function public.is_member(uuid) to authenticated;
  grant all on all tables in schema public to authenticated;
  grant execute on function public.save_menu_product_addons(uuid,uuid,jsonb) to authenticated;
 `);
 await db.query("insert into businesses(id) values ($1),($2)",[A,B]);
 await db.query("insert into memberships values($1,$2),($3,$4)",[A,owner,B,other]);
 await db.query("insert into menu_items(id,business_id,name,base_name,price_cents) values ($1,$2,'Latte','Latte',550),($3,$2,'Combo','Combo',900),($4,$5,'Foreign','Foreign',500)",[latte,A,combo,foreignItem,B]);
 await db.query("insert into menu_items(id,business_id,name,base_name,price_cents) values ($1,$2,'Latte Large','Latte',650)",[latteSize,A]);
 await db.query("insert into ingredients(id,business_id,name,base_unit) values ($1,$2,'Milk A','ml'),($3,$4,'Milk B','ml')",[milkA,A,milkB,B]);
 await ownerTx(async()=>{
  await db.query("select public.save_menu_product_addons($1,$2,$3)",[A,latte,JSON.stringify([settings(milkA,true)])]);
  assert.equal(Number((await db.query("select count(*) from menu_product_addons")).rows[0].count),1);
  await expectError("select public.save_menu_product_addons($1,$2,$3)",[B,latte,JSON.stringify([])],"42501");
  await expectError("select public.save_menu_product_addons($1,$2,$3)",[A,latte,JSON.stringify([settings(milkB,true)])],"P0001");
  assert.equal(Number((await db.query("select count(*) from menu_product_addons")).rows[0].count),1,"transaction rollback must preserve previous option");
  await expectError("insert into menu_combo_components(business_id,combo_item_id,component_item_id) values($1,$2,$3)",[A,combo,foreignItem],"23503");
  await db.query("insert into menu_combo_components(business_id,combo_item_id,component_item_id,quantity,buy_in_cost_cents) values ($1,$2,$3,2,120)",[A,combo,latte]);
  assert.equal(Number((await db.query("select quantity from menu_combo_components where combo_item_id=$1",[combo])).rows[0].quantity),2);
 });
 await ownerTx(async()=>{
  assert.equal((await db.query("select count(*) from menu_product_addons")).rows[0].count,"0");
  assert.equal((await db.query("select count(*) from menu_combo_components")).rows[0].count,"0");
 },other);
 // Two editors saving from opposite size IDs must serialize, never deadlock.
 const second=new pg.Client({host:process.env.PGHOST??"127.0.0.1",port:Number(process.env.PGPORT??5432),user:"postgres",password:"postgres",database:"postgres"});
 await second.connect();
 try{
  await db.query("begin");await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
  await db.query("select public.save_menu_product_addons($1,$2,$3)",[A,latte,JSON.stringify([settings(milkA,true)])]);
  await second.query("begin");await second.query("set local role authenticated");
  await second.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
  const waiting=second.query("select public.save_menu_product_addons($1,$2,$3)",[A,latteSize,JSON.stringify([settings(milkA,true)])]);
  await new Promise(resolve=>setTimeout(resolve,80));
  await db.query("commit");
  await Promise.race([waiting,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Family option save timed out")),4000))]);
  await second.query("commit");
  assert.equal((await db.query("select count(*) from menu_product_addons where business_id=$1",[A])).rows[0].count,"1");
 }finally{await db.query("rollback");await second.query("rollback");await second.end();}
 console.log("Menu add-ons/combo PostgreSQL: tenant isolation, RLS, price rows, rollback, cross-tenant FK passed.");
}finally{await db.end();}
