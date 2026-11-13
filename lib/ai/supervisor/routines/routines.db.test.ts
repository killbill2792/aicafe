import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

// The existing CI regression shards lack an active database. The DB acceptance
// lane requires an explicitly opted-in disposable local Supabase at 54322;
// NEVER accept production/staging URLs or silently treat skipped proof as pass.
const sandbox=process.env.SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY==="1";
const url=process.env.SUPERVISOR_ROUTINES_DB_URL??"";
if(sandbox){
  if(!url)throw new Error("Disposable routine DB URL required");
  const parsed=new URL(url);
  if(!["127.0.0.1","localhost"].includes(parsed.hostname)||
    parsed.port!=="54322"||parsed.pathname!=="/postgres")
    throw new Error("Routine DB test refuses non-disposable database");
}
async function connect(role:"postgres"|"owner"|"service",ownerId?:string){
  const db=new Client({connectionString:url});
  await db.connect();
  if(role==="owner"){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("set role authenticated");
  }else if(role==="service"){
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("set role service_role");
  }
  return db;
}
const call=(db:Client,name:string,args:unknown[])=>
  db.query("select to_jsonb(public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+
    ")) as result",args).then(rows=>rows.rows[0].result);

describe("routine SQL security contract",()=>{
  it("keeps owner notice security, atomic source proof and worker separation",()=>{
    const sql=readFileSync("supabase/migrations/20261111000204_supervisor_routines.sql","utf8");
    expect(sql).toContain("primary key (business_id,routine_id,local_date)");
    expect(sql).toContain("on conflict do nothing");
    expect(sql).toContain("operating_priority_notice_owner_only");
    expect(sql).toContain("role='owner'");
    expect(sql).toContain("post_supervisor_priority_notice");
    expect(sql).not.toContain("alter table public.supervisor_runs");
  });
  (sandbox?it:it.skip)("claims one local-day run across two workers, enforces owner CAS and commits one private notice",async()=>{
    const admin=await connect("postgres");
    const business=randomUUID(),ownerId=randomUUID(),threadId=randomUUID();
    const otherOwner=randomUUID(),otherBusiness=randomUUID(),otherThread=randomUUID();
    const routineId=randomUUID(),secondRoutine=randomUUID();
    let owner:Client|undefined,workerA:Client|undefined,workerB:Client|undefined;
    const insertOwner=async(id:string,cafe:string,thread:string)=>{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [id,"routine-"+id+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,'America/Los_Angeles',false)",
        [cafe,"Disposable routine café"]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafe,id]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,cafe,id,randomUUID()]);
    };
    try{
      await insertOwner(ownerId,business,threadId);
      await insertOwner(otherOwner,otherBusiness,otherThread);
      owner=await connect("owner",ownerId);
      workerA=await connect("service");
      workerB=await connect("service");
      const makeArgs=(id:string)=>[business,ownerId,threadId,"Check evidence","daily",[],"08:00",id];
      const first=await call(owner,"create_supervisor_routine",makeArgs(routineId));
      expect(first.id).toBe(routineId);
      expect((await call(owner,"create_supervisor_routine",makeArgs(routineId))).id).toBe(routineId);
      await expect(call(owner,"create_supervisor_routine",
        [otherBusiness,otherOwner,otherThread,"Cross-tenant","daily",[],"08:00",randomUUID()]))
        .rejects.toThrow();
      await call(owner,"create_supervisor_routine",makeArgs(secondRoutine));
      // Simulate the start of a previously active schedule without using
      // production timestamps or pretending a past cron ran in real life.
      await admin.query("update public.supervisor_routines set updated_at='2026-01-01T00:00:00Z' where business_id=$1",
        [business]);
      const claimArgs=[business,routineId,"2026-11-01","2026-11-01T16:00:00Z","2026-11-01T16:02:00Z"];
      const [a,b]=await Promise.all([
        call(workerA,"claim_supervisor_routine_occurrence",claimArgs),
        call(workerB,"claim_supervisor_routine_occurrence",claimArgs),
      ]);
      const claimed=a??b;
      expect(Boolean(a) !== Boolean(b)).toBe(true);
      expect(claimed.run_id).toBeTruthy();
      const other=await call(workerB,"claim_supervisor_routine_occurrence",
        [business,secondRoutine,"2026-11-01","2026-11-01T16:00:00Z","2026-11-01T16:02:00Z"]);
      expect(other.run_id).not.toBe(claimed.run_id);
      const sourceId="routine-source-"+randomUUID();
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence) values ($1,$2,'leo','data_quality','needs_owner','{}','high','[]')",
        [business,sourceId]);
      const noticeArgs=[business,ownerId,threadId,"operating_task",sourceId,
        "1".repeat(64),"2".repeat(64),"Owner task needs review",
        "2026-11-01T16:03:00Z",routineId,claimed.run_id,claimed.lease_token];
      expect(await call(workerA,"post_supervisor_priority_notice",noticeArgs)).toBe(true);
      expect(await call(workerB,"post_supervisor_priority_notice",noticeArgs)).toBe(false);
      // A concurrent retry may wait on the same unique key; only the actual
      // transaction that inserted the notice may claim a fresh delivery.
      expect((await admin.query("select count(*)::int n from public.operating_tasks where business_id=$1 and kind='priority_notice'",
        [business])).rows[0].n).toBe(1);
      const complete=[business,routineId,claimed.run_id,claimed.lease_token,
        true,"priority-check:1","2026-11-01T16:03:00Z"];
      expect(await call(workerA,"finish_supervisor_routine_occurrence",complete)).toBe(true);
      expect(await call(workerB,"claim_supervisor_routine_occurrence",claimArgs)).toBeNull();
      const proof=await admin.query("select count(*)::int as n from public.operating_tasks where business_id=$1 and kind='priority_notice'",[business]);
      expect(proof.rows[0].n).toBe(1);
      // A handled source closes its notice in the same database transaction;
      // the private receipt must never remain a second independent Needs-you.
      await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",
        [business,sourceId]);
      const settled=await admin.query("select status,resolved_at from public.operating_tasks where business_id=$1 and kind='priority_notice'",
        [business]);
      expect(settled.rows).toHaveLength(1);
      expect(settled.rows[0].status).toBe("handled");
      expect(settled.rows[0].resolved_at).not.toBeNull();
      const alertId=randomUUID();
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [alertId,business]);
      const alertKey="4".repeat(64);
      expect(await call(workerA,"post_supervisor_priority_notice",[
        business,ownerId,threadId,"alert",alertId,"3".repeat(64),
        alertKey,"Actionable café alert needs review","2026-11-01T16:04:00Z",
        null,null,null,
      ])).toBe(true);
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [business,alertId]);
      const alertReceipt=await admin.query(
        "select status,resolved_at from public.operating_tasks where business_id=$1 and id=$2",
        [business,"priority:"+alertKey]);
      expect(alertReceipt.rows[0].status).toBe("handled");
      expect(alertReceipt.rows[0].resolved_at).not.toBeNull();
      const updated=await call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,1,JSON.stringify({status:"paused"})]);
      expect(updated.status).toBe("paused");
      await expect(call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,1,JSON.stringify({status:"active"})]))
        .rejects.toThrow();
      const revoked=await call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,2,JSON.stringify({status:"revoked"})]);
      expect(revoked.status).toBe("revoked");
      expect(await call(workerB,"claim_supervisor_routine_occurrence",
        [business,secondRoutine,"2026-11-02","2026-11-02T16:00:00Z","2026-11-02T16:02:00Z"]))
        .toBeNull();
      await expect(call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,3,JSON.stringify({status:"active"})]))
        .rejects.toThrow();
    }finally{
      await Promise.all([owner?.end(),workerA?.end(),workerB?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[[business,otherBusiness]]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[[ownerId,otherOwner]]);
      await admin.end();
    }
  },120_000);
});
