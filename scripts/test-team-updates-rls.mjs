import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
const db=new pg.Client({host:process.env.PGHOST||"127.0.0.1",port:5432,user:"postgres",password:"postgres",database:"postgres"});
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",M="cccccccc-cccc-4ccc-8ccc-cccccccccccc",C="11111111-1111-4111-8111-111111111111";
async function actor(id,fn){await db.query("begin");try{await db.query("set local role authenticated");await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);await fn();await db.query("commit");}catch(e){await db.query("rollback");throw e;}}
try { await db.connect();
await db.query(`create extension if not exists pgcrypto; create schema if not exists auth; create role authenticated nologin; create role anon nologin; create role service_role nologin;
create table auth.users(id uuid primary key);create table businesses(id uuid primary key);create table memberships(business_id uuid,user_id uuid,role text);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated;grant select on memberships to authenticated;grant execute on function auth.uid() to authenticated;`);
for(const id of [A,B,M]) await db.query("insert into auth.users values ($1)",[id]);await db.query("insert into businesses values ($1)",[C]);
for(const [id,role] of [[A,"owner"],[B,"owner"],[M,"manager"]]) await db.query("insert into memberships values ($1,$2,$3)",[C,id,role]);
await db.query(readFileSync(new URL("../supabase/migrations/20261022000077_team_updates.sql",import.meta.url),"utf8"));
await db.query("insert into team_updates(business_id,owner_user_id,agent_id,domain,kind,severity,subject_type,text,locale,dedupe_key) values ($1,$2,'alex','menu_pricing','review','info','menu_item','Text','en','key1')",[C,A]);
await actor(A,async()=>{assert.equal((await db.query("select id from team_updates")).rowCount,1);assert.equal((await db.query("update team_updates set status='seen' returning id")).rowCount,1);let code;try{await db.query("update team_updates set text='forged'");}catch(e){code=e.code;}assert.equal(code,"42501");});
for(const id of [B,M])await actor(id,async()=>{assert.equal((await db.query("select id from team_updates")).rowCount,0);assert.equal((await db.query("update team_updates set status='seen' returning id")).rowCount,0);});
await assert.rejects(db.query("insert into team_updates(business_id,owner_user_id,agent_id,domain,kind,severity,subject_type,text,locale,dedupe_key) values ($1,$2,'alex','menu_pricing','review','info','menu_item','Text','en','key1')",[C,A]),{code:"23505"});
console.log("M0 Postgres: owner-only read, status-only update, dedupe passed");
}finally{await db.end();}