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

function invoke(child: ChildProcess, operation: "claim" | "complete", args: unknown[]): Promise<ChildReply> {
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
      // Simulate expiry of the dispatch reservation only. The separate real
      // process-death test waits for the actual execution lease to expire.
      await admin.query("update public.supervisor_runs set dispatch_after=now()-interval '1 second' where id=$1",[recovery]);
      expect(await call(a,"supervisor_select_next_durable_run",[])).toEqual({run_id:recovery,recovery:true});
    } finally {
      await Promise.all([a?.end(),b?.end(),denied?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);
      await admin.end();
    }
  },120000);
});
