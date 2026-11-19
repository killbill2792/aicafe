import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment,seededCafe,login,openOwnedPage} from "./seeded-auth.mjs";

test.beforeEach(()=>assertDisposableEnvironment());

test("@staff owner saves real recruitment and leave coordination with no automatic hire or roster change",async({browser})=>{
 test.setTimeout(180_000);
 const [cafe,foreign]=[seededCafe(0),seededCafe(1)];
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
  user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const contexts=[],created=[];
 try{
  await db.connect();
  const employee=(await db.query("select id from public.employees where business_id=$1 and active=true limit 1",
   [cafe.businessId])).rows[0];
  expect(employee?.id).toBeTruthy();
  const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(ctx);
  const page=await ctx.newPage();
  await login(page,cafe);
  await openOwnedPage(page,cafe,"staff");
  const panel=page.getByRole("region",{name:"Recruitment leave and onboarding coordination"});
  await expect(panel.getByRole("heading",{name:"Staff coordination"})).toBeVisible({timeout:30_000});
  const beforeCount=Number((await db.query("select count(*)::int AS n from public.employees where business_id=$1",
   [cafe.businessId])).rows[0].n);
  await panel.getByLabel("Case type").selectOption("recruitment");
  await panel.getByLabel("Role needed").fill("Weekend coverage");
  await panel.getByRole("button",{name:"Record coordination need"}).click();
  await expect(panel.getByText("Recruitment need — needs owner decision")).toBeVisible({timeout:20_000});
  const recruitment=(await db.query("select id,source_kind,state,decision from public.staff_coordination_cases where business_id=$1 and case_kind='recruitment' and role_needed=$2 order by created_at desc limit 1",
   [cafe.businessId,"Weekend coverage"])).rows[0];
  expect(recruitment).toMatchObject({source_kind:"owner_record",state:"needs_owner_decision",decision:null});
  created.push(recruitment.id);
  await panel.getByRole("button",{name:"Approve next step (no automatic effect)"}).first().click();
  await expect(panel.getByText("Owner authorized the next step. A real effect and verified source receipt are still required.")).toBeVisible();
  const decision=(await db.query("select state,decision from public.staff_coordination_cases where id=$1",
   [recruitment.id])).rows[0];
  expect(decision).toMatchObject({state:"approved",decision:"approve"});
  const afterCount=Number((await db.query("select count(*)::int AS n from public.employees where business_id=$1",
   [cafe.businessId])).rows[0].n);
  expect(afterCount).toBe(beforeCount);

  await panel.getByLabel("Case type").selectOption("leave");
  await panel.getByLabel("Employee").selectOption(employee.id);
  const firstDay=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const lastDay=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  await panel.getByLabel("First leave day").fill(firstDay);
  await panel.getByLabel("Last leave day").fill(lastDay);
  await panel.getByRole("button",{name:"Record coordination need"}).click();
  await expect(panel.getByText("Leave request — needs owner decision")).toBeVisible({timeout:20_000});
  const leave=(await db.query("select id,state from public.staff_coordination_cases where business_id=$1 and case_kind='leave' and employee_id=$2 and from_date=$3 order by created_at desc limit 1",
   [cafe.businessId,employee.id,firstDay])).rows[0];
  expect(leave?.state).toBe("needs_owner_decision");
  created.push(leave.id);
  const changed=await db.query("select count(*)::int AS n from public.staff_availability_exceptions where business_id=$1 and employee_id=$2 and local_date between $3 and $4 and exception_type='approved_leave'",
   [cafe.businessId,employee.id,firstDay,lastDay]);
  const baseLeaves=Number(changed.rows[0].n);
  // Sending a case to Supervisor must not create even one confirmed leave day.
  expect(Number((await db.query("select count(*)::int AS n from public.staff_availability_exceptions where business_id=$1 and employee_id=$2 and local_date between $3 and $4 and exception_type='approved_leave'",
   [cafe.businessId,employee.id,firstDay,lastDay])).rows[0].n)).toBe(baseLeaves);

  const foreignCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(foreignCtx);
  const other=await foreignCtx.newPage();
  await login(other,foreign);
  const foreignRead=await foreignCtx.request.get("/api/staff-coordination");
  expect(foreignRead.status()).toBe(200);
  expect(JSON.stringify(await foreignRead.json())).not.toContain(recruitment.id);
  expect(JSON.stringify(await foreignRead.json().catch(()=>({})))).not.toContain(leave.id);
  // Direct foreign API decision fails, even with a known case UUID.
  const foreignAttempt=await other.evaluate(async input=>{
    const res=await fetch("/api/staff-coordination",{method:"POST",
     headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    return res.status;
   },{action:"decide",caseId:recruitment.id,revision:2,choice:"decline"});
  expect([400,403,409]).toContain(foreignAttempt);
 }finally{
  for(const ctx of contexts)await ctx.close().catch(()=>{});
  for(const id of created)await db.query("delete from public.staff_coordination_cases where id=$1",[id]).catch(()=>{});
  await db.end().catch(()=>{});
 }
});

test("@staff owner assigns onboarding through 13C and employee completion is independently verified",async({browser})=>{
 test.setTimeout(180_000);
 const cafe=seededCafe(0),employeeId=randomUUID(),staffUserId=randomUUID();
 const email="13d-crew-"+randomUUID()+"@example.invalid",password="disposable-13d-crew-password";
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
  user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const contexts=[];let caseId=null,requestId=null,connected=false;
 try{
  await db.connect();connected=true;
  await db.query("insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change) values ('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','')",
   [staffUserId,email,password]);
  await db.query("insert into auth.identities (id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values($1,$1,$1,'email',$2::jsonb,now(),now(),now())",
   [staffUserId,JSON.stringify({sub:staffUserId,email,email_verified:true})]);
  await db.query("insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,staff_auth_user_id) values($1,$2,'13D onboarding worker',true,'hour',1800,$3)",
   [employeeId,cafe.businessId,staffUserId]);
  const ownerCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(ownerCtx);
  const page=await ownerCtx.newPage();
  await login(page,cafe);
  await openOwnedPage(page,cafe,"staff");
  const panel=page.getByRole("region",{name:"Recruitment leave and onboarding coordination"});
  await expect(panel.getByRole("heading",{name:"Staff coordination"})).toBeVisible({timeout:30_000});
  await panel.getByLabel("Case type").selectOption("onboarding");
  await panel.getByLabel("Employee").selectOption(employeeId);
  await panel.getByRole("button",{name:"Record coordination need"}).click();
  const caseRow=panel.getByRole("listitem").filter({hasText:"Onboarding coordination — needs owner decision"}).first();
  await expect(caseRow).toBeVisible({timeout:20_000});
  caseId=(await db.query("select id from public.staff_coordination_cases where business_id=$1 and case_kind='onboarding' and employee_id=$2 order by created_at desc limit 1",
   [cafe.businessId,employeeId])).rows[0]?.id;
  expect(caseId).toBeTruthy();
  await caseRow.getByRole("button",{name:"Approve next step (no automatic effect)"}).click();
  const approved=panel.getByRole("listitem").filter({hasText:"Onboarding coordination — approved"}).first();
  await expect(approved.getByRole("button",{name:"Assign employee onboarding checklist"})).toBeVisible();
  await approved.getByRole("button",{name:"Assign employee onboarding checklist"}).click();
  await expect(panel.getByText("Employee checklist assigned. Waiting for authenticated staff completion; a message send alone is not acceptance.")).toBeVisible({timeout:20_000});
  const receipt=(await db.query("select r.id,r.kind,r.status from public.staff_communication_requests r join public.staff_coordination_evidence e on e.business_id=r.business_id and e.source_id=r.id::text where e.case_id=$1 and e.evidence_key='onboarding_checklist'",
   [caseId])).rows[0];
  expect(receipt).toMatchObject({kind:"checklist",status:"open"});
  requestId=receipt.id;
  expect(Number((await db.query("select count(*)::int AS n from public.staff_communication_messages where request_id=$1",
   [requestId])).rows[0].n)).toBe(0);

  const staffCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(staffCtx);
  const staff=await staffCtx.newPage();
  await staff.goto("/crew/login");
  await staff.locator("#crew-email").fill(email);
  await staff.locator("#crew-password").fill(password);
  await staff.getByRole("button",{name:"Sign in"}).click();
  await expect(staff).toHaveURL(/\/crew(?:\?|$)/,{timeout:30_000});
  const assignment=staff.getByRole("article").filter({hasText:"Complete onboarding checklist"}).first();
  await expect(assignment.getByRole("button",{name:"Mark complete"})).toBeVisible({timeout:20_000});
  await assignment.getByRole("button",{name:"Mark complete"}).click();
  await expect(staff.getByRole("status").filter({hasText:"Response saved."})).toBeVisible({timeout:20_000});
  const completed=await db.query("select id from public.staff_communication_messages where business_id=$1 and employee_id=$2 and request_id=$3 and actor='employee' and response_code='complete'",
   [cafe.businessId,employeeId,requestId]);
  expect(completed.rows).toHaveLength(1);
  // Invoke the SAME existing service-only reconciliation RPC as the shared cron.
  await db.query("BEGIN");
  try{
   await db.query("SET LOCAL ROLE service_role");
   await db.query("select set_config('request.jwt.claim.role','service_role',true)");
   await db.query("update public.staff_coordination_cases set next_check_at=now() where id=$1 and business_id=$2",
    [caseId,cafe.businessId]);
   await db.query("select public.staff_coordination_reconcile($1)",[cafe.businessId]);
   await db.query("COMMIT");
  }catch(e){await db.query("ROLLBACK");throw e;}
  const verified=(await db.query("select state from public.staff_coordination_cases where id=$1",
   [caseId])).rows[0];
  expect(verified?.state).toBe("completed");
  await panel.getByRole("button",{name:"Refresh"}).click();
  await expect(panel.getByText("Onboarding coordination — completed")).toBeVisible({timeout:20_000});
 }finally{
  for(const ctx of contexts)await ctx.close().catch(()=>{});
  if(connected){
   if(caseId)await db.query("delete from public.operating_tasks where business_id=$1 and entity_type='staff_coordination_case' and entity_id=$2",
    [cafe.businessId,caseId]).catch(()=>{});
   await db.query("delete from public.operating_tasks where business_id=$1 and entity_type='staff_message' and entity_id in (select id::text from public.staff_communication_messages where employee_id=$2 and business_id=$1)",
    [cafe.businessId,employeeId]).catch(()=>{});
   await db.query("delete from public.staff_communication_messages where business_id=$1 and employee_id=$2",[cafe.businessId,employeeId]).catch(()=>{});
   if(caseId)await db.query("delete from public.staff_coordination_cases where id=$1",[caseId]).catch(()=>{});
   await db.query("delete from public.staff_communication_requests where business_id=$1 and employee_id=$2",[cafe.businessId,employeeId]).catch(()=>{});
   await db.query("delete from public.employees where id=$1 and business_id=$2",[employeeId,cafe.businessId]).catch(()=>{});
   await db.query("delete from auth.users where id=$1",[staffUserId]).catch(()=>{});
   await db.end().catch(()=>{});
  }
 }
});
