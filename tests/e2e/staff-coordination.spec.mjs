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
