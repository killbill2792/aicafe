import { randomUUID } from "node:crypto";
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
