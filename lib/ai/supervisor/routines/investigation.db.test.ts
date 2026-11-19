import {randomUUID,createHash} from "node:crypto";
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
    let a:Client|undefined,b:Client|undefined,ownerClient:Client|undefined,closingActor:Client|undefined;
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
      // Bound SQL may attach structured metadata, but NEVER modify, prefix
      // or append prose to the numerically verified model answer.
      const body=await admin.query("select structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation'",
        [cafes[0],threads[0]]);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].structured_content).toEqual([
        {type:"text",text:"Sales and staffing were checked. Both have coverage gaps; ask the owner before any change."},
      ]);
      // Operating Board's SAME owner-private inbox must receive a durable,
      // per-episode/per-step receipt atomically with the chat message.
      const inbox=await admin.query("select id,kind,status,owner_user_id,payload->>'threadId' thread_id,payload->>'intent' intent from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%'",
        [cafes[0]]);
      expect(inbox.rows).toHaveLength(1);
      expect(inbox.rows[0]).toMatchObject({kind:"priority_notice",status:"needs_owner",
        owner_user_id:owners[0],thread_id:threads[0],intent:"priority_investigation"});
      const ownerInbox=await ownerClient.query("select id from public.operating_tasks where kind='priority_notice' and id like 'investigation:%'");
      expect(ownerInbox.rows.map(row=>row.id)).toEqual([inbox.rows[0].id]);
      expect(await rpc(b,"supervisor_claim_investigation",[stamp(now,5)])).toBeNull();
      // A second café can progress independently even with the first waiting.
      expect(await rpc(a,"supervisor_enqueue_investigation",
        enqueue(1,"alert",alerts[1],hex("c"),hex("d")))).toBe(true);
      const other=await rpc(b,"supervisor_claim_investigation",
        [stamp(now,6)]) as Record<string,unknown>;
      expect(other.business_id).toBe(cafes[1]);
      // A source closure is a verified terminal condition, not proof of a POS
      // price change, purchase, staff effect or external message delivery.
      // A real second authenticated owner closes a shared, RLS-authorized
      // source while the assigned investigation owner is offline. They are
      // not authorized to read the assigned owner's private thread.
      closingActor=await connect("owner",owners[1]);
      const foreignClosure=await closingActor.query(
        "update public.alerts set status='dismissed' where business_id=$1 and id=$2",[cafes[0],alerts[0]]);
      expect(foreignClosure.rowCount).toBe(0);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
        [cafes[0],owners[1]]);
      const authorizedClosure=await closingActor.query(
        "update public.alerts set status='dismissed' where business_id=$1 and id=$2",[cafes[0],alerts[0]]);
      expect(authorizedClosure.rowCount).toBe(1);
      const closed=await admin.query("select phase,last_error from public.supervisor_investigations where business_id=$1 and owner_user_id=$2",
        [cafes[0],owners[0]]);
      expect(closed.rows).toEqual([{phase:"resolved",last_error:"source_closed"}]);
      const archivedReport=await admin.query("select status,resolved_at from public.operating_tasks where business_id=$1 and id=$2",
        [cafes[0],inbox.rows[0].id]);
      expect(archivedReport.rows[0]?.status).toBe("handled");
      expect(archivedReport.rows[0]?.resolved_at).not.toBeNull();
      const staleOwnerActions=await ownerClient.query("select count(*)::int n from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%' and status='needs_owner'",
        [cafes[0]]);
      expect(staleOwnerActions.rows).toEqual([{n:0}]);
      const resolution=await admin.query("select grounding->>'intent' intent from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_resolution'",
        [cafes[0],threads[0]]);
      expect(resolution.rows).toEqual([{intent:"priority_investigation_resolution"}]);
      expect((await closingActor.query("select id from public.ai_messages where business_id=$1 and thread_id=$2",
        [cafes[0],threads[0]])).rows).toEqual([]);
      await closingActor.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [cafes[0],alerts[0]]);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_resolution'",
        [cafes[0],threads[0]])).rows).toEqual([{n:1}]);
      await admin.query("delete from public.memberships where business_id=$1 and user_id=$2",
        [cafes[0],owners[1]]);
      // Terminate the claimed second-café investigation by revoking membership.
      await admin.query("delete from public.memberships where business_id=$1 and user_id=$2",
        [cafes[1],owners[1]]);
      // Revocation must not be laundered through source settlement into a
      // private resolution message for the now-unauthorized recipient.
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [cafes[1],alerts[1]]);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_resolution'",
        [cafes[1],threads[1]])).rows).toEqual([{n:0}]);
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
      expect(blocked.rows[0]).toMatchObject({phase:"investigate",last_error:"model_incomplete"});
      // pg returns bigint counters as strings. Check the exact numeric value.
      expect(Number(blocked.rows[0].failure_count)).toBe(5);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_exception'",
        [cafes[0],threads[0]])).rows[0].n).toBe(1);
      expect(await rpc(a,"supervisor_claim_investigation",[stamp(now,120)])).toBeNull();
      // Source evidence did not change, but provider recovery MUST resume
      // automatically after the long cooldown; the warning remains one message.
      const automaticRetry=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,500)]) as Record<string,unknown>;
      expect(automaticRetry.source_id).toBe(taskId);
      expect(automaticRetry.phase).toBe("investigate");
      expect(await rpc(a,"supervisor_fail_investigation",[
        cafes[0],owners[0],"operating_task",taskId,automaticRetry.lease_token,
        "provider_unavailable",stamp(now,501),
      ])).toBe(true);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and thread_id=$2 and grounding->>'intent'='priority_investigation_exception'",
        [cafes[0],threads[0]])).rows[0].n).toBe(1);
      // Material source revision, not an arbitrary retry of an uncertain effect,
      // safely reopens investigation with a fresh checkpoint and newer priority.
      expect(await rpc(a,"supervisor_enqueue_investigation",[
        cafes[0],owners[0],threads[0],"operating_task",taskId,
        hex("e"),hex("f"),140,stamp(now,502),
      ])).toBe(false);
      expect(await rpc(a,"supervisor_enqueue_investigation",[
        cafes[0],owners[0],threads[0],"operating_task",taskId,
        hex("8"),hex("9"),220,stamp(now,502),
      ])).toBe(true);
      const reopened=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,503)]) as Record<string,unknown>;
      expect(reopened.phase).toBe("collect");
      expect(reopened.step_version).toBe(0);
      expect(reopened.revision_hash).toBe(hex("8"));
      // A disappearing source is not evidence of resolution; its owner must
      // never receive a false success receipt. Reappearance is recoverable
      // even when the source ID and evidence revision have not changed.
      const vanished=randomUUID();
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [vanished,cafes[0]]);
      const original=[cafes[0],owners[0],threads[0],"alert",vanished,
        hex("2"),hex("3"),330,stamp(now,504)];
      expect(await rpc(a,"supervisor_enqueue_investigation",original)).toBe(true);
      await admin.query("delete from public.alerts where business_id=$1 and id=$2",
        [cafes[0],vanished]);
      expect(await rpc(a,"supervisor_claim_investigation",[stamp(now,505)])).toBeNull();
      const missing=await admin.query("select phase,last_error from public.supervisor_investigations where business_id=$1 and source_type='alert' and source_id=$2",
        [cafes[0],vanished]);
      expect(missing.rows).toEqual([{phase:"blocked",last_error:"source_missing"}]);
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [vanished,cafes[0]]);
      expect(await rpc(a,"supervisor_enqueue_investigation",[
        ...original.slice(0,8),stamp(now,506),
      ])).toBe(true);
      const revived=await rpc(a,"supervisor_claim_investigation",
        [stamp(now,507)]) as Record<string,unknown>;
      expect(revived.source_id).toBe(vanished);
      expect(revived.phase).toBe("collect");
    }finally{
      await Promise.all([a?.end(),b?.end(),ownerClient?.end(),closingActor?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120_000);
  (sandbox?it:it.skip)("Codex P1: source reassignment or deletion between model read and fenced commit cannot publish",async()=>{
    const admin=await connect("postgres");
    let service:Client|undefined;
    const business=randomUUID(),owners=[randomUUID(),randomUUID()];
    const thread=randomUUID(),taskOne="race-assignment:"+randomUUID();
    const taskTwo="race-deletion:"+randomUUID(),alertId=randomUUID();
    const now=new Date(),revision=hex("d"),source={
      kind:"data_quality",status:"needs_owner",severity:null,quality:"partial",
      relatedAlerts:[],relatedTasks:["data_quality"],
    };
    try{
      for(const owner of owners){
        await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
          [owner,"15a-source-race-"+owner+"@example.invalid"]);
      }
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable source race café','America/Los_Angeles',false)",[business]);
      for(const owner of owners){
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
          [business,owner]);
      }
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,business,owners[0],randomUUID()]);
      for(const id of [taskOne,taskTwo]){
        await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values ($1,$2,'leo','data_quality','needs_owner','{}','low','[]',$3)",
          [business,id,owners[0]]);
      }
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [alertId,business]);
      service=await connect("service");
      const acquire=async(kind:"alert"|"operating_task",sourceId:string,minute:number,priority:number)=>{
        expect(await rpc(service!,"supervisor_enqueue_investigation",[
          business,owners[0],thread,kind,sourceId,revision,hex("e"),priority,stamp(now,minute),
        ])).toBe(true);
        const collecting=await rpc(service!,"supervisor_claim_investigation",
          [stamp(now,minute)]) as Record<string,unknown>;
        expect(collecting).toMatchObject({source_type:kind,source_id:sourceId,phase:"collect"});
        const checkpoint={source,collectedAt:stamp(now,minute)};
        expect(await rpc(service!,"supervisor_finish_investigation",[
          business,owners[0],thread,kind,sourceId,revision,collecting.lease_token,
          "collected",JSON.stringify(checkpoint),null,stamp(now,minute+1),
        ])).toBe(true);
        const investigating=await rpc(service!,"supervisor_claim_investigation",
          [stamp(now,minute+2)]) as Record<string,unknown>;
        expect(investigating).toMatchObject({source_type:kind,source_id:sourceId,
          phase:"investigate",step_version:1});
        return {investigating,checkpoint};
      };
      const rejectReport=async(kind:"alert"|"operating_task",sourceId:string,
        investigating:Record<string,unknown>,checkpoint:Record<string,unknown>,minute:number)=>{
        expect(await rpc(service!,"supervisor_finish_investigation",[
          business,owners[0],thread,kind,sourceId,revision,investigating.lease_token,
          "investigated",JSON.stringify(checkpoint),
          "Old owner cannot receive stale source evidence.",stamp(now,minute),
        ])).toBe(false);
        const saved=await admin.query("select step_version,phase from public.supervisor_investigations where business_id=$1 and owner_user_id=$2 and source_type=$3 and source_id=$4",
          [business,owners[0],kind,sourceId]);
        // pg returns bigint fields as text: preserve the exact version and phase assertion.
        expect(saved.rows.map(row=>({...row,step_version:Number(row.step_version)})))
          .toEqual([{step_version:1,phase:"investigate"}]);
        const outputs=await admin.query("select (select count(*)::int from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%') inbox, (select count(*)::int from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation') reports",
          [business]);
        expect(outputs.rows).toEqual([{inbox:0,reports:0}]);
      };
      // The same café has two owners, but the claimed source is private.
      // An ownership-only UPDATE deliberately does not fire the status trigger.
      const a=await acquire("operating_task",taskOne,1,300);
      await admin.query("update public.operating_tasks set owner_user_id=$1 where business_id=$2 and id=$3",
        [owners[1],business,taskOne]);
      await rejectReport("operating_task",taskOne,a.investigating,a.checkpoint,4);

      // A deleted task is not a resolved finding, nor permission to publish
      // the model's report for an object that no longer exists.
      const b=await acquire("operating_task",taskTwo,10,320);
      await admin.query("delete from public.operating_tasks where business_id=$1 and id=$2",
        [business,taskTwo]);
      await rejectReport("operating_task",taskTwo,b.investigating,b.checkpoint,13);

      // Alert deletion must satisfy the same source-presence fence.
      const c=await acquire("alert",alertId,20,340);
      await admin.query("delete from public.alerts where business_id=$1 and id=$2",
        [business,alertId]);
      await rejectReport("alert",alertId,c.investigating,c.checkpoint,23);
    }finally{
      await service?.end();
      await admin.query("delete from public.businesses where id=$1",[business]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120_000);
  (sandbox?it:it.skip)("Codex P1: watching is NOT an applied effect; resolved identical source must reactivate",async()=>{
    const admin=await connect("postgres");
    let service:Client|undefined;
    const owner=randomUUID(),business=randomUUID(),thread=randomUUID();
    const taskId="price_review:"+randomUUID();
    const now=new Date(),revision=hex("9"),stable=hex("b");
    const input=(at:number)=>[business,owner,thread,"operating_task",taskId,
      revision,stable,235,stamp(now,at)];
    const decisionPayload={
      suggestedPriceCents:540,ownerChoice:"use_price",
      awaitingPriceApplication:true,priceAppliedToPos:false,
    };
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [owner,"investigation-watch-"+owner+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Watch transition café','America/Los_Angeles',false)",[business]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
        [business,owner]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,business,owner,randomUUID()]);
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values ($1,$2,'leo','price_review','needs_owner',$3,'high','[]',$4)",
        [business,taskId,JSON.stringify(decisionPayload),owner]);
      service=await connect("service");
      expect(await rpc(service,"supervisor_enqueue_investigation",input(1))).toBe(true);
      const claim=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,2)]) as Record<string,unknown>;
      expect(claim.source_id).toBe(taskId);
      expect(claim.phase).toBe("collect");
      const checkpoint={source:{kind:"price_review",status:"needs_owner",
        severity:null,quality:"high",relatedAlerts:[],relatedTasks:["price_review"]},
        collectedAt:stamp(now,2)};
      const saved=await rpc(service,"supervisor_finish_investigation",[
        business,owner,thread,"operating_task",taskId,revision,
        claim.lease_token,"collected",JSON.stringify(checkpoint),null,stamp(now,3),
      ]);
      expect(saved).toBe(true);
      // Owner accepted a recommendation but the POS has not applied it.
      await admin.query("update public.operating_tasks set status='watching',payload=$3 where business_id=$1 and id=$2",
        [business,taskId,JSON.stringify(decisionPayload)]);
      const watching=await admin.query("select phase from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(watching.rows).toEqual([{phase:"investigate"}]);
      // A task already in Watching before the first cron observation is
      // eligible for autonomous monitoring; no fresh generic notice is sent.
      const lateWatching="price_review:watching:"+randomUUID();
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values ($1,$2,'leo','price_review','watching',$3,'high','[]',$4)",
        [business,lateWatching,JSON.stringify(decisionPayload),owner]);
      expect(await rpc(service,"supervisor_enqueue_investigation",[
        business,owner,thread,"operating_task",lateWatching,
        hex("4"),hex("5"),0,stamp(now,4),
      ])).toBe(true);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'",
        [business])).rows[0].n).toBe(0);
      // The existing lease/claim path must still investigate watching work.
      const unfinished=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,4)]) as Record<string,unknown>;
      expect(unfinished.source_id).toBe(taskId);
      expect(unfinished.phase).toBe("investigate");
      // First episode publishes a genuine owner-facing analysis, so a second
      // episode that resets step_version MUST NOT silently dedupe this message.
      expect(await rpc(service,"supervisor_finish_investigation",[
        business,owner,thread,"operating_task",taskId,revision,
        unfinished.lease_token,"investigated",JSON.stringify(checkpoint),
        "First episode: price application remains unverified; ask owner to confirm POS receipt.",
        stamp(now,5),
      ])).toBe(true);
      const firstMessages=await admin.query(
        "select id from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation'",
        [business]);
      expect(firstMessages.rows).toHaveLength(1);
      // The SAME OWNER-CLICK effect gateway remains the only authority to
      // authorize a price recommendation. Even after approval, Toast's menu
      // API is read-only: the verified receipt is MANUAL_PENDING, not a
      // fabricated price application or a reason to resolve the source.
      const proposal=randomUUID();
      const effect={itemId:randomUUID(),newPriceCents:540};
      const effectHash=createHash("sha256").update(JSON.stringify(effect)+proposal)
        .digest("hex");
      await admin.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) values($1,$2,$3,$4,$5,'alex.menu_price_change.v1',1,$6::jsonb,$7,$8::jsonb,$9::jsonb,'en')",
        [proposal,business,owner,thread,randomUUID(),JSON.stringify(effect),
          effectHash,JSON.stringify({source:"verified_menu_price"}),
          JSON.stringify({durationDays:1,metricScope:"manual_price"})]);
      await expect(rpc(service,"supervisor_claim_effect",[
        business,owner,thread,proposal,1,"click",
      ])).rejects.toThrow();
      const approval=await rpc(service,"supervisor_transition_proposal",[
        business,owner,proposal,1,"approve",null,
      ]) as Record<string,unknown>;
      expect(approval).toMatchObject({status:"approved",revision:2});
      const effectClaim=await rpc(service,"supervisor_claim_effect",[
        business,owner,thread,proposal,2,"click",
      ]) as Record<string,unknown>;
      expect(effectClaim).toMatchObject({authorization_kind:"click",
        proposal:expect.objectContaining({status:"executing"})});
      const attempt=effectClaim.attempt_key as string;
      const verified=await rpc(service,"supervisor_finish_effect_attempt",[
        business,owner,thread,proposal,attempt,
        (effectClaim.proposal as Record<string,unknown>).revision,
        "verified","manual_pending",null,
      ]) as Record<string,unknown>;
      expect(verified).toMatchObject({status:"manual_pending"});
      const audit=await admin.query("select state,authorization_kind from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",
        [business,proposal]);
      expect(audit.rows).toEqual([{state:"verified",authorization_kind:"click"}]);
      const stillOpen=await admin.query("select status from public.operating_tasks where business_id=$1 and id=$2",
        [business,taskId]);
      expect(stillOpen.rows).toEqual([{status:"watching"}]);
      const stillInvestigating=await admin.query("select phase from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(stillInvestigating.rows).toEqual([{phase:"awaiting_owner"}]);
      await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",
        [business,taskId]);
      const closed=await admin.query("select phase,last_error from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(closed.rows).toEqual([{phase:"resolved",last_error:"source_closed"}]);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'",
        [business])).rows[0].n).toBe(1);
      // Deterministic source recurrence may have EXACTLY the same hash.
      await admin.query("update public.operating_tasks set status='needs_owner' where business_id=$1 and id=$2",
        [business,taskId]);
      expect(await rpc(service,"supervisor_enqueue_investigation",input(5))).toBe(true);
      const restarted=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,6)]) as Record<string,unknown>;
      expect(restarted.source_id).toBe(taskId);
      expect(restarted.phase).toBe("collect");
      expect(restarted.step_version).toBe(0);
      expect(restarted.episode_id).not.toBe(claim.episode_id);
      expect(await rpc(service,"supervisor_enqueue_investigation",input(7))).toBe(false);
      expect(await rpc(service,"supervisor_finish_investigation",[
        business,owner,thread,"operating_task",taskId,revision,
        restarted.lease_token,"collected",JSON.stringify(checkpoint),null,stamp(now,7),
      ])).toBe(true);
      const recheck=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,8)]) as Record<string,unknown>;
      expect(recheck.source_id).toBe(taskId);
      expect(recheck.episode_id).toBe(restarted.episode_id);
      expect(await rpc(service,"supervisor_finish_investigation",[
        business,owner,thread,"operating_task",taskId,revision,
        recheck.lease_token,"investigated",JSON.stringify(checkpoint),
        "Second episode: this same price issue recurred. POS application is still unverified.",
        stamp(now,9),
      ])).toBe(true);
      const episodeMessages=await admin.query(
        "select id from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation'",
        [business]);
      expect(episodeMessages.rows).toHaveLength(2);
      const episodeInbox=await admin.query("select id from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%' order by id",
        [business]);
      expect(episodeInbox.rows).toHaveLength(2);
      expect(new Set(episodeInbox.rows.map(row=>row.id)).size).toBe(2);
      expect(new Set(episodeMessages.rows.map(row=>row.id)).size).toBe(2);
      // Both episode receipts are immutable history; only the current episode
      // must remain owner-actionable after the prior source was handled.
      const beforeFinalClose=await admin.query("select status from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%' order by status",
        [business]);
      expect(beforeFinalClose.rows).toEqual([
        {status:"handled"},{status:"needs_owner"},
      ]);
      await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",
        [business,taskId]);
      const afterFinalClose=await admin.query("select id,status,resolved_at from public.operating_tasks where business_id=$1 and kind='priority_notice' and id like 'investigation:%'",
        [business]);
      expect(afterFinalClose.rows).toHaveLength(2);
      expect(afterFinalClose.rows.every(row=>row.status==="handled"&&row.resolved_at!==null)).toBe(true);
      const resolutionMessages=await admin.query(
        "select id from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'",
        [business]);
      expect(resolutionMessages.rows).toHaveLength(2);
      expect(new Set(resolutionMessages.rows.map(row=>row.id)).size).toBe(2);
    }finally{
      await service?.end();
      await admin.query("delete from public.businesses where id=$1",[business]);
      await admin.query("delete from auth.users where id=$1",[owner]);
      await admin.end();
    }
  },120_000);
  (sandbox?it:it.skip)("Codex P2: all same-episode daily reports settle on source closure; superseding revision archives old reports",async()=>{
    const admin=await connect("postgres");
    let service:Client|undefined;
    const owner=randomUUID(),business=randomUUID(),thread=randomUUID(),alert=randomUUID();
    const now=new Date(),revision=hex("a"),stable=hex("b");
    const evidence={source:{kind:"meal_break",status:"new",severity:"high",
      quality:"verified",relatedAlerts:["meal_break"],relatedTasks:[]},
      collectedAt:stamp(now,2)};
    const enqueue=(rev:string,key:string,minute:number)=>
      [business,owner,thread,"alert",alert,rev,key,230,stamp(now,minute)];
    const finish=(claim:Record<string,unknown>,outcome:string,
      narrative:string|null,minute:number)=>[
      business,owner,thread,"alert",alert,claim.revision_hash,
      claim.lease_token,outcome,JSON.stringify(evidence),narrative,stamp(now,minute),
    ];
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [owner,"investigation-closure-"+owner+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Closure café','America/Los_Angeles',false)",[business]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
        [business,owner]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,business,owner,randomUUID()]);
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [alert,business]);
      service=await connect("service");
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(revision,stable,1)))
        .toBe(true);
      const first=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,2)]) as Record<string,unknown>;
      expect(first.phase).toBe("collect");
      expect(await rpc(service,"supervisor_finish_investigation",
        finish(first,"collected",null,3))).toBe(true);
      const investigating=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,4)]) as Record<string,unknown>;
      expect(investigating.phase).toBe("investigate");
      expect(await rpc(service,"supervisor_finish_investigation",
        finish(investigating,"investigated",
          "The timecard evidence is incomplete; ask the owner for the missing actuals.",5)))
        .toBe(true);
      // Only the calendar is advanced: the durable queue itself decides when
      // the next unattended follow-up may run, with no new owner message.
      const following=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,6*60+6)]) as Record<string,unknown>;
      expect(following.phase).toBe("awaiting_owner");
      expect(following.episode_id).toBe(first.episode_id);
      expect(await rpc(service,"supervisor_finish_investigation",
        finish(following,"followed_up",
          "Still awaiting confirmed labor coverage; no schedule change has been made.",6*60+7)))
        .toBe(true);
      // A different, unrelated owner-private notice must NOT be rewritten by
      // settlement of this exact alert.
      const unrelated="investigation:unrelated:"+randomUUID();
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values($1,$2,'leo','priority_notice','needs_owner',$3::jsonb,'high','[]',$4)",
        [business,unrelated,JSON.stringify({intent:"priority_investigation",
          sourceType:"alert",sourceId:randomUUID(),episodeId:randomUUID()}),owner]);
      const before=await admin.query("select id,status,payload->>'episodeId' episode from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2 order by id",
        [business,alert]);
      expect(before.rows).toHaveLength(2);
      expect(before.rows.every(row=>row.status==="needs_owner"&&
        row.episode===first.episode_id)).toBe(true);
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [business,alert]);
      const closed=await admin.query("select id,status,resolved_at from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2",
        [business,alert]);
      expect(closed.rows).toHaveLength(2);
      expect(closed.rows.every(row=>row.status==="handled"&&row.resolved_at!==null))
        .toBe(true);
      expect((await admin.query("select status from public.operating_tasks where business_id=$1 and id=$2",
        [business,unrelated])).rows).toEqual([{status:"needs_owner"}]);
      const resolution=await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'",
        [business]);
      expect(resolution.rows).toEqual([{n:1}]);
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [business,alert]);
      expect((await admin.query("select count(*)::int n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'",
        [business])).rows).toEqual([{n:1}]);

      // Reopening with new source evidence creates a fresh episode and one
      // actionable report. A later material revision supersedes that report
      // while preserving all three archived receipts for owner history.
      await admin.query("update public.alerts set status='new' where business_id=$1 and id=$2",
        [business,alert]);
      expect(await rpc(service,"supervisor_enqueue_investigation",
        enqueue(hex("c"),hex("d"),6*60+8))).toBe(true);
      const renewed=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,6*60+9)]) as Record<string,unknown>;
      expect(renewed.episode_id).not.toBe(first.episode_id);
      expect(await rpc(service,"supervisor_finish_investigation",
        finish(renewed,"collected",null,6*60+10))).toBe(true);
      const renewedInvestigation=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,6*60+11)]) as Record<string,unknown>;
      expect(await rpc(service,"supervisor_finish_investigation",
        finish(renewedInvestigation,"investigated",
          "A new issue is now open; the owner needs a fresh review.",6*60+12)))
        .toBe(true);
      const newOpen=await admin.query("select id,status from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2 and status='needs_owner'",
        [business,alert]);
      expect(newOpen.rows).toHaveLength(1);
      expect(await rpc(service,"supervisor_enqueue_investigation",
        enqueue(hex("e"),hex("f"),6*60+13))).toBe(true);
      const archived=await admin.query("select id,status,resolved_at from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2",
        [business,alert]);
      expect(archived.rows).toHaveLength(3);
      expect(archived.rows.every(row=>row.status==="handled"&&row.resolved_at!==null))
        .toBe(true);
      expect((await admin.query("select status from public.operating_tasks where business_id=$1 and id=$2",
        [business,unrelated])).rows).toEqual([{status:"needs_owner"}]);
    }finally{
      await service?.end();
      await admin.query("delete from public.businesses where id=$1",[business]);
      await admin.query("delete from auth.users where id=$1",[owner]);
      await admin.end();
    }
  },120_000);


  (sandbox?it:it.skip)("Codex P2: unchanged blocked source restarts only after ownership and membership are restored",async()=>{
    const admin=await connect("postgres");
    let service:Client|undefined;
    const owners=[randomUUID(),randomUUID()],business=randomUUID(),thread=randomUUID();
    const taskId="recovery:"+randomUUID(),now=new Date(),revision=hex("a");
    const enqueue=(minute:number)=>[business,owners[0],thread,"operating_task",
      taskId,revision,hex("b"),240,stamp(now,minute)];
    const checkpoint={source:{kind:"staff_coverage",status:"needs_owner",
      severity:null,quality:"verified",relatedAlerts:[],relatedTasks:["staff_coverage"]},
      collectedAt:stamp(now,2)};
    try{
      for(const owner of owners)
        await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
          [owner,"15a-blocked-recovery-"+owner+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Recovery café','America/Los_Angeles',false)",[business]);
      for(const owner of owners)
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
          [business,owner]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,business,owners[0],randomUUID()]);
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence,owner_user_id) values ($1,$2,'leo','staff_coverage','needs_owner','{}','high','[]',$3)",
        [business,taskId,owners[0]]);
      service=await connect("service");
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(1))).toBe(true);
      const first=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,2)]) as Record<string,unknown>;
      expect(first).toMatchObject({phase:"collect",source_id:taskId});
      expect(await rpc(service,"supervisor_finish_investigation",[
        business,owners[0],thread,"operating_task",taskId,revision,
        first.lease_token,"collected",JSON.stringify(checkpoint),null,stamp(now,3),
      ])).toBe(true);
      // Temporarily reassign a still-open source; no stale owner report.
      await admin.query("update public.operating_tasks set owner_user_id=$1 where business_id=$2 and id=$3",
        [owners[1],business,taskId]);
      expect(await rpc(service,"supervisor_claim_investigation",
        [stamp(now,4)])).toBeNull();
      const blocked=await admin.query("select phase,last_error,episode_id from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(blocked.rows[0]).toMatchObject({phase:"blocked",last_error:"source_reassigned"});
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(5))).toBe(false);
      // Returning to the original owner with identical revision resets one
      // episode exactly once, never bypassing the source authorization fence.
      await admin.query("update public.operating_tasks set owner_user_id=$1 where business_id=$2 and id=$3",
        [owners[0],business,taskId]);
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(5))).toBe(true);
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(5))).toBe(false);
      const restarted=await admin.query("select phase,last_error,episode_id,step_version::integer step_version,evidence from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(restarted.rows[0]).toMatchObject({phase:"collect",last_error:null,
        step_version:0,evidence:{}});
      expect(restarted.rows[0].episode_id).not.toBe(blocked.rows[0].episode_id);
      const next=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,6)]) as Record<string,unknown>;
      expect(next).toMatchObject({phase:"collect",source_id:taskId});
      expect(await rpc(service,"supervisor_finish_investigation",[
        business,owners[0],thread,"operating_task",taskId,revision,
        next.lease_token,"collected",JSON.stringify(checkpoint),null,stamp(now,7),
      ])).toBe(true);
      // Independently revoke membership; no work or enqueue is permitted.
      await admin.query("delete from public.memberships where business_id=$1 and user_id=$2",
        [business,owners[0]]);
      expect(await rpc(service,"supervisor_claim_investigation",
        [stamp(now,8)])).toBeNull();
      const denied=await admin.query("select phase,last_error,episode_id from public.supervisor_investigations where business_id=$1 and source_id=$2",
        [business,taskId]);
      expect(denied.rows[0]).toMatchObject({phase:"blocked",last_error:"authorization_revoked"});
      await expect(rpc(service,"supervisor_enqueue_investigation",enqueue(9)))
        .rejects.toThrow();
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",
        [business,owners[0]]);
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(9))).toBe(true);
      expect(await rpc(service,"supervisor_enqueue_investigation",enqueue(9))).toBe(false);
      const renewed=await rpc(service,"supervisor_claim_investigation",
        [stamp(now,10)]) as Record<string,unknown>;
      expect(renewed).toMatchObject({phase:"collect",source_id:taskId,step_version:0});
      expect(renewed.episode_id).not.toBe(denied.rows[0].episode_id);
      const reports=await admin.query("select (select count(*)::integer from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation') messages,(select count(*)::integer from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'intent'='priority_investigation') notices",
        [business]);
      expect(reports.rows).toEqual([{messages:0,notices:0}]);
    }finally{
      await service?.end();
      await admin.query("delete from public.businesses where id=$1",[business]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120_000);

});
