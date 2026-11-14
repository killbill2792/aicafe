import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

// No production or staging DB may ever be used for destructive acceptance.
// The owner-domain DB CI starts a disposable Supabase on 127.0.0.1:54322.
const sandbox=process.env.SUPERVISOR_INVESTIGATION_DB_SANDBOX_ONLY==="1";
const url=process.env.SUPERVISOR_INVESTIGATION_DB_URL??"";
if(sandbox){
  const parsed=new URL(url);
  if(!["localhost","127.0.0.1"].includes(parsed.hostname)||
    parsed.port!=="54322"||parsed.pathname!=="/postgres")
    throw new Error("Task 15A rejects non-disposable test database");
}
async function connect(role:"postgres"|"service"|"owner",uid?:string){
  const db=new Client({connectionString:url});await db.connect();
  if(role==="service"){
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("set role service_role");
  }
  if(role==="owner"){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("set role authenticated");
  }
  return db;
}
const rpc=(db:Client,name:string,args:unknown[])=>
  db.query("select to_jsonb(public."+name+"("+
    args.map((_,i)=>"$"+(i+1)).join(",")+")) as result",args)
    .then(res=>res.rows[0]?.result??null);
const stamp=(d:Date,minutes=0)=>new Date(d.getTime()+minutes*60_000).toISOString();
const hex=(s:string)=>s.repeat(64);
describe("Task 15A migrated, agentic investigation SQL integration",()=>{
  (sandbox?it:it.skip)("multi-café owner isolation, concurrent claims, persistent steps, recovery, revocation and verified follow-up",async()=>{
    const admin=await connect("postgres");
    let a:Client|undefined,b:Client|undefined,ownerClient:Client|undefined;
    const cafes=[randomUUID(),randomUUID()];
    const owners=[randomUUID(),randomUUID()];
    const threads=[randomUUID(),randomUUID()];
    const alerts=[randomUUID(),randomUUID()];
    const taskId="investigation-test:"+randomUUID();
    const now=new Date();
    const anchor=stamp(now,1);
    const enqueue=(cafe:number,sourceType:string,source:string,revision=hex("a"),key=hex("b"))=>
      [cafes[cafe],owners[cafe],threads[cafe],sourceType,source,revision,key,315,anchor];
    const finish=(claim:Record<string,unknown>,outcome:string,evidence:unknown,
      narrative:string|null,when=stamp(now,2))=>[
      claim.business_id,claim.owner_user_id,claim.thread_id,
      claim.source_type,claim.source_id,claim.revision_hash,
      claim.lease_token,outcome,JSON.stringify(evidence),narrative,when,
    ];
    try{
      for(let i=0;i<2;i++){
        await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
          [owners[i],"investigation-"+owners[i]+"@example.invalid"]);
        await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,'America/Los_Angeles',false)",
          [cafes[i],"Disposable investigation café"]);
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
          [cafes[i],owners[i]]);
        await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
          [threads[i],cafes[i],owners[i],randomUUID()]);
        await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new',$3)",
          [alerts[i],cafes[i],JSON.stringify({quality:"verified",severity:"high"})]);
      }
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence) values ($1,$2,'leo','data_quality','needs_owner','{}','high','[]')",
        [cafes[0],taskId]);
      a=await connect("service");b=await connect("service");
      ownerClient=await connect("owner",owners[0]);
      await expect(rpc(ownerClient,"supervisor_enqueue_investigation",
        enqueue(0,"alert",alerts[0]))).rejects.toThrow();
      await expect(rpc(a,"supervisor_enqueue_investigation",
        [cafes[0],owners[1],threads[1],"alert",alerts[0],hex("a"),hex("b"),315,anchor]))
        .rejects.toThrow();
      expect(await rpc(a,"supervisor_enqueue_investigation",
        enqueue(0,"alert",alerts[0]))).toBe(true);
      // A repeat must keep the same progress rather than starting over.
      expect(await rpc(a,"supervisor_enqueue_investigation",
        enqueue(0,"alert",alerts[0]))).toBe(false);
      const [first,duplicate]=await Promise.all([
        rpc(a,"supervisor_claim_investigation",[anchor]),
        rpc(b,"supervisor_claim_investigation",[anchor]),
      ]);
      const claim=(first??duplicate) as Record<string,unknown>;
      expect(Boolean(first)!==Boolean(duplicate)).toBe(true);
      expect(claim.source_id).toBe(alerts[0]);
      expect(claim.phase).toBe("collect");
      const source={kind:"meal_break",status:"new",severity:"high",quality:"verified",
        relatedAlerts:["meal_break"],relatedTasks:[]};
      const checkpoint={source,collectedAt:anchor};
      expect(await rpc(a,"supervisor_finish_investigation",
        finish(claim,"collected",checkpoint,null))).toBe(true);
      expect(await rpc(b,"supervisor_finish_investigation",
        finish(claim,"collected",checkpoint,null))).toBe(false);
      const investigate=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,3)]) as Record<string,unknown>;
      expect(investigate.phase).toBe("investigate");
      expect(investigate.step_version).toBe(1);
      expect(await rpc(a,"supervisor_finish_investigation",
        finish(investigate,"investigated",{...checkpoint,missing:["laborDaysIncomplete"]},
          "Sales and staffing were checked. Both have coverage gaps; ask the owner before any change.",
          stamp(now,4)))).toBe(true);
      // A successful investigation records one REAL Supervisor thread message,
      // never a forged owner request, and enters bounded follow-up monitoring.
      const messages=await admin.query("select role,grounding->>'intent' intent,grounding->>'status' status from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation'",
        [cafes[0],threads[0]]);
      expect(messages.rows).toEqual([{role:"supervisor",intent:"priority_investigation",status:"partial"}]);
      expect(await rpc(b,"supervisor_claim_investigation",[stamp(now,5)])).toBeNull();
      // A second café can progress independently even with the first waiting.
      expect(await rpc(a,"supervisor_enqueue_investigation",
        enqueue(1,"alert",alerts[1],hex("c"),hex("d")))).toBe(true);
      const other=await rpc(b,"supervisor_claim_investigation",
        [stamp(now,6)]) as Record<string,unknown>;
      expect(other.business_id).toBe(cafes[1]);
      // A source closure is a verified terminal condition, not proof of a POS
      // price change, purchase, staff effect or external message delivery.
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [cafes[0],alerts[0]]);
      const closed=await admin.query("select phase,last_error from public.supervisor_investigations where business_id=$1 and owner_user_id=$2",
        [cafes[0],owners[0]]);
      expect(closed.rows).toEqual([{phase:"resolved",last_error:"source_closed"}]);
      const resolution=await admin.query("select grounding->>'intent' intent from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_resolution'",
        [cafes[0],threads[0]]);
      expect(resolution.rows).toEqual([{intent:"priority_investigation_resolution"}]);
      // Terminate the claimed second-café investigation by revoking membership.
      await admin.query("delete from public.memberships where business_id=$1 and user_id=$2",
        [cafes[1],owners[1]]);
      expect(await rpc(b,"supervisor_finish_investigation",
        finish(other,"collected",checkpoint,null,stamp(now,7)))).toBe(false);
      // An owner can only see their own investigation, no privilege to write
      // its state, and no access to other cafés or owner-private thread facts.
      const own=await ownerClient.query("select source_id,phase from public.supervisor_investigations");
      expect(own.rows).toEqual([{source_id:alerts[0],phase:"resolved"}]);
      await expect(ownerClient.query("update public.supervisor_investigations set phase='resolved'"))
        .rejects.toThrow();
      // Recovery after a failed source read: durable retries with backoff,
      // no premature success, no blind repeated effect attempts.
      expect(await rpc(a,"supervisor_enqueue_investigation",
        [cafes[0],owners[0],threads[0],"operating_task",taskId,hex("e"),hex("f"),140,stamp(now,8)]))
        .toBe(true);
      const next=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,9)]) as Record<string,unknown>;
      expect(next.source_id).toBe(taskId);
      expect(await rpc(a,"supervisor_fail_investigation",
        [cafes[0],owners[0],"operating_task",taskId,next.lease_token,
          "provider_unavailable",stamp(now,10)])).toBe(true);
      expect(await rpc(a,"supervisor_claim_investigation",[stamp(now,11)])).toBeNull();
      const retry=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,13)]) as Record<string,unknown>;
      expect(retry.source_id).toBe(taskId);
      expect(retry.lease_token).not.toBe(next.lease_token);
      // Simulate crashed worker and lease expiry. A new claim is fenced;
      // the old worker cannot checkpoint after the lease has been replaced.
      expect(await rpc(b,"supervisor_claim_investigation",[stamp(now,14)])).toBeNull();
      const recovered=await rpc(b,"supervisor_claim_investigation",
        [stamp(now,17)]) as Record<string,unknown>;
      expect(recovered.lease_token).not.toBe(retry.lease_token);
      expect(await rpc(a,"supervisor_finish_investigation",
        finish(retry,"collected",checkpoint,null,stamp(now,18)))).toBe(false);
      expect(await rpc(b,"supervisor_finish_investigation",
        finish(recovered,"collected",checkpoint,null,stamp(now,18)))).toBe(true);
      // A repeated model failure is not silently dropped. After five bounded
      // attempts, the source stays open, an owner-visible exception is saved
      // once, and no additional paid/model work is claimed.
      const attempts=[[19,20],[23,24],[29,30],[39,40],[57,58]];
      for(const [claimedAt,failedAt] of attempts){
        const lease=await rpc(a,"supervisor_claim_investigation",
          [stamp(now,claimedAt)]) as Record<string,unknown>;
        expect(lease.phase).toBe("investigate");
        expect(await rpc(a,"supervisor_fail_investigation",[
          cafes[0],owners[0],"operating_task",taskId,lease.lease_token,
          "model_incomplete",stamp(now,failedAt),
        ])).toBe(true);
      }
      const blocked=await admin.query("select phase,last_error,failure_count from public.supervisor_investigations where business_id=$1 and owner_user_id=$2 and source_type='operating_task' and source_id=$3",
        [cafes[0],owners[0],taskId]);
      expect(blocked.rows).toHaveLength(1);
      expect(blocked.rows[0]).toMatchObject({phase:"blocked",last_error:"model_incomplete"});
      // pg returns bigint counters as strings. Check the exact numeric value.
      expect(Number(blocked.rows[0].failure_count)).toBe(5);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_exception'",
        [cafes[0],threads[0]])).rows[0].n).toBe(1);
      expect(await rpc(a,"supervisor_claim_investigation",[stamp(now,120)])).toBeNull();
      // Material source revision, not an arbitrary retry of an uncertain effect,
      // safely reopens investigation with a fresh checkpoint and newer priority.
      expect(await rpc(a,"supervisor_enqueue_investigation",[
        cafes[0],owners[0],threads[0],"operating_task",taskId,
        hex("e"),hex("f"),140,stamp(now,121),
      ])).toBe(false);
      expect(await rpc(a,"supervisor_enqueue_investigation",[
        cafes[0],owners[0],threads[0],"operating_task",taskId,
        hex("8"),hex("9"),220,stamp(now,121),
      ])).toBe(true);
      const reopened=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,122)]) as Record<string,unknown>;
      expect(reopened.phase).toBe("collect");
      expect(reopened.step_version).toBe(0);
      expect(reopened.revision_hash).toBe(hex("8"));
    }finally{
      await Promise.all([a?.end(),b?.end(),ownerClient?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120_000);
});
