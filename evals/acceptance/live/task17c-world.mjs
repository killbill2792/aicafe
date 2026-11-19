import {randomUUID,randomInt,createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {writeFileSync,unlinkSync,mkdtempSync,existsSync,rmSync} from "node:fs";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
const local="http://127.0.0.1:3000";
const check=(condition,code)=>{if(!condition)throw Error("task17c:"+code);};
export const rows=async(db,sql,args=[])=> (await db.query(sql,args)).rows;
export async function openOwner(browser,cafe){
 const context=await browser.newContext({baseURL:local,serviceWorkers:"block"});
 try{
  const page=await context.newPage();
  await page.goto("/en/login");
  await page.locator("#email").fill(cafe.owner.email);
  await page.locator("#login-password").fill(cafe.owner.password);
  await page.locator("form button[type=submit]").click();
  await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
  return {context,page};
 }catch(e){await context.close();throw e;}
}
export function profiles(){
 const [first,foreign]=TEST_CAFES;
 check(first?.owner&&foreign?.owner&&first.businessId!==foreign.businessId,"two_cafes_required");
 return {first,foreign};
}
export async function createThread(context){
 const r=await context.request.post("/api/ai/threads",{headers:{Origin:local},data:{requestId:randomUUID(),title:"Disposable cross-domain delegation"}});
 check(r.status()===201,"thread_create_failed");
 const id=(await r.json()).thread?.id;
 check(/^[0-9a-f-]{36}$/i.test(id??""),"thread_id_missing");
 return id;
}
export async function makeQuote(context,thread,timezone){
 const dueAt=Math.floor((Date.now()+240000)/60000)*60000;
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(dueAt)).map(p=>[p.type,p.value]));
 const expected={title:"Daily stock and supplier check",timezone,time:parts.hour+":"+parts.minute,
   localDate:parts.year+"-"+parts.month+"-"+parts.day,dueAt,quantity:randomInt(21,90),reference:"quote-"+randomUUID()};
 const csv="item,quantity,reference\nOat milk,"+expected.quantity+","+expected.reference+"\n";
 const response=await context.request.post("/api/ai/threads/"+thread+"/attachments",{
  headers:{Origin:local},multipart:{file:{name:"supplier-quote.csv",mimeType:"text/csv",buffer:Buffer.from(csv)}}});
 check(response.status()===201,"file_upload_failed");
 const attachmentId=(await response.json()).attachment?.id;
 check(/^[0-9a-f-]{36}$/i.test(attachmentId??""),"attachment_id_missing");
 return {attachmentId,expected};
}
export async function delegate(page,thread,attachmentId,expected){
 // The owner delegates a business outcome, never specifies a tool or instructs
 // the model which data to return beyond the ordinary business request.
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async input=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),165000);
  try{
   const r=await fetch("/api/ai/threads/"+input.thread+"/agent",{method:"POST",credentials:"same-origin",
    signal:abort.signal,headers:{"content-type":"application/json"},
    body:JSON.stringify({locale:"en",text:input.text,clientMessageId:input.clientMessageId,attachmentIds:[input.attachmentId]})});
   if(!r.ok||!r.body)return {done:null,names:[]};
   const rd=r.body.getReader(),decoder=new TextDecoder();let buffer="",done=null,error=false;const names=[];
   while(!done&&!error){
    const frame=await rd.read();if(frame.done)break;
    buffer+=decoder.decode(frame.value,{stream:true});let end;
    while((end=buffer.indexOf("\n\n"))>=0){
     const lines=buffer.slice(0,end).split("\n");buffer=buffer.slice(end+2);
     const event=lines.find(l=>l.startsWith("event: "))?.slice(7);
     const data=JSON.parse(lines.find(l=>l.startsWith("data: "))?.slice(6)??"null");
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=true;break;}
    }
   }
   await rd.cancel().catch(()=>{});return {done,names,error};
  }finally{clearTimeout(timer);}
 },{thread,attachmentId,clientMessageId,text:"Read this supplier quote and tell me the exact item, quantity and reference. Compare it with my current menu. Set up a daily internal café check named '"+expected.title+"' at "+expected.time+" café local time so I can keep on top of stock and suppliers. Do not send messages, order anything or change stock or prices."});
 check(!result.error&&result.done?.endReason==="complete"&&/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""),"real_turn_incomplete");
 check(result.names.includes("manage_routine")&&result.names.includes("get_menu_items"),"model_selected_tools_missing");
 return {...result,clientMessageId};
}

/** A separate actual Vitest process imports the real routine dispatcher using
 * the repository's existing aliases and TS transform. No replacement scheduler.
 * The generated config is private temporary test configuration, not a tracked
 * production file. It selects just this test-only worker entrypoint. */
function launchWorker(input){
 const config=resolve(".task17c-"+randomUUID()+".config.mts");
 writeFileSync(config,'import base from "./vitest.config.ts";\nexport default {...base,test:{...base.test,include:["evals/acceptance/live/task17c-world.mjs"],maxWorkers:1}};\n',{flag:"wx",mode:0o600});
 const child=spawn(process.execPath,[resolve("node_modules/vitest/vitest.mjs"),"run","--config",config,"--pool=threads","--maxWorkers=1"],
  {cwd:process.cwd(),detached:true,stdio:"ignore",env:{...process.env,AICAFE_17C_TICK:JSON.stringify(input)}});
 const exit=once(child,"exit");void exit.catch(()=>{});
 const close=async()=>{
  if(child.pid&&child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,"SIGKILL");
  await exit.catch(()=>{});unlinkSync(config);
 };
 return {child,exit,close};
}
async function runWorker(input,timeout=165000){
 const session=launchWorker(input);
 const timer=setTimeout(()=>{if(session.child.pid&&session.child.exitCode===null&&session.child.signalCode===null)process.kill(-session.child.pid,"SIGKILL");},timeout);
 try{
  const [code,signal]=await session.exit;
  check(session.child.pid!==process.pid&&code===0&&!signal,"scheduled_worker_failed");
  return session.child.pid;
 }finally{clearTimeout(timer);await session.close();}
}
export async function scheduledTick(scope,timezone){
 return runWorker({mode:"routine",scopes:[{businessId:scope.businessId,timezone}]},120000);
}
export async function observeDueOccurrence(db,scope,expected,routineId){
 // No fake time, seeded occurrence, or altered lease. Wait on PostgreSQL time,
 // after the genuine chat-created routine is committed and the owner is offline.
 const [routine]=await rows(db,"select extract(epoch from updated_at)*1000 as updated_ms from public.supervisor_routines where business_id=$1 and id=$2",[scope.businessId,routineId]);
 check(routine&&Number(routine.updated_ms)<expected.dueAt,"routine_not_committed_before_due");
 const deadline=Date.now()+260000;
 for(;;){
  const [clock]=await rows(db,"select extract(epoch from clock_timestamp())*1000 as ms");
  if(Number(clock?.ms)>=expected.dueAt)break;
  check(Date.now()<deadline,"real_schedule_deadline");
  await new Promise(r=>setTimeout(r,250));
 }
 const firstPid=await scheduledTick(scope,expected.timezone);
 const read=()=>rows(db,"select run_id,local_date::text,revision,state,attempts,receipt_ref from public.supervisor_routine_occurrences where business_id=$1 and routine_id=$2 and local_date=$3",[scope.businessId,routineId,expected.localDate]);
 const before=await read();
 const secondPid=await scheduledTick(scope,expected.timezone);
 const after=await read();
 return {firstPid,secondPid,before,after};
}
/** Both operating incidents originate from actual source services (never insert
 * an alert, proposal, investigation, owner message or successful effect). */
export async function createOperatingWorld(sql){
 const {createClient}=await import("@supabase/supabase-js");
 const options={auth:{persistSession:false,autoRefreshToken:false}};
 const api=process.env.NEXT_PUBLIC_SUPABASE_URL,anon=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 const service=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
 async function rpc(client,name,args){
  const {data,error}=await client.rpc(name,args);
  check(!error,"source_rpc_"+name);return data;
 }
 async function user(prefix){
  const email=prefix+"-"+randomUUID()+"@example.invalid",password="Disposable17C-"+randomUUID();
  const created=await service.auth.admin.createUser({email,password,email_confirm:true});
  check(!created.error&&created.data.user?.id,"local_user_failed");
  const client=createClient(api,anon,options);
  const login=await client.auth.signInWithPassword({email,password});
  check(!login.error&&login.data.user.id===created.data.user.id,"source_authentication_failed");
  return {id:created.data.user.id,client,email,password};
 }
 async function cafe(profile,prefix){
  const owner=await user(prefix+"-owner"),businessId=randomUUID(),threadId=randomUUID();
  const name="Disposable "+prefix+" "+businessId.slice(0,8);
  await sql.query("insert into public.businesses(id,name,timezone,currency,is_demo) values($1,$2,$3,$4,false)",[businessId,name,profile.timezone,profile.currency]);
  await sql.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered') on conflict(business_id) do update set mode='grandfathered',access_end=null",[businessId]);
  await sql.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[businessId,owner.id]);
  await sql.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,owner.id,randomUUID()]);
  return {businessId,threadId,ownerUserId:owner.id,timezone:profile.timezone,currency:profile.currency,name,owner,profile};
 }
 const {first,foreign}=profiles();
 const staff=await cafe(first,"staff"),finance=await cafe(foreign,"finance");
 const employee=await user("staff-employee");
 const employeeId=randomUUID(),replacementId=randomUUID(),shiftId=randomUUID();
 const day=(cafe,n)=>{const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:cafe.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(Date.now()+n*86400000)).map(x=>[x.type,x.value]));return p.year+"-"+p.month+"-"+p.day;};
 const shiftDate=day(staff,1);
 await sql.query("insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id) values($1,$2,'Opening barista',true,'hour',$3,$4),($5,$2,'Available barista',true,'hour',$6,null)",
  [employeeId,staff.businessId,Math.round(staff.profile.employees[0].wage*staff.profile.wageScale),employee.id,replacementId,Math.round(staff.profile.employees[1].wage*staff.profile.wageScale)]);
 await sql.query("insert into public.scheduled_shifts(id,business_id,employee_id,local_date,start_local,end_local,source,status) values($1,$2,$3,$4,'07:00','14:00','owner','sent')",[shiftId,staff.businessId,employeeId,shiftDate]);
 check(Number(await rpc(service,"staff_channel_sync_shift_requests",{p_business_id:staff.businessId}))===1,"published_shift_request_missing");
 const [req]=await rows(sql,"select id from public.staff_communication_requests where business_id=$1 and employee_id=$2 and kind='shift_confirmation'",[staff.businessId,employeeId]);
 check(req?.id,"staff_source_request_missing");
 const messageArgs={p_request_id:req.id,p_response:"decline",p_body:"I have a fever and cannot work the opening shift. Please find cover.",p_nonce:randomUUID()};
 const firstReply=await rpc(employee.client,"staff_channel_submit",messageArgs),replay=await rpc(employee.client,"staff_channel_submit",messageArgs);
 check(firstReply?.id&&firstReply.replayed===false&&replay?.id===firstReply.id&&replay.replayed===true,"duplicate_staff_source_not_idempotent");
 const [staffTask]=await rows(sql,"select id,status from public.operating_tasks where business_id=$1 and entity_type='staff_message' and entity_id=$2",[staff.businessId,firstReply.id]);
 check(staffTask?.id&&staffTask.status==="needs_owner","real_staff_incident_missing");
 const rent=randomInt(200,401)*100,initialCash=Math.floor(rent/2),laterCash=rent+10000,accountKey=createHash("sha256").update(randomUUID()).digest("hex");
 await sql.query("insert into public.recurring_costs(business_id,category_code,label,amount_cents,frequency,is_estimate,active_from,due_day) values($1,'rent','Monthly rent',$2,'monthly',false,$3,1)",[finance.businessId,rent,day(finance,-90)]);
 async function statement(from,to,opening,closing){
  const tx=[{i:0,date:from,amountCents:100,balanceCents:opening+100},{i:1,date:to,amountCents:closing-opening-100,balanceCents:closing}];
  return rpc(service,"supervisor_record_statement_evidence",{p_business_id:finance.businessId,p_owner_user_id:finance.ownerUserId,
   p_source_sha256:createHash("sha256").update(JSON.stringify(tx)).digest("hex"),p_account_key:accountKey,p_currency:finance.currency,
   p_from:from,p_to:to,p_opening_cents:opening,p_closing_cents:closing,p_transactions:tx});
 }
 const firstUploadId=await statement(day(finance,-4),day(finance,-3),initialCash+100,initialCash);
 check(typeof firstUploadId==="string","finance_statement_not_saved");
 return {staff:{...staff,taskId:staffTask.id,messageId:firstReply.id,employeeId,shiftId},finance:{...finance,taskId:"financial-review:"+finance.ownerUserId,firstUploadId},
  initialCash,laterCash,async nextStatement(){return statement(day(finance,-2),day(finance,-1),initialCash,laterCash);}};
}
const workerScopes=world=>[world.staff,world.finance].map(s=>({businessId:s.businessId,timezone:s.timezone}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(checkNow,ms,code){
 const deadline=Date.now()+ms;
 while(Date.now()<deadline){if(await checkNow())return;await delay(250);}
 throw Error("task17c:"+code);
}
export async function exerciseOperatingWorld(sql,world){
 const scopes=workerScopes(world),targets=[world.staff,world.finance];
 const episodes=()=>rows(sql,"select business_id,source_id,episode_id,phase,step_version,lease_token,lease_until<=clock_timestamp() as expired,evidence from public.supervisor_investigations where business_id in ($1,$2) order by business_id,source_id",scopes.map(s=>s.businessId));
 await runWorker({mode:"dispatch",scopes});
 const queued=await episodes();
 check(queued.length===2&&targets.every(t=>queued.some(e=>e.business_id===t.businessId&&e.source_id===t.taskId)),"two_independent_incidents_not_enqueued");
 const dir=mkdtempSync(join(tmpdir(),"task17c-crash-")),marker=join(dir,"reserved");
 const interrupted=launchWorker({mode:"interrupt",scopes,marker});
 let held;
 try{
  await until(async()=>{check(interrupted.child.exitCode===null&&interrupted.child.signalCode===null,"worker_exited_before_reservation");return existsSync(marker);},60000,"pretransport_checkpoint_timeout");
  const leases=(await episodes()).filter(e=>e.lease_token);
  check(leases.length===1&&leases[0].phase==="investigate","interrupted_lease_missing");
  held=leases[0];
  const attempts=await rows(sql,"select business_id,status,model from public.supervisor_system_usage_events where business_id in ($1,$2) and status='attempted'",scopes.map(s=>s.businessId));
  check(attempts.length===1&&attempts[0].business_id===held.business_id&&attempts[0].model==="gpt-6-luna","reservation_not_persisted_before_crash");
  process.kill(-interrupted.child.pid,"SIGKILL");
  const [code,signal]=await interrupted.exit;
  check(code===null&&signal==="SIGKILL","real_worker_kill_not_observed");
  await until(async()=>{
   const recovered=(await episodes()).find(e=>e.episode_id===held.episode_id);
   check(recovered?.lease_token===held.lease_token,"abandoned_lease_replaced_before_expiry");return recovered.expired===true;
  },195000,"actual_database_lease_did_not_expire");
 }finally{await interrupted.close();rmSync(dir,{recursive:true,force:true});}
 const recoveryPid=await runWorker({mode:"investigate",scopes},240000);
 check(recoveryPid!==interrupted.child.pid,"replacement_process_identity_missing");
 const recovered=await episodes();
 const staff=world.staff,finance=world.finance;
 const financeBefore=await rows(sql,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and grounding->>'intent'='priority_investigation'",[finance.businessId,finance.threadId]);
 const secondUploadId=await world.nextStatement();
 await runWorker({mode:"dispatch",scopes});
 await runWorker({mode:"investigate",scopes},180000);
 const followed=await episodes();
 const financeAfter=await rows(sql,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and grounding->>'intent'='priority_investigation'",[finance.businessId,finance.threadId]);
 const staffNotices=await rows(sql,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and grounding->>'intent'='priority_investigation'",[staff.businessId,staff.threadId]);
 const financeNew=financeAfter.filter(a=>!financeBefore.some(b=>b.id===a.id));
 const ownerRows=await rows(sql,"select id from public.ai_messages where business_id in ($1,$2) and role='owner'",scopes.map(s=>s.businessId));
 const effects=await rows(sql,"select 1 from public.supervisor_effect_attempts where business_id in ($1,$2)",scopes.map(s=>s.businessId));
 const proposals=await rows(sql,"select id from public.supervisor_proposals where business_id in ($1,$2)",scopes.map(s=>s.businessId));
 const usage=await rows(sql,"select business_id,model,status,input_tokens from public.supervisor_system_usage_events where business_id in ($1,$2)",scopes.map(s=>s.businessId));
 const sources=await rows(sql,"select id,business_id,financial_closing_cents from public.uploads where id in ($1,$2)",[finance.firstUploadId,secondUploadId]);
 const shifts=await rows(sql,"select id,employee_id,status from public.scheduled_shifts where business_id=$1 and id=$2",[staff.businessId,staff.shiftId]);
 const foreignRead=await finance.owner.client.from("supervisor_investigations").select("episode_id").eq("business_id",staff.businessId);
 check(!foreignRead.error&&foreignRead.data.length===0,"cross_tenant_investigation_read");
 return {queued,recovered,followed,financeBefore,financeNew,staffNotices,ownerRows,effects,proposals,usage,sources,shifts,secondUploadId,
  originalPid:interrupted.child.pid,recoveryPid,interruptedEpisode:held.episode_id};
}
if(process.env.AICAFE_17C_TICK){
 const {it,expect}=await import("vitest");
 it("actual Supervisor scheduled and investigation worker",async()=>{
  const {assertLocalLiveEnvironment}=await import("./preflight.mjs");
  const {verifyCheckoutHead}=await import("./runner.mjs");
  assertLocalLiveEnvironment(process.env);verifyCheckoutHead(process.env.HEAD_SHA);
  check(process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_CANDIDATE==="1"&&["17c","17c-autonomy"].includes(process.env.AICAFE_SHARED_LUNA_SCENARIO),"worker_trusted_runner_required");
  const input=JSON.parse(process.env.AICAFE_17C_TICK);
  const {createClient}=await import("@supabase/supabase-js");
  const {dispatchRoutinesForBusiness}=await import("../../../lib/ai/supervisor/routines/dispatch.server.ts");
  const {enqueueInvestigationsForOwner,processNextInvestigation}=await import("../../../lib/ai/supervisor/routines/investigation.server.ts");
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  if(input.mode==="routine"||input.mode==="dispatch"){
   const results=await Promise.all(input.scopes.map(s=>dispatchRoutinesForBusiness(db,s.businessId,s.timezone,new Date(),enqueueInvestigationsForOwner)));
   expect(results.every(x=>x.failed===0)).toBe(true);
   if(input.mode==="routine")expect(results[0].routinesChecked).toBeGreaterThanOrEqual(1);
   return;
  }
  if(input.mode==="interrupt"){
   const interrupted=()=>({[Symbol.asyncIterator](){return {next:async()=>{
    writeFileSync(input.marker,"reserved\n",{flag:"wx",mode:0o600});
    return new Promise((_resolve,reject)=>setTimeout(()=>reject(Error("expected_kill")),240000));
   }};}});
   for(let i=0;i<5;i++){
    const actual=await processNextInvestigation(db,new Date(),interrupted);
    expect(actual.failed).toBe(0);expect(actual.processed).toBe(1);
   }
   throw Error("worker_never_reached_reserved_transport");
  }
  check(input.mode==="investigate","unknown_worker_mode");
  const {openAIProvider}=await import("../../../lib/ai/agent/loop.server.ts");
  const provider=async function*(params,signal){
   check(params.model==="gpt-6-luna"&&Number.isSafeInteger(params.max_output_tokens),"actual_luna_model_required");
   for await(const ev of openAIProvider({...params,max_output_tokens:Math.min(params.max_output_tokens,1200)},signal)){
    if(ev.type==="response.completed")check(ev.response?.model==="gpt-6-luna","unexpected_provider_model");
    yield ev;
   }
  };
  for(let i=0;i<8;i++){
   const actual=await processNextInvestigation(db,new Date(),provider);
   expect(actual.failed).toBe(0);
   if(!actual.processed)return;
  }
  throw Error("unbounded_worker_backlog");
 },225000);
}
