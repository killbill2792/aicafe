import {test,expect} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment,seededCafe,login,openOwnedPage} from "./seeded-auth.mjs";

test.beforeEach(()=>assertDisposableEnvironment());
const canonical=value=>Array.isArray(value)?value.map(canonical):
 value&&typeof value==="object"?Object.fromEntries(Object.entries(value)
  .sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;

test("@staff @home owner-approved factual question reaches one verified worker; ordinary owner reply is attributed",async({browser})=>{
 test.setTimeout(220_000);
 const cafe=seededCafe(0),foreign=seededCafe(1);
 const id={thread:randomUUID(),source:"staff-question-e2e:"+randomUUID(),
  employee:randomUUID(),worker:randomUUID(),proposal:randomUUID(),answerProposal:randomUUID(),ignoreProposal:randomUUID(),
  ownerMessage:randomUUID(),shift:randomUUID()};
 const question="How many takeaway cups are left on the shelf?";
 const workerReply="There are 40 takeaway cups left on the shelf.";
 const email="worker-"+randomUUID()+"@example.invalid",password="local-test-staff-question-2026";
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
  user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const contexts=[];let connected=false;
 try{
  await db.connect();connected=true;
  await db.query("insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change) values ('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','')",[id.worker,email,password]);
  await db.query("insert into auth.identities(id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values($1::uuid,$1::uuid,$1::text,'email',$2::jsonb,now(),now(),now())",
   [id.worker,JSON.stringify({sub:id.worker,email,email_verified:true})]);
  await db.query("insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id) values($1,$2,'Counted stock worker',true,'hour',1800,$3)",
   [id.employee,cafe.businessId,id.worker]);
  await db.query("insert into public.scheduled_shifts(id,business_id,employee_id,local_date,start_local,end_local,source,status) values($1,$2,$3,(now() at time zone (select timezone from public.businesses where id=$2))::date,'00:00','23:59','owner','sent')",
   [id.shift,cafe.businessId,id.employee]);
  await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,'Employee question approval')",
   [id.thread,cafe.businessId,cafe.owner.userId,randomUUID()]);
  const task=(await db.query(`insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,entity_type,entity_id,status,payload,confidence,evidence) values($1,$2,$3,'olivia','data_quality','ingredient',$4,'needs_owner',$5::jsonb,'low','[]') returning to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as source_revision`,
   [cafe.businessId,id.source,cafe.owner.userId,randomUUID(),JSON.stringify({title:"Cup usage needs a physical check"})])).rows[0];
  const effect={sourceKind:"operating_task",sourceTaskId:id.source,employeeId:id.employee,
   question,reason:"Sales and inventory records do not prove the physical count",
   evidence:[{source:"order_lines",asOf:new Date().toISOString()}],
   followUpAfter:new Date(Date.now()+3*3600_000).toISOString(),
   sourceRevision:task.source_revision,employeeName:"Counted stock worker"};
  // Never round PostgreSQL microseconds through JS Date; SQL compares exact revisions.
  expect(task.source_revision).toMatch(/\.\d{6}Z$/);
  const hash=createHash("sha256").update(JSON.stringify(canonical(effect))).digest("hex");
  await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) values($1,$2,$3,$4,$5,'olivia.staff_question.v1',1,$6::jsonb,$7,'{}','{\"durationDays\":1,\"metricScope\":\"staff_question_receipt\"}','en')",
   [id.proposal,cafe.businessId,cafe.owner.userId,id.thread,randomUUID(),JSON.stringify(effect),hash]);
  await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,null,'supervisor','blocks',$4::jsonb,$5::jsonb)",
   [cafe.businessId,id.thread,cafe.owner.userId,JSON.stringify([{type:"text",text:"I need a physical count before drawing conclusions."},{type:"proposal_card",proposalId:id.proposal}]),
    JSON.stringify({status:"partial",intent:"owner_review",evidence:[{source:"operating_task",identifier:id.source}]})]);
  const ownerCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",viewport:{width:1440,height:900},serviceWorkers:"block"});
  contexts.push(ownerCtx);const owner=await ownerCtx.newPage();
  await login(owner,cafe);
  // The shared authenticated-navigation helper asserts the visible desktop
  // café header. Exercise the real responsive question UI after navigation.
  await openOwnedPage(owner,cafe,"?thread="+encodeURIComponent(id.thread));
  await owner.setViewportSize({width:390,height:844});
  const proposal=owner.getByRole("region",{name:"Ask an employee?"});
  await expect(proposal).toBeVisible({timeout:30_000});
  await expect(proposal.getByText(question)).toBeVisible();
  await expect(proposal.getByRole("button",{name:"Go ahead and ask"})).toBeVisible();
  await expect(proposal.getByRole("button",{name:"Ignore"})).toBeVisible();
  await expect(proposal.getByRole("button",{name:"Answer myself"})).toHaveCount(0);
  const receiptWait=owner.waitForResponse(resp=>resp.request().method()==="POST"&&resp.url().includes("/proposals"));
  await proposal.getByRole("button",{name:"Go ahead and ask"}).click();
  const receipt=await receiptWait;
  expect(receipt.status()).toBe(200);
  const requests=(await db.query("select id,prompt,employee_id from public.staff_communication_requests where business_id=$1 and source_id=$2",
   [cafe.businessId,id.proposal])).rows;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({prompt:question,employee_id:id.employee});
  const workerCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(workerCtx);const worker=await workerCtx.newPage();
  await worker.goto("/crew/login");
  await worker.locator("#crew-email").fill(email);
  await worker.locator("#crew-password").fill(password);
  await worker.getByRole("button",{name:"Sign in"}).click();
  await expect(worker).toHaveURL(/\/crew(?:\?|$)/,{timeout:30_000});
  const assigned=worker.getByRole("article").filter({hasText:question});
  await expect(assigned).toBeVisible({timeout:20_000});
  await assigned.getByRole("textbox",{name:/Add a message or explain/}).fill(workerReply);
  const answerWait=worker.waitForResponse(response=>
   new URL(response.url()).pathname==="/api/staff-channel"&&response.request().method()==="POST");
  await assigned.getByRole("button",{name:"Mark complete"}).click();
  expect((await answerWait).status()).toBe(200);
  await expect.poll(async()=>{
   const res=await workerCtx.request.get("/api/staff-channel");
   if(res.status()!==200)return false;
   return (await res.json()).messages.some(m=>
    m.actor==="employee"&&m.body===workerReply);
  },{timeout:30_000}).toBe(true);
  await expect(worker.getByText(workerReply)).toBeVisible({timeout:20_000});
  await owner.setViewportSize({width:1440,height:900});
  await openOwnedPage(owner,cafe,"staff");
  const history=owner.getByRole("region",{name:"Employee Supervisor communication history"});
  await expect(history.getByText(workerReply)).toBeVisible({timeout:30_000});
  const foreignCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(foreignCtx);const other=await foreignCtx.newPage();
  await login(other,foreign);
  const otherHistory=await foreignCtx.request.get("/api/staff-channel/owner-history");
  expect(otherHistory.status()).toBe(200);
  expect(JSON.stringify(await otherHistory.json())).not.toContain(workerReply);
  const employeeRows=(await db.query("select count(*)::int n from public.staff_communication_messages where business_id=$1 and employee_id=$2 and actor='employee' and body=$3",
   [cafe.businessId,id.employee,workerReply])).rows;
  expect(employeeRows[0].n).toBe(1);
  expect((await db.query("select count(*)::int n from public.staff_communication_requests where business_id=$1 and source_id=$2",
   [cafe.businessId,id.proposal])).rows[0].n).toBe(1);

   // Independent card: Ignore rejects exactly this question without outreach.
   const ignoreQuestion="Do the spare cup lids still need counting?";
   const ignoreEffect={...effect,question:ignoreQuestion};
   const ignoreHash=createHash("sha256").update(JSON.stringify(canonical(ignoreEffect))).digest("hex");
   await db.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) "+
    "values($1,$2,$3,$4,$5,'olivia.staff_question.v1',1,$6::jsonb,$7,'{}',$8::jsonb,'en')",
    [id.ignoreProposal,cafe.businessId,cafe.owner.userId,id.thread,randomUUID(),JSON.stringify(ignoreEffect),ignoreHash,
     JSON.stringify({durationDays:1,metricScope:"staff_question_receipt"})]);
   await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,structured_content,grounding) "+
    "values($1,$2,$3,null,'supervisor','blocks',$4::jsonb,$5::jsonb)",
    [cafe.businessId,id.thread,cafe.owner.userId,JSON.stringify([{type:"text",text:"A separate check would require permission."},
      {type:"proposal_card",proposalId:id.ignoreProposal}]),
     JSON.stringify({status:"partial",intent:"owner_review",evidence:[{source:"operating_task",identifier:id.source}]})]);
   await openOwnedPage(owner,cafe,"?thread="+encodeURIComponent(id.thread));
   await owner.setViewportSize({width:390,height:844});
   const ignored=owner.getByRole("region",{name:"Ask an employee?"}).filter({hasText:ignoreQuestion});
   await expect(ignored.getByRole("button",{name:"Ignore"})).toBeVisible();
   const ignoreWait=owner.waitForResponse(resp=>resp.request().method()==="POST"&&resp.url().includes("/proposals"));
   await ignored.getByRole("button",{name:"Ignore"}).click();
   expect((await ignoreWait).status()).toBe(200);
   expect((await db.query("select status from public.supervisor_proposals where id=$1",
     [id.ignoreProposal])).rows[0].status).toBe("rejected");
   expect((await db.query("select count(*)::int n from public.staff_communication_requests where source_id=$1",
     [id.ignoreProposal])).rows[0].n).toBe(0);
   const foreignProposal=await foreignCtx.request.get("/api/ai/threads/"+id.thread+"/proposals?ids="+id.ignoreProposal);
   expect([401,403,404]).toContain(foreignProposal.status());

 }finally{
  for(const context of contexts)await context.close().catch(()=>{});
  if(connected){
   await db.query("delete from public.staff_communication_messages where business_id=$1 and employee_id=$2",[cafe.businessId,id.employee]).catch(()=>{});
   await db.query("delete from public.staff_communication_requests where business_id=$1 and employee_id=$2",[cafe.businessId,id.employee]).catch(()=>{});
   await db.query("delete from public.scheduled_shifts where id=$1",[id.shift]).catch(()=>{});
   await db.query("delete from public.operating_tasks where business_id=$1 and id=$2",[cafe.businessId,id.source]).catch(()=>{});
   await db.query("delete from auth.users where id=$1",[id.worker]).catch(()=>{});
   await db.end().catch(()=>{});
  }
 }
});
