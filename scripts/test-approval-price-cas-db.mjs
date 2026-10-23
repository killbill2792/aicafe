import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";

// Disposable PostgreSQL only. This runs actual SQL functions (including the
// preexisting Menu writer) under owner-session RLS; never connects to Supabase.
const config={host:process.env.PGHOST??"127.0.0.1",port:Number(process.env.PGPORT??5432),
  user:"postgres",password:"postgres",database:"postgres"};
const db=new pg.Client(config);
const BUSINESS="11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS="22222222-2222-4222-8222-222222222222";
const OWNER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM="33333333-3333-4333-8333-333333333333";
const FOREIGN_ITEM="44444444-4444-4444-8444-444444444444";
const oldRpc="select public.set_menu_item_price_with_history($1,$2,$3,$4,$5) as saved";
const approvedRpc="select public.set_menu_item_price_with_history_if_current($1,$2,$3,$4,$5,$6) as saved";
const oldArgs=(price,product=ITEM)=>[BUSINESS,product,price,"owner_manual","Menu screen"];
const approvedArgs=(expected,price,product=ITEM,business=BUSINESS)=>
  [business,product,expected,price,"owner_manual","Alex (owner approved)"];
const result=async(client,sql,args)=>(await client.query(sql,args)).rows[0].saved;
async function beginOwner(client,owner=OWNER){
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
}
async function withOwner(client,callback,owner=OWNER){
  await beginOwner(client,owner);
  try{const value=await callback();await client.query("commit");return value;}
  catch(error){await client.query("rollback");throw error;}
}
async function price(){return Number((await db.query("select price_cents from menu_items where id=$1",[ITEM])).rows[0].price_cents);}
async function historyCount(){return Number((await db.query(
  "select count(*) from menu_price_history where menu_item_id=$1",[ITEM])).rows[0].count);}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function finishPending(promise,label){
  return Promise.race([promise,delay(5000).then(()=>{throw new Error(label+" timed out")})]);
}

try{
  await db.connect();
  await db.query(`
    create extension if not exists pgcrypto;
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table businesses(id uuid primary key);
    create table memberships(business_id uuid not null references businesses(id),
      user_id uuid not null, role text not null, primary key(business_id,user_id));
    create function public.is_member(x uuid) returns boolean language sql stable security definer
      set search_path=public as $$
        select exists(select 1 from public.memberships
        where business_id=x and user_id=auth.uid()) $$;
    create table menu_items(id uuid primary key,business_id uuid not null references businesses(id),
      price_cents bigint not null, is_active boolean not null default true,
      catalog_source text);
    alter table public.menu_items enable row level security;
    create policy tenant_menu on public.menu_items for all to authenticated
      using (public.is_member(business_id)) with check (public.is_member(business_id));
    grant usage on schema public,auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant execute on function public.is_member(uuid) to authenticated;
    grant select on public.memberships to authenticated;
    grant select,update on public.menu_items to authenticated;
  `);
  await db.query(readFileSync(new URL("../supabase/migrations/20261008000031_pricing_evidence.sql",import.meta.url),"utf8"));
  await db.query(readFileSync(new URL("../supabase/migrations/20261023000082_owner_approved_menu_price_cas.sql",import.meta.url),"utf8"));
  await db.query("insert into businesses(id) values($1),($2)",[BUSINESS,OTHER_BUSINESS]);
  await db.query("insert into memberships values($1,$2,'owner'),($1,$3,'member')",[BUSINESS,OWNER,MEMBER]);
  await db.query("insert into menu_items(id,business_id,price_cents) values ($1,$2,450),($3,$4,600)",
    [ITEM,BUSINESS,FOREIGN_ITEM,OTHER_BUSINESS]);

  assert.equal(await withOwner(db,()=>result(db,oldRpc,oldArgs(470))),true,"Menu legacy RPC stays functional");
  assert.equal(await withOwner(db,()=>result(db,approvedRpc,approvedArgs(470,500))),true);
  assert.equal(await price(),500);
  assert.equal(await historyCount(),2,"each canonical save writes exactly one history row");
  assert.equal(await withOwner(db,()=>result(db,approvedRpc,approvedArgs(470,550))),false);
  assert.equal(await price(),500,"stale original price cannot overwrite");
  assert.equal(await historyCount(),2);
  assert.equal(await withOwner(db,()=>result(db,approvedRpc,approvedArgs(600,550,FOREIGN_ITEM,OTHER_BUSINESS))),false,
    "cross-business scope cannot write");
  assert.equal(await withOwner(db,()=>result(db,approvedRpc,approvedArgs(500,550)),MEMBER),false,
    "non-owner membership cannot approve");
  assert.equal(await historyCount(),2);
  await db.query("update menu_items set is_active=false where id=$1",[ITEM]);
  assert.equal(await withOwner(db,()=>result(db,approvedRpc,approvedArgs(500,550))),false,
    "inactive menu item cannot be approved");
  await db.query("update menu_items set is_active=true where id=$1",[ITEM]);
  assert.equal(await historyCount(),2);

  // Simulate POS/Menu acquiring the row lock first. A subsequent approval
  // must wait and then compare against the NEW committed price.
  const second=new pg.Client(config);
  await second.connect();
  try{
    await beginOwner(db);
    assert.equal(await result(db,oldRpc,oldArgs(525)),true);
    await beginOwner(second);
    let settled=false;
    const pending=result(second,approvedRpc,approvedArgs(500,550)).then(v=>{settled=true;return v;});
    await delay(120);
    assert.equal(settled,false,"approval waits for concurrent Menu transaction");
    await db.query("commit");
    assert.equal(await finishPending(pending,"stale approval"),false);
    await second.query("commit");
    assert.equal(await price(),525);
    assert.equal(await historyCount(),3,"stale approval did not record extra history");

    // Reverse direction: approval locks first; subsequent Menu writes must
    // serialize after it. Both changes remain in canonical history.
    await beginOwner(db);
    assert.equal(await result(db,approvedRpc,approvedArgs(525,540)),true);
    await beginOwner(second);
    settled=false;
    const pendingMenu=result(second,oldRpc,oldArgs(570)).then(v=>{settled=true;return v;});
    await delay(120);
    assert.equal(settled,false,"Menu writer must wait for approval lock");
    await db.query("commit");
    assert.equal(await finishPending(pendingMenu,"Menu write"),true);
    await second.query("commit");
    assert.equal(await price(),570);
    assert.equal(await historyCount(),5);
    const rows=(await db.query(
      "select old_price_cents,new_price_cents,source_type from menu_price_history where menu_item_id=$1 order by changed_at,id",
      [ITEM])).rows.map(r=>[Number(r.old_price_cents),Number(r.new_price_cents),r.source_type]);
    assert.equal(rows.filter(r=>r[0]===525&&r[1]===540).length,1,"approved price saved exactly once");
    assert.equal(rows.filter(r=>r[0]===540&&r[1]===570).length,1,"Menu changed after approval");
  }finally{
    await db.query("rollback").catch(()=>{});
    await second.query("rollback").catch(()=>{});
    await second.end();
  }
  console.log("Approval price CAS PostgreSQL: RLS, owner-only, inactive, stale, canonical history, two-way concurrency passed.");
}finally{await db.end();}
