// Test-only subprocess for the existing SQL lease path; never a production worker.
// Keep it alive after the RPC commit so the parent can actually SIGKILL it.
import pg from "pg";
const { Client } = pg;
const url = process.env.SUPERVISOR_RUN_DB_URL;
if (process.env.SUPERVISOR_RUN_DB_SANDBOX_ONLY !== "1" || !url || !process.send)
  throw new Error("Disposable Supabase IPC test required");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.port !== "54322" || target.pathname !== "/postgres")
  throw new Error("Refusing non-disposable database");

const db = new Client({ connectionString: url });
await db.connect();
await db.query("select set_config('request.jwt.claim.role','service_role',false)");
await db.query("set role service_role");
const operations = {
  claim: "select public.supervisor_run_claim($1,$2,$3,$4,$5,$6) as result",
  complete: "select public.supervisor_run_complete_step($1,$2,$3,$4,$5,$6,$7) as result",
  reserve: "select public.supervisor_reserve_durable_model_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) as result",
};
process.on("message", async (request) => {
  try {
    const sql = operations[request.operation];
    if (!sql || !Array.isArray(request.args)) throw new Error("invalid_test_request");
    const { rows } = await db.query(sql, request.args);
    process.send({ ok: true, pid: process.pid, result: rows[0].result });
  } catch {
    process.send({ ok: false, pid: process.pid });
  }
});
process.on("disconnect", async () => { await db.end(); process.exit(0); });
