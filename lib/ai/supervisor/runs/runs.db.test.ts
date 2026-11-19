import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.SUPERVISOR_RUN_DB_URL ?? "";
const sandbox = process.env.SUPERVISOR_RUN_DB_SANDBOX_ONLY === "1";
if (sandbox) {
  if (!url) throw new Error("Local Supervisor run DB URL is required");
  const target = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.port !== "54322" || target.pathname !== "/postgres")
    throw new Error("Supervisor DB test refuses a non-disposable database");
}
async function connect(service = false) {
  const db = new Client({ connectionString: url });
  await db.connect();
  if (service) {
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("set role service_role");
  }
  return db;
}
const call = (db: Client, name: string, args: unknown[]) =>
  db.query("select public." + name + "(" + args.map((_, i) => "$" + (i + 1)).join(",") +
    ") as result", args).then(r => r.rows[0].result);

describe("durable Supervisor runs on migrated disposable PostgreSQL", () => {
  (sandbox ? it : it.skip)("persists steps across workers, isolates owners and finishes once", async () => {
    const admin = await connect();
    const businessId = randomUUID(), ownerId = randomUUID(), threadId = randomUUID();
    const scope = [businessId, ownerId, threadId];
    let a: Client | undefined, b: Client | undefined;
    try {
      // Real relational fixtures with fresh identities; never a production café.
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [ownerId, "run-" + ownerId + "@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,current_setting('TimeZone'),false)", [businessId, "Disposable Supervisor run test café"]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')", [businessId, ownerId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)", [threadId, businessId, ownerId, randomUUID()]);
      a = await connect(true); b = await connect(true);
      const requestKey = randomUUID(), workerA = randomUUID(), workerB = randomUUID();
      const specs = [{ key: "first", retry: "idempotent" }, { key: "second", retry: "idempotent" }, { key: "third", retry: "idempotent" }];
      const startArgs = [...scope, requestKey, "a".repeat(64), JSON.stringify(specs)];
      const runId = (await call(a, "supervisor_run_start", startArgs)).id as string;
      expect((await call(b, "supervisor_run_start", startArgs)).id).toBe(runId);
      const [first, competing] = await Promise.all([
        call(a, "supervisor_run_claim", [...scope, runId, workerA, 60]),
        call(b, "supervisor_run_claim", [...scope, runId, workerB, 60]),
      ]);
      expect([first.kind, competing.kind].sort()).toEqual(["busy", "claimed"]);
      const held = first.kind === "claimed" ? first : competing;
      expect(held.step.step_key).toBe("first");
      await call(a, "supervisor_run_complete_step", [...scope, runId, "first", held.step.claim_token, "receipt:first"]);
      const second = await call(a, "supervisor_run_claim", [...scope, runId, workerA, 60]);
      expect(second.step.step_key).toBe("second");
      await call(a, "supervisor_run_complete_step", [...scope, runId, "second", second.step.claim_token, "receipt:second"]);
      // A new worker skips the two completed actions after a simulated worker stop.
      const third = await call(b, "supervisor_run_claim", [...scope, runId, workerB, 60]);
      expect(third.step.step_key).toBe("third");
      await expect(call(b, "supervisor_run_claim", [businessId, randomUUID(), threadId, runId, workerB, 60])).rejects.toThrow();
      await call(b, "supervisor_run_complete_step", [...scope, runId, "third", third.step.claim_token, "receipt:third"]);
      expect((await call(a, "supervisor_run_finish", [...scope, runId, "report:verified"])).status).toBe("completed");
      await call(b, "supervisor_run_finish", [...scope, runId, "report:verified"]);
      await expect(call(b, "supervisor_run_finish", [...scope, runId, "report:other"])).rejects.toThrow();
      const { rows } = await admin.query("select r.final_report_ref, count(s.id)::int as steps, count(*) filter (where s.status='completed')::int as finished from public.supervisor_runs r join public.supervisor_run_steps s on s.run_id=r.id where r.id=$1 group by r.id", [runId]);
      expect(rows).toEqual([{ final_report_ref: "report:verified", steps: 3, finished: 3 }]);
    } finally {
      await Promise.all([a?.end(), b?.end()]);
      await admin.query("delete from public.businesses where id=$1", [businessId]);
      await admin.query("delete from auth.users where id=$1", [ownerId]);
      await admin.end();
    }
  });
});


type ChildReply = { ok: boolean; pid: number; result?: { kind?: string; idempotency_key?: string;
  step?: { step_key: string; claim_token: string; attempts: number } } };

function invoke(child: ChildProcess, operation: "claim" | "complete" | "reserve", args: unknown[]): Promise<ChildReply> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error);
    };
    const message = (value: unknown) => { cleanup(); resolve(value as ChildReply); };
    const exit = () => { cleanup(); reject(new Error("lease subprocess exited before receipt")); };
    const error = (e: Error) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("lease subprocess timed out")); }, 8000);
    child.once("message", message); child.once("exit", exit); child.once("error", error);
    child.send({ operation, args }, (e) => { if (e) error(e); });
  });
}

async function killAndConfirm(child: ChildProcess) {
  const exited = once(child, "exit");
  expect(child.kill("SIGKILL")).toBe(true);
  expect(await exited).toEqual([null, "SIGKILL"]);
}

async function waitForActualLeaseExpiry(db: Client, runId: string, key: string) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const { rows } = await db.query(
      "select lease_until <= clock_timestamp() as expired from public.supervisor_run_steps where run_id=$1 and step_key=$2",
      [runId, key]);
    if (rows[0]?.expired === true) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("real database lease did not expire");
}

describe("Task 15C durable SQL lease process death (not full Supervisor restart)", () => {
  (sandbox ? it : it.skip)("reclaims a killed idempotent step but blocks an abandoned uncertain effect", async () => {
    const admin = await connect();
    const businessId = randomUUID(), ownerId = randomUUID(), threadId = randomUUID();
    const scope = [businessId, ownerId, threadId];
    const children: ChildProcess[] = [];
    let service: Client | undefined;
    const start = () => {
      const child = fork("scripts/acceptance/task15c-worker-child.mjs", [], {
        execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      return child;
    };
    try {
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [ownerId, "restart-" + ownerId + "@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,current_setting('TimeZone'),false)", [businessId, "Disposable restart test café"]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')", [businessId, ownerId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)", [threadId, businessId, ownerId, randomUUID()]);
      service = await connect(true);
      const specs = [{ key: "read", retry: "idempotent" }, { key: "effect", retry: "reconcile" }];
      const runId = (await call(service, "supervisor_run_start",
        [...scope, randomUUID(), "b".repeat(64), JSON.stringify(specs)])).id as string;
      const first = start();
      const held = await invoke(first, "claim", [...scope, runId, randomUUID(), 2]);
      expect(held).toMatchObject({ ok: true, pid: first.pid, result: { kind: "claimed", step: { step_key: "read", attempts: 1 } } });
      await killAndConfirm(first);
      await waitForActualLeaseExpiry(admin, runId, "read");

      const second = start();
      const resumed = await invoke(second, "claim", [...scope, runId, randomUUID(), 30]);
      expect(resumed).toMatchObject({ ok: true, pid: second.pid, result: { kind: "claimed", step: { step_key: "read", attempts: 2 }, idempotency_key: held.result?.idempotency_key } });
      expect(resumed.pid).not.toBe(held.pid);
      expect(resumed.result?.step?.claim_token).not.toBe(held.result?.step?.claim_token);
      // Neither a stale token nor an untokened worker may stop the replacement.
      expect(await call(service, "supervisor_stop_durable_run",
        [...scope, runId, "turn_failed", "read", held.result?.step?.claim_token])).toBe(false);
      expect(await call(service, "supervisor_stop_durable_run",
        [...scope, runId, "cancelled", null, null])).toBe(false);
      expect((await admin.query("select status from public.supervisor_runs where id=$1",[runId])).rows[0].status).toBe("running");
      await expect(call(service, "supervisor_run_complete_step",
        [...scope, runId, "read", held.result?.step?.claim_token, "stale:receipt"])).rejects.toThrow();
      expect((await invoke(second, "complete",
        [...scope, runId, "read", resumed.result?.step?.claim_token, "test:read-receipt"])).ok).toBe(true);
      const effect = await invoke(second, "claim", [...scope, runId, randomUUID(), 2]);
      expect(effect).toMatchObject({ ok: true, result: { kind: "claimed", step: { step_key: "effect", attempts: 1 } } });
      await killAndConfirm(second);
      await waitForActualLeaseExpiry(admin, runId, "effect");

      const third = start();
      expect(await invoke(third, "claim", [...scope, runId, randomUUID(), 30]))
        .toMatchObject({ ok: true, pid: third.pid, result: { kind: "blocked" } });
      expect(third.pid).not.toBe(second.pid);
      const { rows } = await admin.query(
        "select step_key,status,attempts,error_code,result_ref from public.supervisor_run_steps where run_id=$1 order by step_index", [runId]);
      expect(rows).toEqual([
        { step_key: "read", status: "completed", attempts: 2, error_code: null, result_ref: "test:read-receipt" },
        { step_key: "effect", status: "blocked", attempts: 1, error_code: "lease_expired", result_ref: null },
      ]);
      // The existing service-only health check must report the unresolved
      // uncertainty without exposing owner/thread/source details.
      await service.query("begin");
      try {
        const result=(await service.query("select to_jsonb(public.run_data_health_check($1,$2)) as result",[8589934592000,30])).rows[0].result;
        expect(result.findings.find((f:{kind:string;business_id?:string})=>f.kind==="supervisor_work_recovery"&&f.business_id===businessId))
          .toEqual({kind:"supervisor_work_recovery",business_id:businessId,expired_leases:0,
            blocked_runs:1,retrying_investigations:0,failed_routines:0,stalled_runs:0});
      } finally { await service.query("rollback"); }
      // Five abandoned idempotent leases terminate, rather than returning
      // an unbounded sixth claim while other cafés need progress. This
      // injects the retry counter; the process kill above uses real time.
      const poison=(await call(service,"supervisor_run_start",
        [...scope,randomUUID(),"c".repeat(64),JSON.stringify([{key:"read",retry:"idempotent"}])])).id;
      const claimed=await call(service,"supervisor_run_claim",[...scope,poison,randomUUID(),30]);
      await admin.query("update public.supervisor_run_steps set attempts=5,lease_until=now()-interval '1 second' where run_id=$1",[poison]);
      expect(await call(service,"supervisor_run_claim",[...scope,poison,randomUUID(),30])).toEqual({kind:"blocked"});
      expect((await admin.query("select status,error_code,attempts from public.supervisor_run_steps where run_id=$1",[poison])).rows)
        .toEqual([{status:"blocked",error_code:"retry_exhausted",attempts:5}]);
      expect(await call(service,"supervisor_run_renew",[...scope,poison,"read",claimed.step.claim_token,30])).toBe(false);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await service?.end();
      await admin.query("delete from public.businesses where id=$1", [businessId]);
      await admin.query("delete from auth.users where id=$1", [ownerId]);
      await admin.end();
    }
  }, 30000);
});

describe("Task 15C fleet dispatch on migrated PostgreSQL", () => {
  (sandbox ? it : it.skip)("serves 100 cafés despite a 10,000-run noisy fleet, fences concurrency and preserves recovery", async () => {
    const admin = await connect();
    const cafes = Array.from({ length: 100 }, () => randomUUID());
    const owners = cafes.map(() => randomUUID()), threads = cafes.map(() => randomUUID());
    let a: Client | undefined, b: Client | undefined, denied: Client | undefined;
    try {
      // Bulk-create relational synthetic fixtures; no external provider or production data.
      await admin.query(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
        select id,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
          'fleet-'||id::text||'@example.invalid','',now(),now() from unnest($1::uuid[]) as x(id)`, [owners]);
      await admin.query(`insert into public.businesses(id,name,timezone,is_demo)
        select id,'Disposable fleet '||id::text,current_setting('TimeZone'),false from unnest($1::uuid[]) as x(id)`, [cafes]);
      await admin.query(`insert into public.memberships(business_id,user_id,role)
        select cafe,owner,'owner' from unnest($1::uuid[],$2::uuid[]) as x(cafe,owner)`, [cafes,owners]);
      await admin.query(`insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
        select thread,cafe,owner,gen_random_uuid() from unnest($1::uuid[],$2::uuid[],$3::uuid[]) as x(cafe,owner,thread)`,
        [cafes,owners,threads]);
      await admin.query(`insert into public.supervisor_runs(business_id,owner_user_id,thread_id,request_key,plan_hash,updated_at)
        select cafe,owner,thread,gen_random_uuid(),repeat('a',64),now()
        from unnest($1::uuid[],$2::uuid[],$3::uuid[]) as x(cafe,owner,thread)
        cross join lateral generate_series(1,case when cafe=$4 then 9901 else 1 end)`, [cafes,owners,threads,cafes[0]]);
      await admin.query(`insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode)
        select business_id,id,'owner_turn',1,'reconcile' from public.supervisor_runs where business_id=any($1::uuid[])`, [cafes]);
      const special = (await admin.query("select id from public.supervisor_runs where business_id=$1 order by id limit 3", [cafes[0]])).rows.map(row=>row.id);
      const [recovery,cancelled,leased] = special;
      await admin.query("update public.supervisor_runs set status='blocked',updated_at=now()-interval '1 day' where id=any($1::uuid[])", [[recovery,cancelled]]);
      await admin.query("update public.supervisor_run_steps set status='blocked',error_code='lease_expired' where run_id=$1", [recovery]);
      await admin.query("update public.supervisor_run_steps set status='blocked',error_code='cancelled' where run_id=$1", [cancelled]);
      await admin.query("update public.supervisor_runs set status='running',updated_at=now()-interval '2 days' where id=$1", [leased]);
      await admin.query("update public.supervisor_run_steps set status='leased',worker_id=gen_random_uuid(),claim_token=gen_random_uuid(),lease_until=now()+interval '10 minutes' where run_id=$1", [leased]);
      expect((await admin.query("select count(*)::int n from public.supervisor_runs where business_id=any($1::uuid[])", [cafes])).rows[0].n).toBe(10000);
      a=await connect(true); b=await connect(true);
      denied=await connect();
      await denied.query("set role authenticated");
      await expect(call(denied,"supervisor_select_next_durable_run",[])).rejects.toThrow();
      const first=await call(a,"supervisor_select_next_durable_run",[]);
      expect(first).toEqual({run_id:recovery,recovery:true});
      const seen=new Set<string>([cafes[0]]), reserved=new Set<string>([recovery]);
      for(let n=1;n<cafes.length;n++){
        const selected=await call(a,"supervisor_select_next_durable_run",[]);
        expect(selected).not.toBeNull();
        expect(reserved.has(selected.run_id)).toBe(false);
        const row=(await admin.query("select business_id from public.supervisor_runs where id=$1",[selected.run_id])).rows[0];
        expect(cafes).toContain(row.business_id);
        expect(seen.has(row.business_id)).toBe(false);
        seen.add(row.business_id);reserved.add(selected.run_id);
      }
      expect(seen.size).toBe(100);
      // More work remains eligible: competing selector transactions may return
      // no work, but must never reserve the same run or choose blocked/cancelled/live leases.
      const concurrent=(await Promise.all([call(a,"supervisor_select_next_durable_run",[]),call(b,"supervisor_select_next_durable_run",[])])).filter(Boolean);
      expect(concurrent.length).toBeGreaterThan(0);
      expect(new Set(concurrent.map(x=>x.run_id)).size).toBe(concurrent.length);
      for(const selected of concurrent){
        expect(reserved.has(selected.run_id)).toBe(false);
        expect([cancelled,leased]).not.toContain(selected.run_id);
      }
      // Simulate ticks spaced beyond the dispatch cooldown (not execution
      // lease expiry). Hold other fixture items to isolate one noisy café's
      // never-reconciled old run and an ordinary waiting run. The old row's
      // unchanged updated_at must NOT monopolize every such tick.
      const fresh=(await admin.query("select id from public.supervisor_runs where business_id=$1 and status='pending' and last_dispatched_at is null order by id limit 1",[cafes[0]])).rows[0].id;
      await admin.query("update public.supervisor_runs set dispatch_after=now()+interval '10 minutes' where business_id=any($1::uuid[]) and id<>all($2::uuid[])",[cafes,[recovery,fresh]]);
      await admin.query("update public.supervisor_runs set dispatch_after=now()-interval '1 second' where id=$1",[recovery]);
      expect(await call(a,"supervisor_select_next_durable_run",[])).toEqual({run_id:fresh,recovery:false});
      // Recovery remains eligible, not permanently demoted by fresh work.
      await admin.query("update public.supervisor_runs set dispatch_after=now()-interval '1 second' where id=$1",[fresh]);
      expect(await call(a,"supervisor_select_next_durable_run",[])).toEqual({run_id:recovery,recovery:true});
      await admin.query("update public.supervisor_runs set dispatch_after=now()-interval '1 second' where id=$1",[recovery]);
      expect(await call(a,"supervisor_select_next_durable_run",[])).toEqual({run_id:fresh,recovery:false});
    } finally {
      await Promise.all([a?.end(),b?.end(),denied?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120000);
});


describe("Task 15C durable provider reservations survive actual worker death",()=>{
  (sandbox?it:it.skip)("fences concurrent reservations, preserves unknown spend, deduplicates summary accounting and blocks stale/revoked scope",async()=>{
    const admin=await connect();
    const businessId=randomUUID(),ownerId=randomUUID(),threadId=randomUUID(),messageId=randomUUID();
    const scope=[businessId,ownerId,threadId];
    let a:Client|undefined,b:Client|undefined,foreign:Client|undefined,child:ChildProcess|undefined;
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [ownerId,"provider-reservation-"+ownerId+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable provider reservation cafe','UTC',false)",[businessId]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[businessId,ownerId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[threadId,businessId,ownerId,randomUUID()]);
      await admin.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,$3,'owner','text','Check the cafe',$5)",
        [messageId,...scope,randomUUID()]);
      a=await connect(true);b=await connect(true);
      const job=(await call(a,"ai_agent_job_start",[...scope,messageId])).job;
      const runId=(await call(a,"supervisor_run_start",[...scope,messageId,"d".repeat(64),
        JSON.stringify([{key:"owner_turn",retry:"reconcile"}])])).id;
      child=fork("scripts/acceptance/task15c-worker-child.mjs",[],{execArgv:[],stdio:["ignore","ignore","inherit","ipc"]});
      const hold=await invoke(child,"claim",[...scope,runId,randomUUID(),6]);
      expect(hold).toMatchObject({ok:true,pid:child.pid,result:{kind:"claimed",step:{step_key:"owner_turn",attempts:1}}});
      const token=hold.result?.step?.claim_token;
      const args=(id:string,overrides?:{token?:string;business?:string;owner?:string;run?:string;job?:string;calls?:number;input?:number;output?:number;cost?:number;daily?:number})=>[
        id,overrides?.business??businessId,overrides?.owner??ownerId,threadId,overrides?.run??runId,messageId,
        overrides?.job??job.id,overrides?.token??token,"gpt-6-luna",100,50,100,
        overrides?.calls??2,overrides?.input??200,overrides?.output??100,overrides?.cost??200,overrides?.daily??2,
      ];
      const unknown=randomUUID();
      expect(await invoke(child,"reserve",args(unknown))).toMatchObject({ok:true,pid:child.pid});
      await killAndConfirm(child);
      // An ACK lost with the process is not a refund or evidence of zero usage.
      expect((await admin.query("select status,input_tokens,output_tokens,estimated_cost_micros from public.supervisor_system_usage_events where attempt_id=$1",[unknown])).rows)
        .toEqual([{status:"attempted",input_tokens:null,output_tokens:null,estimated_cost_micros:null}]);
      foreign=await connect();
      await foreign.query("set role authenticated");
      await expect(call(foreign,"supervisor_reserve_durable_model_call",args(randomUUID()))).rejects.toThrow();
      for(const bad of [{token:randomUUID()},{business:randomUUID()},{owner:randomUUID()},
        {run:randomUUID()},{job:randomUUID()}])
        await expect(call(a,"supervisor_reserve_durable_model_call",args(randomUUID(),bad))).rejects.toThrow("durable_reservation_not_authorized");
      for(const cap of [{calls:1},{input:199},{output:99},{cost:199}])
        await expect(call(a,"supervisor_reserve_durable_model_call",args(randomUUID(),cap))).rejects.toThrow("durable_provider_budget_exhausted");
      const ids=[randomUUID(),randomUUID()];
      const competing=await Promise.allSettled([call(a,"supervisor_reserve_durable_model_call",args(ids[0])),
        call(b,"supervisor_reserve_durable_model_call",args(ids[1]))]);
      expect(competing.filter(v=>v.status==="fulfilled")).toHaveLength(1);
      const next=ids[competing.findIndex(v=>v.status==="fulfilled")];
      await call(a,"supervisor_complete_investigation_model_call",[next,...scope,"gpt-6-luna",70,10,12]);
      // Exact already-reserved identifiers are accounted once in the ordinary
      // turn summary; the unknown row remains conservatively charged.
      const summary=[...scope,messageId,runId,[unknown,next],"gpt-6-luna",70,10,2,0,12];
      await call(a,"supervisor_record_durable_usage_increment",summary);
      await expect(call(b,"supervisor_record_durable_usage_increment",summary)).rejects.toThrow("durable_usage_scope_or_replay");
      expect((await admin.query("select model_call_count,reserved_model_call_count,input_tokens,output_tokens from public.ai_usage_events where owner_message_id=$1",[messageId])).rows)
        .toEqual([{model_call_count:2,reserved_model_call_count:"2",input_tokens:70,output_tokens:10}]);
      expect((await admin.query("select count(*)::int n,count(*) filter(where accounted_at is not null)::int accounted from public.supervisor_system_usage_events where business_id=$1",[businessId])).rows)
        .toEqual([{n:2,accounted:2}]);
      // The two persisted reservations exhaust the existing owner-day quota,
      // even though the aggregate also records their two attempted calls.
      await expect(call(a,"supervisor_reserve_durable_model_call",args(randomUUID(),{calls:3,input:300,output:150,cost:300}))).rejects.toThrow("owner_usage_limit_reached");
      await admin.query("delete from public.memberships where business_id=$1 and user_id=$2",[businessId,ownerId]);
      await expect(call(a,"supervisor_reserve_durable_model_call",args(randomUUID(),{daily:5}))).rejects.toThrow("durable_reservation_not_authorized");
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[businessId,ownerId]);
      await waitForActualLeaseExpiry(admin,runId,"owner_turn");
      expect(await call(b,"supervisor_run_claim",[...scope,runId,randomUUID(),30])).toEqual({kind:"blocked"});
      await expect(call(b,"supervisor_reserve_durable_model_call",args(randomUUID(),{daily:5}))).rejects.toThrow("durable_reservation_not_authorized");
      expect((await admin.query("select status, input_tokens, reserved_cost_micros from public.supervisor_system_usage_events where attempt_id=$1",[unknown])).rows)
        .toEqual([{status:"attempted",input_tokens:null,reserved_cost_micros:"100"}]);
    }finally{
      if(child&&child.exitCode===null&&child.signalCode===null)await killAndConfirm(child);
      await Promise.all([a?.end(),b?.end(),foreign?.end()]);
      await admin.query("delete from public.businesses where id=$1",[businessId]);
      await admin.query("delete from auth.users where id=$1",[ownerId]);
      await admin.end();
    }
  },30000);
});


describe("Task 6/15C v2 durable owner admission and checkpoint fencing",()=>{
  (sandbox?it:it.skip)("preserves exact input and receipts across real lease loss; refuses uncertain effects, foreign scope and stale writers",async()=>{
    const admin=await connect();
    const businessId=randomUUID(),ownerId=randomUUID(),threadId=randomUUID(),messageId=randomUUID();
    const scope=[businessId,ownerId,threadId];
    let a:Client|undefined,b:Client|undefined,denied:Client|undefined;
    const children:ChildProcess[]=[];
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[ownerId,"checkpoint-"+ownerId+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values($1,$2,current_setting('TimeZone'),false)",[businessId,"Disposable v2 checkpoint café"]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[businessId,ownerId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,ownerId,randomUUID()]);
      await admin.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$3,'owner','text','Review the selected document',$5)",[messageId,...scope,randomUUID()]);
      const attachmentId=randomUUID();
      await admin.query("insert into public.ai_attachments(id,business_id,owner_user_id,thread_id,object_path,original_name,media_type,bytes) values($1,$2,$3,$4,$5,'notes.txt','text/plain',42)",[attachmentId,...scope,scope.join("/")+"/"+attachmentId+"/notes.txt"]);
      a=await connect(true);b=await connect(true);
      const admit=[...scope,messageId,"c".repeat(64),"es",[attachmentId]];
      const run=await call(a,"supervisor_admit_owner_run_v2",admit);
      expect(run).toMatchObject({execution_version:2,request_key:messageId,input_locale:"es",input_attachment_ids:[attachmentId],status:"pending"});
      expect((await call(b,"supervisor_admit_owner_run_v2",admit)).id).toBe(run.id);
      await expect(call(a,"supervisor_admit_owner_run_v2",[...scope,messageId,"c".repeat(64),"en",[attachmentId]])).rejects.toThrow("owner_run_input_conflict");
      await expect(call(a,"supervisor_admit_owner_run_v2",[...scope,messageId,"c".repeat(64),"es",[randomUUID()]])).rejects.toThrow("owner_run_input_unavailable");
      denied=await connect();await denied.query("set role authenticated");
      await expect(call(denied,"supervisor_admit_owner_run_v2",admit)).rejects.toThrow();
      const privileges=await admin.query("select has_column_privilege('authenticated','public.supervisor_runs','input_attachment_ids','SELECT') as input,has_column_privilege('authenticated','public.supervisor_run_steps','checkpoint_receipts','SELECT') as receipts,has_column_privilege('authenticated','public.supervisor_run_steps','checkpoint_seq','SELECT') as progress");
      expect(privileges.rows).toEqual([{input:false,receipts:false,progress:true}]);
      const worker=randomUUID();
      const auth=await call(a,"supervisor_run_claim",[...scope,run.id,worker,30]);
      expect(auth.step.step_key).toBe("authorize_owner");
      await call(a,"supervisor_run_complete_step",[...scope,run.id,"authorize_owner",auth.step.claim_token,"owner:"+messageId]);
      const child=fork("scripts/acceptance/task15c-worker-child.mjs",[],{execArgv:[],stdio:["ignore","ignore","inherit","ipc"]});
      children.push(child);
      const first=await invoke(child,"claim",[...scope,run.id,randomUUID(),5]);
      expect(first).toMatchObject({ok:true,pid:child.pid,result:{kind:"claimed",step:{step_key:"owner_turn",attempts:1}}});
      const oldToken=first.result!.step!.claim_token;
      const job=await call(a,"supervisor_start_owner_job_v2",[...scope,run.id,oldToken]);
      expect(job).toMatchObject({owner_message_id:messageId,durable_run_id:run.id,status:"running"});
      await expect(call(a,"ai_agent_job_start",[...scope,messageId])).rejects.toThrow("durable_job_owned");
      const operation=randomUUID(),receipt="source:"+randomUUID();
      const checkpoint=(token:string,seq:number,op:string,action:string,tool:string|null,ref:string|null)=>[...scope,run.id,token,seq,op,action,tool,ref];
      expect(await call(a,"supervisor_checkpoint_owner_run_v2",checkpoint(oldToken,0,operation,"begin_read","get_sales",null)))
        .toMatchObject({checkpoint_seq:1,checkpoint_phase:"read_pending",checkpoint_operation:operation});
      expect(await call(a,"supervisor_checkpoint_owner_run_v2",checkpoint(oldToken,1,operation,"complete",null,receipt)))
        .toMatchObject({checkpoint_seq:2,checkpoint_phase:"ready",checkpoint_receipts:[{operation,phase:"read_pending",tool:"get_sales",receipt}]});
      // A second provider operation is pending when the actual worker dies.
      const providerOp=randomUUID();
      await call(a,"supervisor_checkpoint_owner_run_v2",checkpoint(oldToken,2,providerOp,"begin_provider",null,null));
      await killAndConfirm(child);
      await waitForActualLeaseExpiry(admin,run.id,"owner_turn");
      const resumed=await call(b,"supervisor_run_claim",[...scope,run.id,randomUUID(),30]);
      expect(resumed).toMatchObject({kind:"claimed",step:{step_key:"owner_turn",attempts:2,checkpoint_seq:3,checkpoint_phase:"provider_pending",checkpoint_operation:providerOp,checkpoint_receipts:[{operation,receipt}]}});
      const token=resumed.step.claim_token;
      expect(token).not.toBe(oldToken);
      expect((await call(b,"supervisor_start_owner_job_v2",[...scope,run.id,token])).id).toBe(job.id);
      expect(await call(a,"supervisor_update_owner_job_v2",[...scope,run.id,oldToken,job.id,"heartbeat",null,null,null])).toBe(false);
      await expect(call(a,"supervisor_checkpoint_owner_run_v2",checkpoint(oldToken,3,providerOp,"complete",null,"provider:"+randomUUID()))).rejects.toThrow("checkpoint_claim_conflict");
      await expect(call(b,"supervisor_checkpoint_owner_run_v2",[randomUUID(),...checkpoint(token,3,providerOp,"complete",null,"provider:"+randomUUID()).slice(1)])).rejects.toThrow("checkpoint_run_unavailable");
      await expect(call(b,"supervisor_run_complete_step",[...scope,run.id,"owner_turn",token,randomUUID()])).rejects.toThrow("owner_turn_receipt_not_verified");
      await call(b,"supervisor_checkpoint_owner_run_v2",checkpoint(token,3,providerOp,"complete",null,"provider:"+randomUUID()));
      await expect(call(b,"supervisor_checkpoint_owner_run_v2",checkpoint(token,4,operation,"begin_read","get_sales",null))).rejects.toThrow("checkpoint_operation_conflict");
      // An uncertain effect cannot yield or receive a second operation key.
      const effect=randomUUID();
      await call(b,"supervisor_checkpoint_owner_run_v2",checkpoint(token,4,effect,"begin_effect","propose_supplier_purchase_order",null));
      expect(await call(b,"supervisor_yield_owner_run_v2",[...scope,run.id,token,5,15])).toBe(false);
      await expect(call(b,"supervisor_checkpoint_owner_run_v2",checkpoint(token,5,randomUUID(),"begin_read","get_sales",null))).rejects.toThrow("checkpoint_operation_conflict");
      expect(await call(b,"supervisor_stop_durable_run",[...scope,run.id,"cancelled","owner_turn",token])).toBe(true);
      await expect(call(a,"supervisor_checkpoint_owner_run_v2",checkpoint(token,5,effect,"complete",null,"effect:"+randomUUID()))).rejects.toThrow("checkpoint_run_unavailable");
      const saved=await admin.query("select r.status,s.checkpoint_seq,s.checkpoint_phase,s.checkpoint_receipts from public.supervisor_runs r join public.supervisor_run_steps s on s.run_id=r.id and s.business_id=r.business_id where r.id=$1 and s.step_key='owner_turn'",[run.id]);
      expect(saved.rows).toMatchObject([{status:"blocked",checkpoint_seq:"5",checkpoint_phase:"effect_pending",checkpoint_receipts:[{operation,receipt},{operation:providerOp}]}]);
    }finally{
      for(const child of children)if(child.exitCode===null&&child.signalCode===null)await killAndConfirm(child);
      await Promise.all([a?.end(),b?.end(),denied?.end()]);
      await admin.query("delete from public.businesses where id=$1",[businessId]);
      await admin.query("delete from auth.users where id=$1",[ownerId]);
      await admin.end();
    }
  },30000);
});

describe("Task 6/15C exact matched owner clarification and final reply",()=>{
 (sandbox?it:it.skip)("waits for the matched owner, resumes the original run, fences old jobs and publishes one final receipt",async()=>{
  const admin=await connect();const businessId=randomUUID(),ownerId=randomUUID(),threadId=randomUUID(),messageId=randomUUID();
  const scope=[businessId,ownerId,threadId];
  let a:Client|undefined;
  try{
   await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[ownerId,"answer-"+ownerId+"@example.invalid"]);
   await admin.query("insert into public.businesses(id,name,timezone,is_demo) values($1,$2,'UTC',false)",[businessId,"Disposable exact owner answer"]);
   await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[businessId,ownerId]);
   await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,ownerId,randomUUID()]);
   const insert=async(id:string,text:string)=>admin.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$3,'owner','text',$5,$6)",[id,...scope,text,randomUUID()]);
   await insert(messageId,"Prepare the report");
   a=await connect(true);
   const run=await call(a,"supervisor_admit_owner_run_v2",[...scope,messageId,"d".repeat(64),"en",[]]);
   const auth=await call(a,"supervisor_run_claim",[...scope,run.id,randomUUID(),30]);
   await call(a,"supervisor_run_complete_step",[...scope,run.id,"authorize_owner",auth.step.claim_token,"owner:"+messageId]);
   const first=await call(a,"supervisor_run_claim",[...scope,run.id,randomUUID(),30]);
   const token=first.step.claim_token;
   const job=await call(a,"supervisor_start_owner_job_v2",[...scope,run.id,token]);
   const questionId=randomUUID();
   const grounding={status:"requires_owner_input",ownerMessageId:messageId,durableRunId:run.id,durableQuestionId:questionId};
   const question=await call(a,"supervisor_publish_owner_question_v2",[...scope,run.id,token,job.id,questionId,JSON.stringify([{type:"clarify",question:"Which date?",options:[{label:"Today",value:"today"}],allowOther:true}]),JSON.stringify(grounding)]);
   expect(question.id).toBe(questionId);
   expect((await call(a,"supervisor_run_claim",[...scope,run.id,randomUUID(),30])).kind).toBe("blocked");
   const answerId=randomUUID();await insert(answerId,"Today");
   await expect(call(a,"supervisor_answer_owner_run_v2",[...scope,randomUUID(),answerId])).rejects.toThrow();
   await expect(call(a,"supervisor_answer_owner_run_v2",[randomUUID(),ownerId,threadId,questionId,answerId])).rejects.toThrow();
   const resumed=await call(a,"supervisor_answer_owner_run_v2",[...scope,questionId,answerId]);
   expect(resumed).toMatchObject({id:run.id,request_key:messageId,status:"pending",owner_answer_ids:[answerId]});
   expect((await call(a,"supervisor_answer_owner_run_v2",[...scope,questionId,answerId])).id).toBe(run.id);
   const secondAnswer=randomUUID();await insert(secondAnswer,"Tomorrow");
   await expect(call(a,"supervisor_answer_owner_run_v2",[...scope,questionId,secondAnswer])).rejects.toThrow("owner_question_already_answered");
   const next=await call(a,"supervisor_run_claim",[...scope,run.id,randomUUID(),30]);
   const nextToken=next.step.claim_token;
   expect(nextToken).not.toBe(token);
   expect((await call(a,"supervisor_start_owner_job_v2",[...scope,run.id,nextToken])).id).toBe(job.id);
   const {supervisorReplyIdFor}=await import("@/lib/ai/conversations/replyValidation");
   const final=supervisorReplyIdFor(messageId);
   const finalGrounding=JSON.stringify({status:"verified",ownerMessageId:messageId,durableRunId:run.id,agentMetadata:{endReason:"complete"}});
   const blocks=JSON.stringify([{type:"text",text:"Verified report"}]);
   await expect(call(a,"supervisor_publish_owner_reply_v2",[...scope,run.id,token,job.id,final,blocks,finalGrounding])).rejects.toThrow();
   expect((await call(a,"supervisor_publish_owner_reply_v2",[...scope,run.id,nextToken,job.id,final,blocks,finalGrounding])).id).toBe(final);
   expect((await call(a,"supervisor_publish_owner_reply_v2",[...scope,run.id,nextToken,job.id,final,blocks,finalGrounding])).id).toBe(final);
   await call(a,"supervisor_run_complete_step",[...scope,run.id,"owner_turn",nextToken,final]);
   const verify=await call(a,"supervisor_run_claim",[...scope,run.id,randomUUID(),30]);
   await call(a,"supervisor_run_complete_step",[...scope,run.id,"verify_report",verify.step.claim_token,final]);
   expect((await call(a,"supervisor_run_finish",[...scope,run.id,final])).status).toBe("completed");
   expect((await admin.query("select count(*)::int n from public.ai_messages where id=$1",[final])).rows[0].n).toBe(1);
  }finally{
   await a?.end();await admin.query("delete from public.businesses where id=$1",[businessId]);
   await admin.query("delete from auth.users where id=$1",[ownerId]);await admin.end();
  }
 },30000);
});
