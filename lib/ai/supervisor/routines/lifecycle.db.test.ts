import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

// Disposable migrated database only (never a real café database).
const sandbox=process.env.SUPERVISOR_LIFECYCLE_DB_SANDBOX_ONLY==="1";
const url=process.env.SUPERVISOR_LIFECYCLE_DB_URL??"";
if(sandbox){
  const parsed=new URL(url);
  if(!["localhost","127.0.0.1"].includes(parsed.hostname)||parsed.port!=="54322"||parsed.pathname!=="/postgres")
    throw new Error("lifecycle test rejects a non-disposable database");
}
async function connect(){
  const db=new Client({connectionString:url});await db.connect();
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("set role service_role");
  return db;
}
const rpc=(db:Client,name:string,args:unknown[])=>
  db.query("select to_jsonb(public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+")) as result",args).then(r=>r.rows[0]?.result??null);
const hex=(c:string)=>c.repeat(64);
const key=(label:string)=>createHash("sha256").update(label+randomUUID()).digest("hex");
const stamp=(d:Date,minutes=0)=>new Date(d.getTime()+minutes*60_000).toISOString();
const REASON="Actionable café alert needs review";

describe.skipIf(!sandbox)("background lifecycle on the migrated database",()=>{
  it("keeps system conditions out of notices and investigations, posts one notice per waiting item, closes silently, never posts technical failures",async()=>{
    const admin=new Client({connectionString:url});await admin.connect();
    const service=await connect();
    const cafe=randomUUID(),owner=randomUUID(),thread=randomUUID(),now=new Date();
    const alert=async(kind:string,payload:Record<string,unknown>)=>{
      const id=randomUUID();
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,$3,'new',$4)",[id,cafe,kind,JSON.stringify(payload)]);
      return id;
    };
    // Each revision of each source has its own stable key, as in production.
    const keys=new Map<string,string>();
    const stable=(source:string,rev:string)=>{const k=source+rev;if(!keys.has(k))keys.set(k,key(k));return keys.get(k)!;};
    const notice=(source:string,rev:string,type="alert")=>rpc(service,"post_supervisor_priority_notice",
      [cafe,owner,thread,type,source,hex(rev),stable(source,rev),REASON,stamp(now)]);
    const enqueue=(source:string,rev:string)=>rpc(service,"supervisor_enqueue_investigation",[cafe,owner,thread,"alert",source,rev,rev,200,stamp(now)]);
    const count=async(sql:string,args:unknown[]=[cafe])=>Number((await admin.query(sql,args)).rows[0].n);
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Lifecycle café','America/Los_Angeles',false)",[cafe]);
      await admin.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc,state) values ($1,'https://example.invalid','fixture-client','fixture-placeholder','verified')",[cafe]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafe,owner]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[thread,cafe,owner,randomUUID()]);

      // 1. A reader outage and import lag are system conditions: no notice, no chat message, no investigation.
      const outage=await alert("business_anomaly",{family:"data_gap",subject:"reader_unavailable:expenses",quality:"missing",dedupeKey:"data_gap:reader_unavailable:expenses"});
      const lag=await alert("business_anomaly",{family:"data_gap",subject:"sales_coverage",quality:"missing",dedupeKey:"data_gap:sales_coverage"});
      for(const id of [outage,lag]){
        expect(await notice(id,"a")).toBe(false);
        expect(await enqueue(id,hex("a"))).toBe(false);
      }
      expect(await count("select count(*) n from public.operating_tasks where business_id=$1 and kind='priority_notice'")).toBe(0);
      expect(await count("select count(*) n from public.ai_messages where business_id=$1")).toBe(0);
      expect(await count("select count(*) n from public.supervisor_investigations where business_id=$1")).toBe(0);

      // 2. Real business alerts, and gaps only the owner can fill, are announced once and may be investigated.
      const wages=await alert("business_anomaly",{family:"data_gap",subject:"actual_wage_coverage",quality:"missing",dedupeKey:"data_gap:actual_wage_coverage"});
      const mealBreak=await alert("meal_break",{dedupeKey:randomUUID()});
      expect(await notice(wages,"a")).toBe(true);
      expect(await notice(mealBreak,"a")).toBe(true);
      expect(await count("select count(*) n from public.ai_messages where business_id=$1")).toBe(2);

      // 3. Waiting for the owner: new evidence does not announce the same item again.
      expect(await notice(mealBreak,"b")).toBe(false);
      expect(await notice(mealBreak,"c")).toBe(false);
      expect(await count("select count(*) n from public.operating_tasks where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2",[cafe,mealBreak])).toBe(1);
      expect(await count("select count(*) n from public.ai_messages where business_id=$1")).toBe(2);
      // Once the owner has handled it, a later change may notify again.
      await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and kind='priority_notice' and payload->>'sourceId'=$2",[cafe,mealBreak]);
      expect(await notice(mealBreak,"d")).toBe(true);

      // 4. A source that closes settles every open notice for it, silently when the owner was not asked a question.
      await admin.query("update public.alerts set status='resolved' where id=$1",[wages]);
      expect(await count("select count(*) n from public.operating_tasks where business_id=$1 and kind='priority_notice' and status='needs_owner' and payload->>'sourceId'=$2",[cafe,wages])).toBe(0);
      expect(await count("select count(*) n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'")).toBe(0);

      // 5. Closing while the owner was asked a question still tells them once.
      expect(await enqueue(mealBreak,hex("d"))).toBe(true);
      await admin.query("update public.supervisor_investigations set phase='awaiting_owner',pending_question_id=$3 where business_id=$1 and source_id=$2",[cafe,mealBreak,randomUUID()]);
      await admin.query("update public.alerts set status='resolved' where id=$1",[mealBreak]);
      expect(await count("select count(*) n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_resolution'")).toBe(1);
      expect(await count("select count(*) n from public.operating_tasks where business_id=$1 and kind='priority_notice' and status='needs_owner'")).toBe(0);

      // 6. Repeated technical failures are recorded on the row and never posted into the chat.
      const another=await alert("meal_break",{dedupeKey:randomUUID()});
      expect(await enqueue(another,hex("a"))).toBe(true);
      for(let i=0;i<3;i++){
        const claim=await rpc(service,"supervisor_claim_investigation",[stamp(now,10+i*90)]) as Record<string,unknown>|null;
        expect(claim).not.toBeNull();
        expect(await rpc(service,"supervisor_fail_investigation",[cafe,owner,"alert",another,claim!.lease_token,"model_incomplete",stamp(now,10+i*90)])).toBe(true);
      }
      expect((await admin.query("select phase,last_error,failure_count from public.supervisor_investigations where business_id=$1 and source_id=$2",[cafe,another])).rows[0])
        .toMatchObject({phase:"blocked",last_error:"model_incomplete"});
      expect(await count("select count(*) n from public.ai_messages where business_id=$1 and grounding->>'intent'='priority_investigation_exception'")).toBe(0);
      // Identical evidence never wakes a blocked investigation.
      expect(await enqueue(another,hex("a"))).toBe(false);
      expect(await rpc(service,"supervisor_claim_investigation",[stamp(now,5000)])).toBeNull();
    }finally{
      await service.end();
      await admin.query("delete from public.operating_tasks where business_id=$1",[cafe]);
      await admin.query("delete from public.ai_messages where business_id=$1",[cafe]);
      await admin.query("delete from public.supervisor_investigations where business_id=$1",[cafe]);
      await admin.query("delete from public.alerts where business_id=$1",[cafe]);
      await admin.query("delete from public.ai_threads where business_id=$1",[cafe]);
      await admin.query("delete from public.toast_api_credentials where business_id=$1",[cafe]);
      await admin.query("delete from public.memberships where business_id=$1",[cafe]);
      await admin.query("delete from public.businesses where id=$1",[cafe]);
      await admin.query("delete from auth.users where id=$1",[owner]);
      await admin.end();
    }
  });

  it("clears the existing backlog: stale and duplicate notices, closed and unrunnable investigations",async()=>{
    const admin=new Client({connectionString:url});await admin.connect();
    const verified=randomUUID(),unverified=randomUUID(),owner=randomUUID(),thread=randomUUID();
    const hygiene=readFileSync("supabase/migrations/20261125010105_background_lifecycle.sql","utf8").split("-- (1) Notices")[1].replace(/^[^\n]*\n/u,"");
    const ids={resolved:randomUUID(),technical:randomUUID(),open:randomUUID(),gated:randomUUID()};
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
      for(const cafe of [verified,unverified]){
        await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Backlog café','UTC',false)",[cafe]);
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafe,owner]);
        await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[cafe===verified?thread:randomUUID(),cafe,owner,randomUUID()]);
      }
      await admin.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc,state) values ($1,'https://example.invalid','fixture-client','fixture-placeholder','verified')",[verified]);
      const alert=(id:string,cafe:string,status:string,payload:unknown)=>admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,$3,$4,$5)",
        [id,cafe,(payload as {family?:string}).family?"business_anomaly":"meal_break",status,JSON.stringify(payload)]);
      await alert(ids.resolved,verified,"resolved",{dedupeKey:"x"});
      await alert(ids.technical,verified,"new",{family:"data_gap",subject:"reader_unavailable:refunds"});
      await alert(ids.open,verified,"new",{dedupeKey:"y"});
      await alert(ids.gated,unverified,"new",{dedupeKey:"z"});
      const task=(cafe:string,id:string,source:string,created:string)=>admin.query(
        "insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,evidence,created_at) values ($1,$2,$3,'leo','priority_notice','needs_owner',$4,'high','[]',$5)",
        [cafe,id,owner,JSON.stringify({sourceType:"alert",sourceId:source}),created]);
      await task(verified,"n-resolved",ids.resolved,"2026-11-20T00:00:00Z");
      await task(verified,"n-technical",ids.technical,"2026-11-20T00:00:00Z");
      await task(verified,"n-open-old",ids.open,"2026-11-20T00:00:00Z");
      await task(verified,"n-open-new",ids.open,"2026-11-21T00:00:00Z");
      const inv=(cafe:string,source:string,phase:string)=>admin.query(
        "insert into public.supervisor_investigations(business_id,owner_user_id,thread_id,source_type,source_id,revision_hash,stable_key,priority,phase,next_retry_at) select $1,$2,t.id,'alert',$3,$4,$4,200,$5,now()-interval '2 days' from public.ai_threads t where t.business_id=$1",
        [cafe,owner,source,hex("a"),phase]);
      await inv(verified,ids.technical,"investigate");
      await inv(unverified,ids.gated,"investigate");
      await admin.query(hygiene);
      const states=Object.fromEntries((await admin.query("select id,status from public.operating_tasks where id like 'n-%'")).rows.map(r=>[r.id,r.status]));
      expect(states).toEqual({"n-resolved":"handled","n-technical":"handled","n-open-old":"handled","n-open-new":"needs_owner"});
      const phases=Object.fromEntries((await admin.query("select source_id,phase,last_error from public.supervisor_investigations where source_id = any($1)",[[ids.technical,ids.gated]])).rows.map(r=>[r.source_id,r.phase+":"+r.last_error]));
      expect(phases[ids.technical]).toBe("resolved:source_closed");
      expect(phases[ids.gated]).toBe("blocked:source_unavailable");
    }finally{
      await admin.query("delete from public.operating_tasks where id like 'n-%'");
      for(const cafe of [verified,unverified]){
        await admin.query("delete from public.supervisor_investigations where business_id=$1",[cafe]);
        await admin.query("delete from public.alerts where business_id=$1",[cafe]);
        await admin.query("delete from public.ai_threads where business_id=$1",[cafe]);
        await admin.query("delete from public.toast_api_credentials where business_id=$1",[cafe]);
        await admin.query("delete from public.memberships where business_id=$1",[cafe]);
        await admin.query("delete from public.businesses where id=$1",[cafe]);
      }
      await admin.query("delete from auth.users where id=$1",[owner]);
      await admin.end();
    }
  });

  it("metric drift on a rolling anomaly cannot restart or re-wake investigations every refresh",async()=>{
    const admin=new Client({connectionString:url});await admin.connect();
    const service=await connect();
    const cafe=randomUUID(),owner=randomUUID(),thread=randomUUID(),now=new Date();
    const enqueue=(source:string,rev:string,minutes:number)=>rpc(service,"supervisor_enqueue_investigation",
      [cafe,owner,thread,"alert",source,hex(rev),hex(rev),200,stamp(now,minutes)]);
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Drift café','UTC',false)",[cafe]);
      await admin.query("insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc,state) values ($1,'https://example.invalid','fixture-client','fixture-placeholder','verified')",[cafe]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafe,owner]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[thread,cafe,owner,randomUUID()]);
      const id=randomUUID();
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'business_anomaly','new',$3)",[id,cafe,JSON.stringify({family:"live_sales_decline",subject:"cafe",quality:"partial"})]);
      expect(await enqueue(id,"a",0)).toBe(true);
      for(let i=0;i<3;i++){
        const claim=await rpc(service,"supervisor_claim_investigation",[stamp(now,1+i*90)]) as Record<string,unknown>;
        expect(await rpc(service,"supervisor_fail_investigation",[cafe,owner,"alert",id,claim.lease_token,"model_incomplete",stamp(now,1+i*90)])).toBe(true);
      }
      const blockedAt=1+2*90;
      expect((await admin.query("select phase from public.supervisor_investigations where source_id=$1",[id])).rows[0].phase).toBe("blocked");
      expect(await enqueue(id,"b",blockedAt+60)).toBe(false);
      expect(await enqueue(id,"c",blockedAt+12*60)).toBe(false);
      expect((await admin.query("select phase,failure_count from public.supervisor_investigations where source_id=$1",[id])).rows[0]).toMatchObject({phase:"blocked"});
      expect(await enqueue(id,"d",blockedAt+25*60)).toBe(true);
      const woken=(await admin.query("select phase,failure_count from public.supervisor_investigations where source_id=$1",[id])).rows[0];
      expect(woken.phase).toBe("collect");
      expect(Number(woken.failure_count)).toBe(0);
    }finally{
      await service.end();
      await admin.query("delete from public.supervisor_investigations where business_id=$1",[cafe]);
      await admin.query("delete from public.alerts where business_id=$1",[cafe]);
      await admin.query("delete from public.ai_threads where business_id=$1",[cafe]);
      await admin.query("delete from public.toast_api_credentials where business_id=$1",[cafe]);
      await admin.query("delete from public.memberships where business_id=$1",[cafe]);
      await admin.query("delete from public.businesses where id=$1",[cafe]);
      await admin.query("delete from auth.users where id=$1",[owner]);
      await admin.end();
    }
  });
});
