import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
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
 await role("service_role");
 await db.query("delete from public.memberships where business_id=$1 and user_id=$2",[a.business,a.owner]);
 await denied(()=>one(capture,args));
 assert.equal(Number((await one("select count(*) n from public.expenses where business_id=$1",[a.business])).n),0);
 console.log("Task14E statement chain, idempotency, worker trigger and owner scope passed");
}finally{await db.query("ROLLBACK").catch(()=>{});await db.end();}
