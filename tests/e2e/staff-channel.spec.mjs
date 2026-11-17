import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment,seededCafe,login,openOwnedPage} from "./seeded-auth.mjs";

test.beforeEach(()=>assertDisposableEnvironment());

test("@staff real worker login, shift explanation, cross-cafe and owner receipt",async({browser})=>{
 test.setTimeout(180_000);
 const cafes=[seededCafe(0),seededCafe(1)];
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
  user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const contexts=[],created=[];
 let connected=false;
 try{
  await db.connect();connected=true;
  for(const cafe of cafes){
   const userId=randomUUID(),shiftId=randomUUID();
   const worker=(await db.query("select id,display_name from public.employees where business_id=$1 and active=true order by id limit 1",
    [cafe.businessId])).rows[0];
   expect(worker?.id).toBeTruthy();
   const email="13c-crew-"+randomUUID()+"@example.invalid";
   const password="local-disposable-13c-crew";
   await db.query("insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change) values ('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','')",
    [userId,email,password]);
   await db.query("insert into auth.identities (id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values($1,$1,$1,'email',$2::jsonb,now(),now(),now())",
    [userId,JSON.stringify({sub:userId,email,email_verified:true})]);
   created.push({cafe,worker,userId,shiftId,email,password});
  }
  const ownerCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(ownerCtx);
  const owner=await ownerCtx.newPage();
  await login(owner,cafes[0]);
  await openOwnedPage(owner,cafes[0],"staff");
  await expect(owner.getByRole("heading",{name:"Employee login access"})).toBeVisible({timeout:30_000});
  await owner.locator("#staff-account-person").selectOption(created[0].worker.id);
  await owner.locator("#staff-account-email").fill(created[0].email);
  await owner.getByRole("button",{name:"Link existing login"}).click();
  await expect(owner.getByText("Existing confirmed login linked.")).toBeVisible();

  const otherCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(otherCtx);
  const otherOwner=await otherCtx.newPage();
  await login(otherOwner,cafes[1]);
  await openOwnedPage(otherOwner,cafes[1],"staff");
  await expect(otherOwner.getByRole("heading",{name:"Employee login access"})).toBeVisible();
  await otherOwner.locator("#staff-account-person").selectOption(created[1].worker.id);
  await otherOwner.locator("#staff-account-email").fill(created[1].email);
  await otherOwner.getByRole("button",{name:"Link existing login"}).click();
  await expect(otherOwner.getByText("Existing confirmed login linked.")).toBeVisible();

  for(const item of created){
   const date=(await db.query("select (now() at time zone timezone)::date + 2 as date from public.businesses where id=$1",
    [item.cafe.businessId])).rows[0].date;
   await db.query("insert into public.scheduled_shifts (id,business_id,employee_id,local_date,start_local,end_local,source,status) values($1,$2,$3,$4,'07:00','14:00','owner','sent')",
    [item.shiftId,item.cafe.businessId,item.worker.id,date]);
  }
  const staffCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(staffCtx);
  const staff=await staffCtx.newPage();
  await staff.goto("/crew/login");
  await staff.locator("#crew-email").fill(created[0].email);
  await staff.locator("#crew-password").fill(created[0].password);
  await staff.getByRole("button",{name:"Sign in"}).click();
  await expect(staff).toHaveURL(/\/crew(?:\?|$)/,{timeout:30_000});
  await expect(staff.getByRole("heading",{name:"Hello, "+created[0].worker.display_name})).toBeVisible();
  const card=staff.getByRole("article").filter({hasText:"Confirm your shift"}).first();
  await expect(card.getByText(/07:00.*14:00/)).toBeVisible();
  await card.getByRole("textbox",{name:/Add a message or explain/})
   .fill("I cannot work seven to two. I can arrive at 8 AM.");
  await card.getByRole("button",{name:"Cannot work"}).click();
  await expect(staff.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toBeVisible({timeout:20_000});

  const inbox=await staffCtx.request.get("/api/staff-channel");
  expect(inbox.status()).toBe(200);
  const own=await inbox.json();
  expect(own.requests.some(r=>r.id)).toBe(true);
  expect(JSON.stringify(own)).not.toContain(created[1].worker.display_name);
  expect((await staffCtx.request.get("/api/staff-channel/link")).status()).toBe(403);
  const privatePage=await staffCtx.request.get("/en/money?view=profit",{maxRedirects:0});
  expect([302,303,307,308,401,403]).toContain(privatePage.status());

  await owner.reload();
  await expect(owner.getByRole("heading",{name:"Employee responses and reports"}))
   .toBeVisible({timeout:30_000});
  await expect(owner.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toBeVisible();
  await owner.locator("#staff-reply-person").selectOption(created[0].worker.id);
  await owner.locator("#staff-reply-body").fill("Thanks for the update. Can you confirm 8 AM?");
  await owner.getByRole("button",{name:"Send to employee"}).click();
  await expect(owner.getByText("Message saved to this employee's work inbox. Not a read or delivery receipt."))
   .toBeVisible();
  await staff.reload();
  await expect(staff.getByText("Message from café owner")).toBeVisible();
  await expect(staff.getByText("Thanks for the update. Can you confirm 8 AM?")).toBeVisible();
  // The same channel accepts a task/checklist from any future authorized
  // staff-workflow producer; the worker's completion is actual evidence.
  await owner.locator("#staff-work-kind").selectOption("checklist");
  await owner.locator("#staff-work-title").fill("Inspect opening grinder");
  await owner.locator("#staff-work-prompt").fill("Check grinder noise before opening");
  await owner.getByRole("button",{name:"Assign work"}).click();
  await expect(owner.getByText("Assignment saved to this employee's work inbox."))
   .toBeVisible({timeout:20_000});
  await staff.reload();
  const assigned=staff.getByRole("article").filter({hasText:"Inspect opening grinder"});
  await expect(assigned).toBeVisible({timeout:20_000});
  await assigned.getByRole("textbox",{name:/Add a message or explain/})
   .fill("Checked grinder; minor noise remains.");
  await assigned.getByRole("button",{name:"Mark complete"}).click();
  await expect(staff.getByText("Checked grinder; minor noise remains.")).toBeVisible({timeout:20_000});
  await owner.reload();
  await expect(owner.getByText("Checked grinder; minor noise remains.")).toBeVisible({timeout:20_000});
  await otherOwner.reload();
  await expect(otherOwner.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toHaveCount(0);
  const shift=(await db.query("select start_local,status from public.scheduled_shifts where id=$1",
   [created[0].shiftId])).rows[0];
  expect(shift.status).toBe("sent");
  expect(String(shift.start_local).startsWith("07:00")).toBe(true);
 }finally{
  for(const ctx of contexts)await ctx.close().catch(()=>{});
  if(connected)for(const item of created){
   await db.query("delete from public.operating_tasks where business_id=$1 and entity_type='staff_message' and entity_id in (select id::text from public.staff_communication_messages where business_id=$1 and employee_id=$2)",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.staff_communication_messages where business_id=$1 and employee_id=$2",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.staff_communication_requests where business_id=$1 and employee_id=$2",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.scheduled_shifts where id=$1",[item.shiftId]).catch(()=>{});
   await db.query("delete from auth.users where id=$1",[item.userId]).catch(()=>{});
  }
  await db.end().catch(()=>{});
 }
});
