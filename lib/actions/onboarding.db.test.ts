import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,it,expect} from "vitest";
import {DEFAULT_RECOVERY_ORDER} from "@/lib/constants";

const url=process.env.SUPERVISOR_RUN_DB_URL??"";
const sandbox=process.env.SUPERVISOR_RUN_DB_SANDBOX_ONLY==="1";
if(sandbox){
 if(!url)throw Error("Local onboarding DB URL required");
 const target=new URL(url);
 if(!["127.0.0.1","localhost"].includes(target.hostname)||target.port!=="54322"||target.pathname!=="/postgres")
  throw Error("Onboarding test refuses a non-disposable database");
}
describe("atomic owner onboarding",()=>{
 (sandbox?it:it.skip)("concurrent first visits commit one café, membership and complete recovery order",async()=>{
  const id=randomUUID(),other=randomUUID();
  const admin=new Client({connectionString:url}),a=new Client({connectionString:url}),b=new Client({connectionString:url});
  await Promise.all([admin.connect(),a.connect(),b.connect()]);
  try{
   for(const owner of [id,other])await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
   await Promise.all([a.query("set role service_role"),b.query("set role service_role")]);
   const create=(db:Client,owner:string,name:string,buckets:string[]=DEFAULT_RECOVERY_ORDER)=>db.query("select public.ensure_owner_onboarding_business($1,$2,$3::text[]) as id",[owner,name,buckets]).then(r=>r.rows[0].id as string);
   const [first,second]=await Promise.all([create(a,id,"First visit"),create(b,id,"Second visit")]);
   expect(first).toBe(second);
   const membership=await admin.query("select business_id,role from public.memberships where user_id=$1",[id]);
   expect(membership.rows).toEqual([{business_id:first,role:"owner"}]);
   const order=await admin.query("select bucket_code from public.recovery_order where business_id=$1 order by position",[first]);
   expect(order.rows.map(r=>r.bucket_code)).toEqual(DEFAULT_RECOVERY_ORDER);
   // Duplicate bucket violates the existing key, rolling back all bootstrap writes.
   await expect(create(a,other,"Rollback",["rent","rent"])).rejects.toThrow();
   expect((await admin.query("select business_id from public.memberships where user_id=$1",[other])).rows).toEqual([]);
   expect((await admin.query("select id from public.businesses where name='Rollback' and id not in (select business_id from public.memberships)")).rows).toEqual([]);
   await a.query("set role authenticated");
   await expect(create(a,other,"Unauthorized")).rejects.toThrow();
  }finally{
   await Promise.all([a.end(),b.end()]);
   await admin.query("delete from public.businesses where id in(select business_id from public.memberships where user_id=any($1::uuid[]))",[[id,other]]);
   await admin.query("delete from auth.users where id=any($1::uuid[])",[[id,other]]);
   await admin.end();
  }
 },30000);
});
