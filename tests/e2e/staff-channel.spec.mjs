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
  for(const [index,cafe] of cafes.entries()){
   const userId=randomUUID(),shiftId=randomUUID();
   const worker=(await db.query("select id,display_name from public.employees where business_id=$1 and active=true order by id limit 1",
    [cafe.businessId])).rows[0];
   expect(worker?.id).toBeTruthy();
   const email="13c-crew-"+randomUUID()+"@example.invalid";
   const password="local-disposable-13c-crew";
   // One café exercises real owner Admin-Auth creation via the UI;
   // the other keeps the original already-confirmed-login link path.
   if(index===1){
   await db.query("insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change) values ('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','')",
    [userId,email,password]);
   await db.query("insert into auth.identities (id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values($1::uuid,$1::uuid,$1::text,'email',$2::jsonb,now(),now(),now())",
    [userId,JSON.stringify({sub:userId,email,email_verified:true})]);
   }
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
  await owner.locator("#staff-account-password").fill(created[0].password);
  const createReceipt=owner.waitForResponse(resp=>resp.url().includes("/api/staff-channel/link")&&
   resp.request().method()==="POST");
  await owner.getByRole("button",{name:"Create employee login"}).click();
  const createdReceipt=await createReceipt;
  expect(createdReceipt.status()).toBe(200);
  // The UI initiates router.refresh immediately after its successful response.
  // Reading a second copy of that response body through Playwright can hang
  // across RSC navigation. Verify the real owner UI and DB-linked identity
  // instead; route unit tests independently assert the exact JSON contract.
  await expect(owner.getByText(/Staff login created and linked/)).toBeVisible();
  await expect(owner.getByRole("button",{name:"Copy staff sign-in link"})).toBeVisible();
  const firstAuth=await db.query("select id from auth.users where email=$1",[created[0].email]);
  expect(firstAuth.rows).toHaveLength(1);
  created[0].userId=firstAuth.rows[0].id;
  const linked=(await db.query("select staff_auth_user_id::text from public.employees where business_id=$1 and id=$2",
   [cafes[0].businessId,created[0].worker.id])).rows[0];
  expect(linked.staff_auth_user_id).toBe(created[0].userId);
  // Linking updates the owner reply selector without a manual page reload.
  await expect(owner.locator('#staff-reply-person option[value="'+created[0].worker.id+'"]'))
   .toHaveCount(1,{timeout:20_000});

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
  // Record an actual worker-only timecard and an existing break discrepancy.
  // No coworkers, wages or owner-only totals may leave the /crew projection.
  const ownCardId=randomUUID(),otherCardId=randomUUID();
  await db.query("insert into public.timecards(id,business_id,employee_id,pos_timecard_id,clock_in,clock_out,breaks,source_type,source_provider) values($1,$2,$3,$4,now()-interval '2 days',now()-interval '2 days'+interval '7 hours','[]'::jsonb,'connected_pos','Toast')",
   [ownCardId,created[0].cafe.businessId,created[0].worker.id,"staff-own-"+ownCardId]);
  await db.query("insert into public.timecards(id,business_id,employee_id,pos_timecard_id,clock_in,clock_out,breaks,source_type,source_provider) values($1,$2,$3,$4,now()-interval '2 days',now()-interval '2 days'+interval '9 hours','[]'::jsonb,'connected_pos','Toast')",
   [otherCardId,created[1].cafe.businessId,created[1].worker.id,"staff-other-"+otherCardId]);
  await db.query("insert into public.staff_rule_alerts(business_id,timecard_id,employee_id,rule_key,message,status) values($1,$2,$3,'meal','Check your recorded meal break','new')",
   [created[0].cafe.businessId,ownCardId,created[0].worker.id]);
  created[0].timecardId=ownCardId;created[1].timecardId=otherCardId;
  const staffCtx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  contexts.push(staffCtx);
  const staff=await staffCtx.newPage();
  await staff.goto("/crew/login");
  await staff.locator("#crew-email").fill(created[0].email);
  await staff.locator("#crew-password").fill(created[0].password);
  await staff.getByRole("button",{name:"Sign in"}).click();
  await expect(staff).toHaveURL(/\/crew(?:\?|$)/,{timeout:30_000});
  await expect(staff.getByRole("heading",{name:"Hello, "+created[0].worker.display_name})).toBeVisible();
  const personal=staff.getByRole("region",{name:"My schedule, hours and breaks"});
  await expect(personal.getByText("My upcoming published shifts")).toBeVisible();
  await expect(personal.getByText("7 recorded hours")).toBeVisible();
  await expect(personal.getByText("Check your recorded meal break")).toBeVisible();
  expect(await personal.getByText("9 recorded hours").count()).toBe(0);
  const card=staff.getByRole("article").filter({hasText:"Confirm your shift"}).first();
  await expect(card.getByText(/07:00.*14:00/)).toBeVisible();
  await card.getByRole("textbox",{name:/Add a message or explain/})
   .fill("I cannot work seven to two. I can arrive at 8 AM.");
  const replyWait=staff.waitForResponse(response=>
   new URL(response.url()).pathname==="/api/staff-channel"&&response.request().method()==="POST");
  await card.getByRole("button",{name:"Cannot work"}).click();
  expect((await replyWait).status()).toBe(200);
  // Read the employee-scoped canonical inbox as well as verifying the visible
  // confirmed receipt; never pass a UI-only local echo for an unsaved answer.
  await expect.poll(async()=>{
   const res=await staffCtx.request.get("/api/staff-channel");
   if(res.status()!==200)return false;
   return (await res.json()).messages.some(m=>
    m.actor==="employee"&&m.body==="I cannot work seven to two. I can arrive at 8 AM.");
  },{timeout:30_000}).toBe(true);
  await expect(staff.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toBeVisible({timeout:20_000});

  const inbox=await staffCtx.request.get("/api/staff-channel");
  expect(inbox.status()).toBe(200);
  const own=await inbox.json();
  expect(own.requests.some(r=>r.id)).toBe(true);
  expect(own.self.timecards.some(t=>t.id===ownCardId&&t.hours===7)).toBe(true);
  expect(own.self.timecards.some(t=>t.id===otherCardId)).toBe(false);
  expect(own.self.breakNotices.map(a=>a.timecardId)).toContain(ownCardId);
  expect(JSON.stringify(own.self)).not.toContain(otherCardId);
  // Two independent cafés can both employ someone named Aisha. A shared
  // display name is not cross-tenant evidence; opaque source IDs are.
  expect(own.name).toBe(created[0].worker.display_name);
  for(const foreignId of [created[1].worker.id,created[1].shiftId,
   created[1].timecardId,created[1].userId])
   expect(JSON.stringify(own)).not.toContain(foreignId);
  expect((await staffCtx.request.get("/api/staff-channel/link")).status()).toBe(403);
  const businessesBefore=(await db.query("select count(*)::integer as n from public.businesses")).rows[0].n;
  const onboarding=await staffCtx.request.get("/en/onboarding",{maxRedirects:0});
  expect([302,303,307,308]).toContain(onboarding.status());
  expect(onboarding.headers().location??"").toContain("/crew");
  const businessesAfter=(await db.query("select count(*)::integer as n from public.businesses")).rows[0].n;
  expect(businessesAfter).toBe(businessesBefore);
  const privatePage=await staffCtx.request.get("/en/money?view=profit",{maxRedirects:0});
  expect([302,303,307,308,401,403]).toContain(privatePage.status());
  for(const path of ["/en/more","/en/pricing"]){
   const response=await staffCtx.request.get(path,{maxRedirects:0});
   expect([302,303,307,308]).toContain(response.status());
   expect(response.headers().location??"").toContain("/crew");
  }

  await owner.reload();
  await expect(owner.getByRole("heading",{name:"Employee responses and reports"}))
   .toBeVisible({timeout:30_000});
  await expect(owner.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toBeVisible();
  const conversation=owner.getByRole("region",{name:"Employee Supervisor communication history"});
  const answeredShift=conversation.locator("li").filter({hasText:"I cannot work seven to two. I can arrive at 8 AM."});
  await expect(answeredShift.getByText("Confirm your shift")).toBeVisible();
  await expect(conversation.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toBeVisible();
  expect((await staffCtx.request.get("/api/staff-channel/owner-history")).status()).toBe(403);
  const ownerHistory=await ownerCtx.request.get("/api/staff-channel/owner-history");
  expect(ownerHistory.status()).toBe(200);
  const ownerHistoryData=await ownerHistory.json();
  expect(ownerHistoryData.events.some(e=>e.kind==="request"&&e.text.includes("07:00"))).toBe(true);
  expect(ownerHistoryData.events.some(e=>e.actor==="employee"&&e.text==="I cannot work seven to two. I can arrive at 8 AM.")).toBe(true);
  await owner.locator("#staff-reply-person").selectOption(created[0].worker.id);
  await owner.locator("#staff-reply-body").fill("Thanks for the update. Can you confirm 8 AM?");
  await owner.getByRole("button",{name:"Send to employee"}).click();
  await expect(owner.getByText("Message saved to this employee's work inbox. Not a read or delivery receipt."))
   .toBeVisible();
  // Owner's existing reply outbox refreshes the server component. Its
  // client transcript must adopt new props without a manual owner reload.
  await expect(owner.getByRole("region",{name:"Employee Supervisor communication history"})
   .getByText("Thanks for the update. Can you confirm 8 AM?")).toBeVisible({timeout:20_000});
  await staff.reload();
  await expect(staff.getByText("Message from café owner")).toBeVisible();
  await expect(staff.getByText("Thanks for the update. Can you confirm 8 AM?")).toBeVisible();
  // Genuine database keyset pagination: more than the initial 25 events.
  // Older owner-authored work messages must remain available without creating
  // duplicate employee-response notices or leaking to another café.
  await db.query("insert into public.staff_communication_messages (business_id,employee_id,actor,author_user_id,response_code,body,channel,client_nonce,received_at) select $1,$2,'owner',$3,'owner_message','Historical note '||n,'web',gen_random_uuid(),now()-interval '10 days'+n*interval '1 minute' from generate_series(1,35) n",
   [created[0].cafe.businessId,created[0].worker.id,created[0].cafe.owner.userId]);
  await owner.reload();
  await expect(owner.getByText("Historical note 35")).toBeVisible({timeout:20_000});
  await expect(owner.getByRole("button",{name:"Load older exchanges"})).toBeVisible();
  await owner.getByRole("button",{name:"Load older exchanges"}).click();
  await expect(owner.getByText("Historical note 1")).toBeVisible({timeout:20_000});
  await otherOwner.reload();
  await expect(otherOwner.getByText("Historical note 1")).toHaveCount(0);
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
  // A structured completion with NO optional text must remain visible.
  await owner.locator("#staff-work-title").fill("Count takeaway cups");
  await owner.locator("#staff-work-prompt").fill("Report the count if known");
  await owner.getByRole("button",{name:"Assign work"}).click();
  await staff.reload();
  const blankReply=staff.getByRole("article").filter({hasText:"Count takeaway cups"});
  await expect(blankReply).toBeVisible({timeout:20_000});
  await blankReply.getByRole("button",{name:"Mark complete"}).click();
  await owner.reload();
  await expect(owner.getByRole("region",{name:"Employee Supervisor communication history"})
   .getByText("Employee reported task complete — not independently verified")).toBeVisible({timeout:20_000});
  await otherOwner.reload();
  await expect(otherOwner.getByText("I cannot work seven to two. I can arrive at 8 AM.")).toHaveCount(0);
  const shift=(await db.query("select start_local,status from public.scheduled_shifts where id=$1",
   [created[0].shiftId])).rows[0];
  expect(shift.status).toBe("sent");
  expect(String(shift.start_local).startsWith("07:00")).toBe(true);
  // A former employee with a still-linked auth account must be denied all
  // owner onboarding and owner data, not only active workers.
  await db.query("update public.employees set active=false where id=$1",
   [created[0].worker.id]);
  const inactiveOnboarding=await staffCtx.request.get("/en/onboarding",{maxRedirects:0});
  expect([302,303,307,308]).toContain(inactiveOnboarding.status());
  expect(inactiveOnboarding.headers().location??"").toContain("/crew");
  const inactiveInbox=await staffCtx.request.get("/api/staff-channel");
  expect(inactiveInbox.status()).toBe(403);
  // Inactivity must not trap owner-linked credentials. The real owner can
  // disconnect an inactive worker without reactivating their job.
  await owner.reload();
  await owner.locator("#staff-account-person").selectOption(created[0].worker.id);
  await owner.getByRole("button",{name:"Disconnect login"}).click();
  await expect(owner.getByText("Staff login disconnected.")).toBeVisible({timeout:20_000});
  const afterUnlink=(await db.query("select staff_auth_user_id from public.employees where id=$1",
   [created[0].worker.id])).rows[0];
  expect(afterUnlink.staff_auth_user_id).toBeNull();
  await db.query("update public.employees set active=true where id=$1",
   [created[0].worker.id]);
 }finally{
  for(const ctx of contexts)await ctx.close().catch(()=>{});
  if(connected)for(const item of created){
   // Cleanup restores the existing seeded worker even after a failed assertion.
   await db.query("update public.employees set active=true where id=$1",[item.worker.id]).catch(()=>{});
   await db.query("delete from public.operating_tasks where business_id=$1 and entity_type='staff_message' and entity_id in (select id::text from public.staff_communication_messages where business_id=$1 and employee_id=$2)",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.staff_communication_messages where business_id=$1 and employee_id=$2",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.staff_communication_requests where business_id=$1 and employee_id=$2",
    [item.cafe.businessId,item.worker.id]).catch(()=>{});
   await db.query("delete from public.scheduled_shifts where id=$1",[item.shiftId]).catch(()=>{});
   if(item.timecardId)await db.query("delete from public.timecards where id=$1",[item.timecardId]).catch(()=>{});
   await db.query("delete from auth.users where id=$1",[item.userId]).catch(()=>{});
  }
  await db.end().catch(()=>{});
 }
});
