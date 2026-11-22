#!/usr/bin/env node
/** Deferred genuine Luna acceptance for PR552. Never run in ordinary PR CI.
 * Requires separate owner-authorized local provider execution and disposable cafés. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=reason=>{throw Error("staff_question_live:"+reason)};
const local="http://127.0.0.1:3000";
export const STAFF_QUESTION_CASES=Object.freeze([
  {id:"proposal_owner_click_employee_reply",expectedTool:"propose_staff_question",approved:true},
  {id:"ordinary_owner_chat_answer",expectedTool:"record_staff_question_owner_answer",approved:false},
  {id:"ambiguous_or_unrelated_owner_turn",expectedTool:null,approved:false},
  {id:"two_cafe_isolation_and_no_unapproved_send",expectedTool:null,approved:false}
]);
export function requireStaffQuestionDraft(rows,{businessId,ownerId,threadId,sourceId,employeeId,sourceRevision},requestCount){
  if(requestCount!==0||rows.length!==1)fail("unapproved_contact_or_draft_count");
  const p=rows[0],e=p.canonical_effect_payload;
  if(p.business_id!==businessId||p.owner_user_id!==ownerId||p.thread_id!==threadId||
     p.capability_id!=="olivia.staff_question.v1"||p.status!=="draft"||
     e?.sourceKind!=="operating_task"||e.sourceTaskId!==sourceId||
     e.employeeId!==employeeId||Date.parse(e.sourceRevision)!==Date.parse(sourceRevision)||
     !e.question||!Array.isArray(e.evidence)||!e.evidence.length)
    fail("wrong_owner_cafe_source_or_worker_proposal");
  return p;
}
export function requireOwnerAnswer(task,{ownerId,ownerMessageId,answer,proposalId},outboundCount){
  const x=task?.evidence?.find(e=>e?.source==="owner_report")?.facts;
  if(outboundCount!==0||task?.owner_user_id!==ownerId||
     x?.ownerMessageId!==ownerMessageId||x?.proposalId!==proposalId||
     x?.ownerUserId!==ownerId||x?.answer!==answer||x?.independentlyVerified!==false)
    fail("owner_answer_provenance_or_no_contact");
}
const sql=async(db,query,params=[]) => (await db.query(query,params)).rows;
async function login(browser,cafe){
  const context=await browser.newContext({baseURL:local,serviceWorkers:"block"});
  const page=await context.newPage();
  await page.goto("/en/login");
  await page.locator("#email").fill(cafe.owner.email);
  await page.locator("#login-password").fill(cafe.owner.password);
  await page.locator("form button[type=submit]").click();
  await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
  return {context,page};
}
async function newThread(context){
  const res=await context.request.post("/api/ai/threads",{
    headers:{Origin:local},data:{requestId:randomUUID(),title:"Local owner-approved staff question"}});
  if(res.status()!==201)fail("thread_create");
  const id=(await res.json()).thread?.id;
  if(!/^[0-9a-f-]{36}$/i.test(id??""))fail("thread_id_missing");
  return id;
}
async function ownerTurn(page,thread,text){
  const clientMessageId=randomUUID();
  const out=await page.evaluate(async({thread,text,clientMessageId})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
    let pending="",done=null,error=null;const names=[];
    try{
      const res=await fetch("/api/ai/threads/"+thread+"/agent",{method:"POST",
        headers:{"content-type":"application/json"},credentials:"same-origin",signal:controller.signal,
        body:JSON.stringify({clientMessageId,text,locale:"en",attachmentIds:[]})});
      if(!res.ok||!res.body)return {names,done,error:"http_"+res.status};
      const reader=res.body.getReader(),decoder=new TextDecoder();
      while(!done&&!error){
        const packet=await reader.read();if(packet.done)break;
        pending+=decoder.decode(packet.value,{stream:true});
        let pos;while((pos=pending.indexOf("\n\n"))!==-1){
          const lines=pending.slice(0,pos).split("\n");pending=pending.slice(pos+2);
          const ev=lines.find(v=>v.startsWith("event: "))?.slice(7);
          const str=lines.find(v=>v.startsWith("data: "))?.slice(6);
          let payload;try{payload=JSON.parse(str??"null")}catch{payload=null}
          if(ev==="tool"&&typeof payload?.name==="string")names.push(payload.name);
          if(ev==="done"){done=payload;break}
          if(ev==="error"){error=payload?.code??"error";break}
        }
      }
      await reader.cancel().catch(()=>{});
      return {names,done,error:error??(done?null:"no_complete_turn")};
    }catch{return {names,done,error:"transport_failure"}}
    finally{clearTimeout(timer)}
  },{thread,text,clientMessageId});
  if(out.error||out.done?.endReason!=="complete"||
     !/^[0-9a-f-]{36}$/i.test(out.done?.reply?.id??""))fail("real_model_incomplete");
  return {...out,clientMessageId};
}
async function verifiedTurn(db,cafe,thread,turn,requiredTool=null){
  const owner=(await sql(db,"select id::text, text_content from public.ai_messages where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
    [cafe.businessId,thread,turn.clientMessageId]))[0];
  if(!owner)fail("authenticated_owner_message_missing");
  const usage=await readPersistedModelUsage(db,cafe.businessId,owner.id);
  requireObservedProductionModel(usage.model,"gpt-6-luna");
  if(!Number.isInteger(Number(usage.model_call_count))||Number(usage.model_call_count)<1||
     requiredTool&&!turn.names.includes(requiredTool))fail("registered_luna_tool_missing");
  return {message:owner,usage};
}
async function fixture(db,cafe,worker){
  const source="staff-question-live:"+randomUUID();
  const task=(await sql(db,"insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence) "+
   "values($1,$2,$3,'olivia','data_quality','ingredient',$4,'needs_owner',$5::jsonb,'low',$6::jsonb) returning updated_at",
   [cafe.businessId,source,cafe.owner.userId,randomUUID(),
    JSON.stringify({title:"Takeaway cup count unknown; sales do not prove physical shelf inventory"}),
    JSON.stringify([{source:"stored_pos_order_lines",asOf:new Date().toISOString(),physicalCountVerified:false}])]))[0];
  return {source,sourceRevision:task.updated_at,worker};
}
async function proposed(db,owner,cafe,worker,f){
  const thread=await newThread(owner.context);
  const instruction="Investigate the saved operating task "+f.source+
   " for this café. Actual physical takeaway cup count is unknown. Check the task source "+
   "and the current published staff schedule. If the source cannot prove physical count, "+
   "use propose_staff_question for the verified on-shift employee "+
   worker.name+" to ask how many cups are physically left. Do NOT contact anyone yet; "+
   "the owner must approve each proposed question. Include real source/as-of evidence "+
   "and a follow-up a few hours from now.";
  const answer=await ownerTurn(owner.page,thread,instruction);
  await verifiedTurn(db,cafe,thread,answer,"propose_staff_question");
  const rows=await sql(db,"select id::text,business_id::text,owner_user_id::text,thread_id::text,capability_id,status,revision,canonical_effect_payload "+
    "from public.supervisor_proposals where business_id=$1 and thread_id=$2 and capability_id='olivia.staff_question.v1'",
    [cafe.businessId,thread]);
  const contacts=await sql(db,"select count(*)::int n from public.staff_communication_requests where business_id=$1 and source_id=any($2::text[])",
    [cafe.businessId,rows.map(x=>x.id)]);
  const p=requireStaffQuestionDraft(rows,{businessId:cafe.businessId,ownerId:cafe.owner.userId,threadId:thread,
    sourceId:f.source,employeeId:worker.employeeId,sourceRevision:f.sourceRevision},contacts[0].n);
  const cards=await owner.context.request.get("/api/ai/threads/"+thread+"/proposals?ids="+p.id);
  if(cards.status()!==200)fail("owner_card_missing");
  const card=(await cards.json()).cards?.[0];
  if(card?.state!=="pending"||card?.staffQuestion?.employeeName!==worker.name||
     card?.staffQuestion?.question!==p.canonical_effect_payload.question)fail("owner_question_card_mismatch");
  return {thread,p,answer};
}
async function main(){
  const env=process.env;assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
  if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="staff-question"||
     env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")fail("separate_owner_paid_authorization_required");
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
    fail("two_private_proofs_required");
  const repoRoot=realpathSync(process.cwd()),proof=realpathSync("/proof");
  const files=[resolve(args[1]),resolve(args[3])];
  if(files[0]===files[1]||files.some(f=>existsSync(f)||realpathSync(dirname(f))!==proof||
     f.startsWith(repoRoot+sep)))fail("unsafe_proof_paths");
  const [one,two]=TEST_CAFES;
  if(!one?.owner?.userId||!two?.owner?.userId||one.businessId===two.businessId)
    fail("two_cafes_required");
  const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
  const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  let owner,foreign,crew;let calls=0;
  await db.connect();
  try{
    owner=await login(browser,one);foreign=await login(browser,two);
    const employeeId=randomUUID(),userId=randomUUID(),name="Verified live scenario employee";
    const email="staff-question-"+randomUUID()+"@example.invalid",password="local-test-staff-question-only";
    await db.query("insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change) "+
     "values('00000000-0000-0000-0000-000000000000',$1::uuid,'authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','')",
     [userId,email,password]);
    await db.query("insert into auth.identities(id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values($1::uuid,$1::uuid,$1::text,'email',$2::jsonb,now(),now(),now())",
      [userId,JSON.stringify({sub:userId,email,email_verified:true})]);
    await db.query("insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id) "+
      "values($1,$2,$3,true,'hour',1800,$4)",[employeeId,one.businessId,name,userId]);
    await db.query("insert into public.scheduled_shifts(business_id,employee_id,local_date,start_local,end_local,source,status) "+
      "values($1,$2,(now() at time zone (select timezone from public.businesses where id=$1))::date,'00:00','23:59','owner','sent')",
      [one.businessId,employeeId]);
    const worker={employeeId,name,email,password,userId};
    const f=await fixture(db,one,worker);
    const ask=await proposed(db,owner,one,worker,f);calls++;
    const foreignGet=await foreign.context.request.get("/api/ai/threads/"+ask.thread+"/proposals?ids="+ask.p.id);
    if(foreignGet.status()===200&&(await foreignGet.json()).cards?.length)fail("foreign_proposal_visible");
    const approval=await owner.context.request.post("/api/ai/threads/"+ask.thread+"/proposals",{
      headers:{Origin:local},data:{action:"approve",proposalId:ask.p.id,revision:ask.p.revision}});
    if(approval.status()!==200||(await approval.json()).proposal?.state!=="applied")
      fail("owner_click_did_not_commit");
    const requests=await sql(db,"select id::text,prompt,employee_id::text,status from public.staff_communication_requests "+
     "where business_id=$1 and source_id=$2",[one.businessId,ask.p.id]);
    if(requests.length!==1||requests[0].employee_id!==worker.employeeId||
      requests[0].prompt!==ask.p.canonical_effect_payload.question)fail("employee_send_not_exactly_once");
    crew=await browser.newContext({baseURL:local,serviceWorkers:"block"});
    const crewPage=await crew.newPage();
    await crewPage.goto("/crew/login");
    await crewPage.locator("#crew-email").fill(email);
    await crewPage.locator("#crew-password").fill(password);
    await crewPage.getByRole("button",{name:"Sign in"}).click();
    const assignment=crewPage.getByRole("article").filter({hasText:requests[0].prompt});
    await assignment.waitFor({timeout:30000});
    const workerAnswer="I physically counted 40 takeaway cups on the shelf.";
    await assignment.getByRole("textbox",{name:/Add a message or explain/}).fill(workerAnswer);
    await assignment.getByRole("button",{name:"Mark complete"}).click();
    const actual=await sql(db,"select actor,request_id::text,employee_id::text,body from public.staff_communication_messages "+
      "where business_id=$1 and employee_id=$2 and body=$3",[one.businessId,worker.employeeId,workerAnswer]);
    const linked=await sql(db,"select staff_auth_user_id::text from public.employees where business_id=$1 and id=$2",
      [one.businessId,worker.employeeId]);
    if(actual.length!==1||actual[0].actor!=="employee"||actual[0].request_id!==requests[0].id||
       actual[0].employee_id!==worker.employeeId||linked[0]?.staff_auth_user_id!==userId)
      fail("employee_authenticated_provenance_missing");
    const history=await owner.context.request.get("/api/staff-channel/owner-history");
    if(history.status()!==200||!JSON.stringify(await history.json()).includes(workerAnswer))
      fail("owner_history_not_updated");
    const foreignHistory=await foreign.context.request.get("/api/staff-channel/owner-history");
    if(foreignHistory.status()!==200||JSON.stringify(await foreignHistory.json()).includes(workerAnswer))
      fail("foreign_staff_history_leaked");
    // Independent second source + question. Normal Supervisor chat is the ONLY answer UI.
    const second=await fixture(db,one,worker);
    const self=await proposed(db,owner,one,worker,second);calls++;
    const checkNoOwnerReport=async()=>{
      const rows=await sql(db,"select status from public.supervisor_proposals where id=$1",[self.p.id]);
      const outbound=await sql(db,"select count(*)::int n from public.staff_communication_requests where business_id=$1 and source_id=$2",[one.businessId,self.p.id]);
      if(rows[0]?.status!=="draft"||outbound[0]?.n!==0)fail("unauthorized_or_ambiguous_owner_effect");
    };
    const unrelated=await ownerTurn(owner.page,self.thread,"Thanks for looking into it.");
    await verifiedTurn(db,one,self.thread,unrelated);calls++;
    if(unrelated.names.includes("record_staff_question_owner_answer"))fail("unrelated_text_used_as_answer");
    await checkNoOwnerReport();
    const ambiguous=await ownerTurn(owner.page,self.thread,"I do not know the remaining number.");
    await verifiedTurn(db,one,self.thread,ambiguous);calls++;
    if(ambiguous.names.includes("record_staff_question_owner_answer"))fail("unknown_converted_to_fact");
    await checkNoOwnerReport();
    const answerText="I personally counted exactly 40 takeaway cups on that shelf.";
    const ownerAnswer=await ownerTurn(owner.page,self.thread,answerText);
    const answerProof=await verifiedTurn(db,one,self.thread,ownerAnswer,"record_staff_question_owner_answer");calls++;
    const report=(await sql(db,"select owner_user_id::text,evidence from public.operating_tasks "+
      "where business_id=$1 and id=$2",[one.businessId,"staff-question-owner-answer:"+self.p.id]))[0];
    const outbound=await sql(db,"select count(*)::int n from public.staff_communication_requests where business_id=$1 and source_id=$2",[one.businessId,self.p.id]);
    requireOwnerAnswer(report,{ownerId:one.owner.userId,ownerMessageId:answerProof.message.id,
      answer:answerText,proposalId:self.p.id},outbound[0].n);
    const finalCard=await owner.context.request.get("/api/ai/threads/"+self.thread+"/proposals?ids="+self.p.id);
    if(finalCard.status()!==200||(await finalCard.json()).cards?.[0]?.staffQuestion?.answeredByOwner!==answerText)
      fail("saved_owner_answer_not_visible");
    const receiptCount=await sql(db,"select count(*)::int n from public.staff_communication_requests where business_id=$1 and source_id=$2",[one.businessId,ask.p.id]);
    if(receiptCount[0]?.n!==1)fail("duplicate_employee_dispatch");
    writeFileSync(files[0],JSON.stringify({schema_version:1,task:"pr552-staff-question",
      head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",model_turns:calls,
      cases:STAFF_QUESTION_CASES.map(c=>c.id),feature_proven:false,production_activated:false},null,2)+"\n",
      {mode:0o600,flag:"wx"});
    writeFileSync(files[1],JSON.stringify({businessId:one.businessId,foreignBusinessId:two.businessId,
      firstThread:ask.thread,ownerAnswerThread:self.thread,ownerAnswerMessageId:answerProof.message.id,
      firstSource:f.source,secondSource:second.source,employeeId,requestId:requests[0].id},null,2)+"\n",
      {mode:0o600,flag:"wx"});
  }finally{
    await crew?.close().catch(()=>{});await foreign?.context.close().catch(()=>{});
    await owner?.context.close().catch(()=>{});await browser.close().catch(()=>{});
    await db.end().catch(()=>{});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e instanceof Error&&e.message.startsWith("staff_question_live:")?
    e.message:"staff_question_live:unverified_failure");process.exitCode=1});
