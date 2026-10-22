import pg from "pg";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
if(process.env.P1_DISPOSABLE_DB!=="1")throw Error("Requires explicit disposable test opt-in");
// Fixed local disposable DB only; never accepts a production connection string.
const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres"});
await db.connect();
const owner=randomUUID(),business=randomUUID(),thread=randomUUID(),message=randomUUID();
const signature="public.record_supervisor_usage_increment(uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,bigint)";
let assertions=0;
function check(value,label){assert.ok(value,label);assertions++;}
async function increment(models=8,tools=5,biz=business){
 return db.query("SELECT public.record_supervisor_usage_increment($1,$2,$3,$4,'gpt-6-luna',1200,800,$5,$6,NULL)",
   [biz,owner,thread,message,models,tools]);
}
async function rejected(fn,pattern){
 await db.query("SAVEPOINT expected_rejection");
 await assert.rejects(fn,pattern);assertions++;
 await db.query("ROLLBACK TO SAVEPOINT expected_rejection");
}
try{
 await db.query("BEGIN");
 await db.query("INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,`${owner}@example.invalid`]);
 await db.query("INSERT INTO public.businesses(id,name,is_demo) VALUES($1,'Disposable investigation usage',false)",[business]);
 await db.query("INSERT INTO public.memberships(business_id,user_id,role) VALUES($1,$2,'owner')",[business,owner]);
 await db.query("INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id) VALUES($1,$2,$3,$4)",[thread,business,owner,randomUUID()]);
 await db.query("INSERT INTO public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) VALUES($1,$2,$3,$4,$4,'owner','text','Analyze the cafe', $5)",[message,business,thread,owner,randomUUID()]);
 for(const role of ["anon","authenticated"]){
   check(!(await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,signature])).rows[0].allowed,`${role} cannot invoke telemetry`);
 }
 await db.query("SET LOCAL ROLE service_role");
 await increment();
 await increment(2,1);
 await db.query("RESET ROLE");
 const row=(await db.query("SELECT * FROM public.ai_usage_events WHERE owner_message_id=$1",[message])).rows[0];
 check(row.model_call_count===10&&row.tool_call_count===6,"retry usage is additive, not capped across attempts");
 check(row.input_tokens===2400&&row.output_tokens===1600&&row.estimated_cost_micros===null,"tokens accumulate, unknown cost remains null");
 await db.query("SET LOCAL ROLE service_role");
 await rejected(()=>increment(9),/Invalid or unauthorized/);
 await rejected(()=>increment(8,6),/Invalid or unauthorized/);
 await rejected(()=>increment(1,0,randomUUID()),/Invalid or unauthorized/);
 await rejected(()=>increment(null,0),/Invalid or unauthorized/);
 await db.query("RESET ROLE");
 check((await db.query("SELECT model_call_count FROM public.ai_usage_events WHERE owner_message_id=$1",[message])).rows[0].model_call_count===10,"invalid increments change no usage");
 // Simulate a retry of the SAME owner message after UTC midnight without
 // changing the database clock: move its first-day ledger row to yesterday.
 const today=(await db.query("SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day")).rows[0].day;
 await db.query("UPDATE public.ai_usage_events SET attempt_day=((statement_timestamp() AT TIME ZONE 'UTC')::date - 1) WHERE owner_message_id=$1",[message]);
 await db.query("SET LOCAL ROLE service_role");
 await increment(2,1);
 await db.query("RESET ROLE");
 const dated=(await db.query("SELECT attempt_day,model_call_count,tool_call_count FROM public.ai_usage_events WHERE owner_message_id=$1 ORDER BY attempt_day",[message])).rows;
 check(dated.length===2,"cross-midnight retries must have separate ledger rows");
 check(dated[0].model_call_count===10&&dated[1].model_call_count===2,"previous-day model calls cannot carry into the new day");
 check(dated[0].tool_call_count===6&&dated[1].tool_call_count===1,"new-day tool calls are attributed separately");
 check(new Date(dated[1].attempt_day).toISOString().slice(0,10)===new Date(today).toISOString().slice(0,10),"retry row has UTC attempt date");
 console.log(`PASS: ${assertions} real PostgreSQL investigation usage assertions`);
}finally{
 await db.query("ROLLBACK");
 await db.end();
}
