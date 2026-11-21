import {Client} from "pg";

const raw=process.env.SUPERVISOR_ROUTINES_DB_URL??"";
const u=raw?new URL(raw):null;
if(!u||!["localhost","127.0.0.1"].includes(u.hostname)||
   u.port!=="54322"||u.pathname!=="/postgres"||
   process.env.SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY!=="1")
  throw Error("u4_child_requires_local_disposable_postgres");
const vars=["U4_CRASH_BUSINESS","U4_CRASH_ROUTINE","U4_CRASH_RUN","U4_CRASH_LEASE"];
for(const name of vars)if(!/^[0-9a-f-]{36}$/ui.test(process.env[name]??""))
  throw Error("u4_child_invalid_work_identity");
const db=new Client({connectionString:raw});
await db.connect();
await db.query("select set_config('request.jwt.claim.role','service_role',false)");
await db.query("set role service_role");
const args=vars.map(name=>process.env[name]);
const {rows}=await db.query("select public.u4_checkpoint_model_step("+
  "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'tool_start','get_sales',"+
  "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') as ok",args);
if(rows[0]?.ok!==true)throw Error("u4_child_checkpoint_not_committed");
process.stdout.write("U4_PROCESS_CHECKPOINT_COMMITTED\n");
// The parent kills this REAL OS process after observing the committed step.
// A new worker must reclaim the same run ID; no fake-clock-only acceptance.
await new Promise(()=>{});
