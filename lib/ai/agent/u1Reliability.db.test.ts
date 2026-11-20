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
