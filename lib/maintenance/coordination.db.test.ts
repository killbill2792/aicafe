import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

const sandbox=process.env.TASK15B_DB_SANDBOX_ONLY==="1";
const url=process.env.TASK15B_DB_URL??"";
if(sandbox){
  const target=new URL(url);
  if(!["localhost","127.0.0.1"].includes(target.hostname)||
    target.port!=="54322"||target.pathname!=="/postgres")
    throw new Error("Task 15B can only test disposable local Supabase");
}
async function connect(role:"admin"|"owner",userId?:string){
  const db=new Client({connectionString:url});
  await db.connect();
  if(role==="owner"){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[userId]);
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("set role authenticated");
  }
  return db;
}
const callReport=(db:Client,cafe:string,id:string,label:string,at:string)=>
  db.query("select public.maintenance_report_case($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz) as id",
    [cafe,id,label,"Espresso machine stopped brewing","high",at])
    .then(r=>r.rows[0]?.id as string);
const callProgress=(db:Client,cafe:string,task:string,nonce:string,
  kind:string,note:string,working=false)=>
  db.query("select public.maintenance_record_progress($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::boolean) as stage",
    [cafe,task,nonce,kind,note,working]).then(r=>r.rows[0]?.stage as string);

describe("Task 15B disposable migrated SQL: real source, tenant, repair and receipt gates",()=>{
  (sandbox?it:it.skip)("only an authenticated owner can report; no forged sends, closing without proof or cross-café writes",async()=>{
    const admin=await connect("admin");
    const cafes=[randomUUID(),randomUUID()];
    const users=[randomUUID(),randomUUID()];
    let owner:Client|undefined,other:Client|undefined;
    const stamp=new Date().toISOString();
    try{
      for(let i=0;i<2;i++){
        await admin.query(
          "insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
          "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
          [users[i],"maintenance-"+users[i]+"@example.invalid"]);
        await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,'America/Los_Angeles',false)",
          [cafes[i],"Disposable maintenance cafe"]);
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
          [cafes[i],users[i]]);
      }
      owner=await connect("owner",users[0]);
      other=await connect("owner",users[1]);
      const nonce=randomUUID();
      const task=await callReport(owner,cafes[0],nonce,"Main espresso machine",stamp);
      expect(task).toBe("maintenance:"+nonce);
      // Same real report/source nonce must be idempotent. Altering the report
      // while reusing the nonce is a conflict, not a second incident.
      expect(await callReport(owner,cafes[0],nonce,"Main espresso machine",stamp)).toBe(task);
      await expect(callReport(owner,cafes[0],nonce,"Different machine",stamp)).rejects.toThrow();
      await expect(callReport(other,cafes[0],randomUUID(),"Main espresso machine",stamp))
        .rejects.toThrow();
      const source=await admin.query("select kind,status,payload,evidence,owner_user_id from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],task]);
      expect(source.rows).toHaveLength(1);
      expect(source.rows[0]).toMatchObject({kind:"maintenance_issue",status:"needs_owner",owner_user_id:users[0]});
      expect(source.rows[0].payload).toMatchObject({maintenanceStage:"reported",repairVerified:false,externalSent:false});
      const reportEvents=await owner.query("select kind,source_kind from public.maintenance_case_events where business_id=$1 and task_id=$2",
        [cafes[0],task]);
      expect(reportEvents.rows).toEqual([{kind:"report",source_kind:"owner_report"}]);
      expect((await other.query("select id from public.maintenance_case_events where business_id=$1",
        [cafes[0]])).rows).toHaveLength(0);
      // Legacy broad member policy must never allow a forged completion,
      // evidence rewrite or forced archive of a maintenance source.
      await expect(owner.query("update public.operating_tasks set status='handled',resolved_at=now() where business_id=$1 and id=$2",
        [cafes[0],task])).rejects.toThrow();
      await expect(owner.query("delete from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],task])).rejects.toThrow();
      await expect(callProgress(owner,cafes[0],task,randomUUID(),
        "operational_verification","The vendor said it's repaired",true)).rejects.toThrow();
      await expect(callProgress(other,cafes[0],task,randomUUID(),
        "repair_claim","Forged other café report")).rejects.toThrow();
      // A technician's claimed repair only advances the audit state, not
      // operational proof, external send, resolved_at or 15A closure.
      const claimNonce=randomUUID();
      expect(await callProgress(owner,cafes[0],task,claimNonce,
        "repair_claim","Technician says repair completed")).toBe("repair_claimed");
      expect(await callProgress(owner,cafes[0],task,claimNonce,
        "repair_claim","Technician says repair completed")).toBe("repair_claimed");
      await expect(callProgress(owner,cafes[0],task,claimNonce,
        "operational_verification","I independently inspected the equipment",true))
        .rejects.toThrow();
      await expect(callProgress(owner,cafes[0],task,claimNonce,
        "repair_claim","Different evidence")).rejects.toThrow();
      const before=await admin.query("select status,resolved_at,payload,evidence from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],task]);
      expect(before.rows[0].status).toBe("needs_owner");
      expect(before.rows[0].resolved_at).toBeNull();
      expect(before.rows[0].payload).toMatchObject({repairVerified:false,maintenanceStage:"repair_claimed"});
      expect(before.rows[0].evidence.length).toBeGreaterThan(1);
      await expect(callProgress(owner,cafes[0],task,randomUUID(),
        "operational_verification","Not actually inspected",false)).rejects.toThrow();
      // The owner explicitly reports an independent, physical working check.
      expect(await callProgress(owner,cafes[0],task,randomUUID(),
        "operational_verification","I tested actual espresso extraction",true))
        .toBe("verified_repaired");
      const after=await admin.query("select status,resolved_at,payload from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],task]);
      expect(after.rows[0].status).toBe("handled");
      expect(after.rows[0].resolved_at).not.toBeNull();
      expect(after.rows[0].payload).toMatchObject({maintenanceStage:"verified_repaired",repairVerified:true,externalSent:false});
      const finalEvents=(await admin.query("select kind from public.maintenance_case_events where business_id=$1 and task_id=$2",
        [cafes[0],task])).rows.map(x=>x.kind);
      expect(finalEvents).toHaveLength(3);
      expect(new Set(finalEvents)).toEqual(new Set(["report","repair_claim","operational_verification"]));
      await expect(owner.query("update public.maintenance_case_events set note='fraud' where business_id=$1 and task_id=$2",
        [cafes[0],task])).rejects.toThrow();
      expect(await callProgress(owner,cafes[0],task,randomUUID(),"reopened","Machine failed again"))
        .toBe("reopened");
      const reopened=await admin.query("select status,payload from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],task]);
      expect(reopened.rows[0].status).toBe("needs_owner");
      expect(reopened.rows[0].payload.repairVerified).toBe(false);
    }finally{
      await owner?.end();await other?.end();
      // Account erasure must still cascade despite immutable-history policy.
      for(const cafe of cafes)await admin.query("delete from public.businesses where id=$1",[cafe]);
      for(const user of users)await admin.query("delete from auth.users where id=$1",[user]);
      await admin.end();
    }
  });
});
