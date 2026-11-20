import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

// Same migrated disposable database as the existing Task15/Toast proof.
// A real remote database is never a valid performance/recovery fixture.
const enabled=process.env.U1_RELIABILITY_DB_SANDBOX_ONLY==="1";
const url=process.env.U1_RELIABILITY_DB_URL??"";
if(enabled){
 const parsed=new URL(url);
 if(!["localhost","127.0.0.1"].includes(parsed.hostname)||parsed.port!=="54322"||parsed.pathname!=="/postgres")
  throw new Error("U1 reliability rejects non-disposable database");
}
async function connect(role:"postgres"|"service_role"|"authenticated"="postgres",uid?:string){
 const db=new Client({connectionString:url});
 await db.connect();
 if(role!=="postgres"){
  await db.query("select set_config('request.jwt.claim.role',$1,false)",[role]);
  if(uid)await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
  await db.query("set role "+role);
 }
 return db;
}
const claim=async(db:Client,id:string,admit:boolean)=>
 (await db.query<{result:{token:string}|null}>("select public.supervisor_claim_derived_refresh($1,$2) result",[id,admit])).rows[0].result;
const finish=async(db:Client,id:string,token:string,success:boolean)=>
 (await db.query<{result:{accepted:boolean;pending:boolean}}>("select public.supervisor_finish_derived_refresh($1,$2,$3) result",[id,token,success])).rows[0].result;

describe("U1 migrated coordination, contention and recovery",()=>{
 (enabled?it:it.skip)("retains arrivals, protects two cafes, recovers a terminated worker and fences stale receipts",async()=>{
  const admin=await connect();
  let a:Client|undefined,b:Client|undefined,owner:Client|undefined;
  const cafes=[randomUUID(),randomUUID()],uid=randomUUID();
  try{
   await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[uid,uid+"@example.invalid"]);
   for(const id of cafes)await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'U1 synthetic cafe','UTC',false)",[id]);
   await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafes[0],uid]);
   a=await connect("service_role");b=await connect("service_role");owner=await connect("authenticated",uid);
   await expect(claim(owner,cafes[0],true)).rejects.toThrow();
   await expect(owner.query("select * from public.supervisor_derived_refresh_state")).rejects.toThrow();
   expect(await claim(a,cafes[0],false)).toBeNull(); // import request, no work yet
   const results=await Promise.all([claim(a,cafes[0],true),claim(b,cafes[1],true)]);
   expect(results.filter(Boolean)).toHaveLength(1);
   const winner=results[0]?0:1,loser=1-winner;
   const token=results[winner]!.token;
   expect(await claim(b,cafes[winner],false)).toBeNull(); // arrival while leased
   expect(await claim(b,cafes[loser],true)).toBeNull(); // cross-cafe admission
   expect(await finish(b,cafes[loser],token,true)).toEqual({accepted:false,pending:true});
   const active=await admin.query("select count(*)::int n from public.supervisor_derived_refresh_state where lease_until>clock_timestamp()");
   expect(active.rows[0].n).toBe(1);
   expect(await finish(a,cafes[winner],token,true)).toEqual({accepted:true,pending:true});
   const ordered=await b.query<{id:string}>("select id from public.supervisor_list_derived_refresh_businesses()");
   expect(ordered.rows.findIndex(r=>r.id===cafes[loser])).toBeLessThan(ordered.rows.findIndex(r=>r.id===cafes[winner]));
   const second=await claim(b,cafes[loser],true);
   expect(second?.token).toEqual(expect.any(String));
   // A disconnected worker cannot acknowledge its lease. Expire only the
   // synthetic lease explicitly, then recover the SAME business state.
   await b.end();b=undefined;
   await admin.query("update public.supervisor_derived_refresh_state set lease_until=clock_timestamp()-interval '1 second' where business_id=$1",[cafes[loser]]);
   b=await connect("service_role");
   const recovered=await claim(b,cafes[loser],true);
   expect(recovered?.token).not.toBe(second!.token);
   expect(await finish(a,cafes[loser],second!.token,true)).toEqual({accepted:false,pending:true});
   expect(await finish(b,cafes[loser],recovered!.token,false)).toEqual({accepted:true,pending:true});
   const retry=await claim(a,cafes[loser],true);
   expect(await finish(a,cafes[loser],retry!.token,true)).toEqual({accepted:true,pending:false});
   const row=(await admin.query("select requested_version::text,completed_version::text,last_error,lease_token from public.supervisor_derived_refresh_state where business_id=$1",[cafes[loser]])).rows[0];
   expect(row.completed_version).toBe(row.requested_version);
   expect(row.last_error).toBeNull();expect(row.lease_token).toBeNull();
  }finally{
   await Promise.allSettled([a?.end(),b?.end(),owner?.end()]);
   await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);
   await admin.query("delete from auth.users where id=$1",[uid]);
   await admin.end();
  }
 },30000);
});

describe("U1 migrated full-year coverage workload",()=>{
 (enabled?it:it.skip)("proves identical canonical dates with one SQL response on dense two-cafe orders",async()=>{
  const db=await connect();
  const cafes=[randomUUID(),randomUUID()],locations=[randomUUID(),randomUUID()],owner=randomUUID();
  const from="2025-11-21",to="2026-11-20";
  try{
   await db.query("begin");
   for(let i=0;i<2;i++){
    await db.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'U1 workload fixture','UTC',false)",[cafes[i]]);
    await db.query("insert into public.locations(id,business_id,name) values ($1,$2,'Fixture register')",[locations[i],cafes[i]]);
   }
   await db.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
   await db.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafes[0],owner]);
   // 364 dates with exactly 32 Toast orders each. The final day has only
   // non-Toast sales in this cafe and a Toast order in the other cafe.
   await db.query("insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) select $1,$2,'toast:u1:'||g,($3::date+(g/32))::timestamptz,$3::date+(g/32),450,450 from generate_series(0,11647) g",[cafes[0],locations[0],from]);
   await db.query("insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) values($1,$2,'square:u1:last',$5::date::timestamptz,$5,999,999),($3,$4,'toast:u1:foreign',$5::date::timestamptz,$5,888,888)",[cafes[0],locations[0],cafes[1],locations[1],to]);
   await db.query("select set_config('request.jwt.claim.role','service_role',true)");
   await db.query("set local role service_role");
   const args=[cafes[0],from,to];
   const oldSql="select id,business_date::text from public.orders where business_id=$1 and business_date between $2::date and $3::date and pos_order_id like 'toast:%' order by id";
   const newSql="select public.toast_unverified_sales_dates($1,$2,$3,true) result";
   const oldRows=(await db.query(oldSql,args)).rows;
   const dates=[...new Set(oldRows.map(r=>r.business_date))].sort();
   expect(oldRows).toHaveLength(11648);expect(dates).toHaveLength(364);
   const result=(await db.query(newSql,args)).rows[0].result;
   expect(result).toEqual({canonicalDates:dates});
   expect(result.canonicalDates).not.toContain(to);
   expect((await db.query("select public.toast_unverified_sales_dates($1,$2,$3,true) result",[cafes[1],from,to])).rows[0].result).toEqual({canonicalDates:[to]});
   const oldTimes:number[]=[],newTimes:number[]=[],oldBytes=Buffer.byteLength(JSON.stringify(oldRows)),newBytes=Buffer.byteLength(JSON.stringify(result));
   for(let i=0;i<9;i++){
    const reads=i%2?[[newSql,newTimes],[oldSql,oldTimes]] as const:[[oldSql,oldTimes],[newSql,newTimes]] as const;
    for(const [sql,times] of reads){
     const start=performance.now();
     await db.query(sql,args);
     times.push(performance.now()-start);
    }
   }
   const percentile=(values:number[],q:number)=>Number([...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1].toFixed(3));
   expect(newBytes).toBeLessThan(oldBytes/20);
   const plans=await Promise.all([db.query("explain (analyze,buffers,format json) "+oldSql,args),db.query("explain (analyze,buffers,format json) "+newSql,args)]);
   console.log("U1_DB_WORKLOAD "+JSON.stringify({orders:oldRows.length,dates:dates.length,oldBytes,newBytes,
    oldP50Ms:percentile(oldTimes,.5),oldP95Ms:percentile(oldTimes,.95),newP50Ms:percentile(newTimes,.5),newP95Ms:percentile(newTimes,.95),
    executionMs:plans.map(p=>p.rows[0]["QUERY PLAN"][0]["Execution Time"]),
    returnedRows:plans.map(p=>p.rows[0]["QUERY PLAN"][0].Plan["Actual Rows"])}));
   await db.query("reset role");
   await db.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)",[owner]);
   await db.query("set local role authenticated");
   expect((await db.query(newSql,args)).rows[0].result).toEqual(result);
   await db.query("savepoint reject_foreign");
   await expect(db.query(newSql,[cafes[1],from,to])).rejects.toThrow();
   await db.query("rollback to savepoint reject_foreign");
  }finally{await db.query("rollback");await db.end();}
 },120000);
});
