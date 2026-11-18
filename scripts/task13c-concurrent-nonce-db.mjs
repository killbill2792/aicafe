// Only run against disposable migrated Supabase at 127.0.0.1:54322.
// Two real PostgreSQL authenticated sessions race the SAME staff/owner nonce;
// the second must wait for the first commit, then replay its exact receipt.
import {randomUUID} from "node:crypto";
import pg from "pg";
const connectionString=process.env.TASK13C_DISPOSABLE_DB_URL;
if(!connectionString)throw Error("Set TASK13C_DISPOSABLE_DB_URL for a disposable local database");
const endpoint=new URL(connectionString);
if(!["127.0.0.1","localhost"].includes(endpoint.hostname)||endpoint.port!=="54322")
 throw Error("Concurrent nonce test refuses non-disposable database");
const Client=pg.Client;
const admin=new Client({connectionString}),first=new Client({connectionString}),
 second=new Client({connectionString});
const ids={biz:randomUUID(),owner:randomUUID(),staff:randomUUID(),
 employee:randomUUID(),request:randomUUID()};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function assert(condition,message){if(!condition)throw Error(message);}
async function session(client,user){
 await client.query("BEGIN");
 await client.query("SET LOCAL ROLE authenticated");
 await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
 await client.query("SELECT set_config('request.jwt.claim.role','authenticated',true)");
}
async function race(label,user,sql,args){
 await Promise.all([session(first,user),session(second,user)]);
 const one=(await first.query(sql,args)).rows[0].result;
 assert(one&&typeof one.id==="string"&&one.replayed===false,label+" initial receipt invalid");
 let finished=false;
 const started=second.query(sql,args).then(r=>{finished=true;return r.rows[0].result;});
 await delay(180);
 assert(!finished,label+" duplicate returned before first committed");
 await first.query("COMMIT");
 const two=await started;
 await second.query("COMMIT");
 assert(two?.id===one.id&&two.replayed===true,label+" replay produced another record");
 return one.id;
}
try{
 await Promise.all([admin.connect(),first.connect(),second.connect()]);
 await admin.query(`INSERT INTO auth.users
  (id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at)
  VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,now(),'',now(),now()),
        ($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$4,now(),'',now(),now())`,
  [ids.owner,"13c-concurrency-owner-"+ids.owner+"@example.invalid",
   ids.staff,"13c-concurrency-staff-"+ids.staff+"@example.invalid"]);
 await admin.query("INSERT INTO public.businesses(id,name,timezone,currency,is_demo) VALUES($1,$2,$3,$4,false)",
  [ids.biz,"Disposable Task13C concurrency","America/Los_Angeles","USD"]);
 await admin.query("INSERT INTO public.memberships(business_id,user_id,role) VALUES($1,$2,'owner')",
  [ids.biz,ids.owner]);
 await admin.query(`INSERT INTO public.employees
  (id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id)
  VALUES($1,$2,'Disposable Concurrent Worker',true,'hour',1800,$3)`,
  [ids.employee,ids.biz,ids.staff]);
 await admin.query(`INSERT INTO public.staff_communication_requests
  (id,business_id,employee_id,kind,source_type,source_id,source_revision,title,prompt)
  VALUES($1,$2,$3,'task','test_nonce','concurrency','v1','Confirm the task','Please respond')`,
  [ids.request,ids.biz,ids.employee]);
 const staffNonce=randomUUID();
 const staffMessageId=await race("staff reply",ids.staff,
  "SELECT public.staff_channel_submit($1,'complete',$2,$3) AS result",
  [ids.request,"I have finished the requested task",staffNonce]);
 const receipt=await admin.query(`SELECT count(*)::int AS count
  FROM public.staff_communication_messages WHERE business_id=$1 AND employee_id=$2
  AND client_nonce=$3 AND id=$4`,[ids.biz,ids.employee,staffNonce,staffMessageId]);
 assert(receipt.rows[0].count===1,"staff concurrency created duplicate messages");
 const notices=await admin.query(`SELECT count(*)::int AS count
  FROM public.operating_tasks WHERE business_id=$1 AND id LIKE 'staff-response:%'`,[ids.biz]);
 assert(notices.rows[0].count===1,"staff concurrency created duplicate owner notices");
 // With a distinct nonce, a completed task is definitively stale.
 await session(first,ids.staff);
 let definitive=false;
 try{
  await first.query("SELECT public.staff_channel_submit($1,'complete',$2,$3)",[
   ids.request,"a separate new completion",randomUUID()]);
 }catch(e){definitive=e.code==="22023"&&String(e.message).includes("response_not_allowed");}
 await first.query("ROLLBACK");
 assert(definitive,"different nonce on handled task was not rejected");
 const messageNonce=randomUUID();
 const ownerMessageId=await race("owner message",ids.owner,
  "SELECT public.staff_channel_owner_send($1,$2,$3) AS result",
  [ids.employee,"Please verify the task details",messageNonce]);
 const ownerRows=await admin.query(`SELECT count(*)::int AS count
  FROM public.staff_communication_messages
  WHERE business_id=$1 AND employee_id=$2 AND id=$3 AND client_nonce=$4`,
  [ids.biz,ids.employee,ownerMessageId,messageNonce]);
 assert(ownerRows.rows[0].count===1,"owner message concurrency duplicated staff delivery");
 const assignNonce=randomUUID();
 const ownerAssignmentId=await race("owner assignment",ids.owner,
  "SELECT public.staff_channel_owner_assign($1,'checklist',$2,$3,$4) AS result",
  [ids.employee,"Inspect supplies","Report any low stock",assignNonce]);
 const assignments=await admin.query(`SELECT count(*)::int AS count
  FROM public.staff_communication_requests WHERE business_id=$1 AND employee_id=$2
    AND id=$3 AND source_type='owner_manual' AND source_id=$4`,
  [ids.biz,ids.employee,ownerAssignmentId,assignNonce]);
 assert(assignments.rows[0].count===1,"owner assignment concurrency duplicated work");
 console.log("Task13C authenticated concurrent worker, owner message and owner assignment: PASS");
}finally{
 for(const client of [first,second]){
  try{await client.query("ROLLBACK");}catch{}
  try{await client.end();}catch{}
 }
 try{
  await admin.query("DELETE FROM public.businesses WHERE id=$1",[ids.biz]);
  await admin.query("DELETE FROM auth.users WHERE id IN ($1,$2)",[ids.owner,ids.staff]);
 }catch(e){console.error("Disposable fixture cleanup incomplete",e.message);}
 try{await admin.end();}catch{}
}
