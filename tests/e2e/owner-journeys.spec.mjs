import {test, expect} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment, seededCafe, login, openOwnedPage}
  from "./seeded-auth.mjs";

test.beforeEach(() => {
  assertDisposableEnvironment();
});

test("@home Task16A authenticated mobile owner views library/routines/permissions and revokes a scoped mandate",async({browser})=>{
  test.setTimeout(120_000);
  const owner=seededCafe(0),foreign=seededCafe(1);
  const id={thread:randomUUID(),routine:randomUUID(),active:randomUUID(),old:randomUUID()};
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const other=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  let connected=false;
  try{
    await db.connect();connected=true;console.info("[Task16A E2E] connected disposable database");
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [id.thread,owner.businessId,owner.owner.userId,randomUUID(),"Task16A approval library"]);
    // A disposable saved mandate fixture proves the real owner/API/RLS/UI path,
    // NOT phone OTP delivery, which needs its own provider-backed acceptance.
    await db.query("insert into public.supervisor_mandates("+
      "id,revision,business_id,owner_user_id,capability_id,capability_version,"+
      "policy_hash,limit_kind,limit_value,period_kind,expires_at,verified_at) "+
      "values($1,1,$2,$3,'leo.goal.v1',1,$4,'count',5,'cafe_day',now()+interval '1 day',now())",
      [id.active,owner.businessId,owner.owner.userId,"a".repeat(64)]);
    await db.query("insert into public.supervisor_mandates("+
      "id,revision,business_id,owner_user_id,capability_id,capability_version,"+
      "policy_hash,limit_kind,limit_value,period_kind,created_at,expires_at,verified_at) "+
      "values($1,1,$2,$3,'leo.goal.v1',1,$4,'count',5,'cafe_day',"+
      "now()-interval '3 days',now()-interval '1 day',now()-interval '3 days')",
      [id.old,owner.businessId,owner.owner.userId,"b".repeat(64)]);
    await db.query("insert into public.supervisor_routines("+
      "id,business_id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status)"+
      " values($1,$2,$3,$4,'Daily source check','daily','{}'::integer[],'08:00',"+
      "(select timezone from public.businesses where id=$2),'active')",
      [id.routine,owner.businessId,owner.owner.userId,id.thread]);

    console.info("[Task16A E2E] saved synthetic owner-scoped records");
    const page=await ctx.newPage();
    await login(page,owner);console.info("[Task16A E2E] first owner signed in");
    await openOwnedPage(page,owner,"?thread="+id.thread);console.info("[Task16A E2E] opened real Supervisor chat");
    await page.setViewportSize({width:390,height:844});
    const controlsButton=page.getByRole("button",{name:"Library, routines and permissions"});
    await expect(controlsButton).toBeVisible({timeout:20_000});
    await expect(controlsButton).toBeEnabled({timeout:10_000});
    await controlsButton.click();
    console.info("[Task16A E2E] opened owner controls drawer");
    const panel=page.getByRole("dialog",{name:"Supervisor controls"});
    await expect(panel).toBeVisible();
    await panel.getByRole("button",{name:"Library",exact:true}).click();
    await expect(panel.getByRole("button",{name:"Task16A approval library"})).toBeVisible();console.info("[Task16A E2E] library from authenticated records");
    const routinesTab=panel.getByRole("button",{name:"Routines",exact:true});
    await routinesTab.click();
    await expect(panel.getByText("Daily source check")).toBeVisible();
    // Codex P2 regression: same-tab click must not trigger a loader with no fetch.
    await routinesTab.click();
    await expect(panel.getByText("Daily source check")).toBeVisible();
    await expect(panel.getByText("Checking saved permissions and routines")).toHaveCount(0);
    console.info("[Task16A E2E] canonical routine remains after active-tab reselect");
    await page.getByRole("dialog",{name:"Supervisor controls"}).getByRole("button",{name:"Open routine conversation",exact:true}).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator("#supervisor-home-composer")).toBeVisible();
    await controlsButton.click();
    await panel.getByRole("button",{name:"Permissions",exact:true}).click();
    await expect(panel.getByText("Goal tracking",{exact:true}).first()).toBeVisible();
    await expect(panel.getByText("Active",{exact:true})).toBeVisible();
    await expect(panel.getByText("Expired",{exact:true})).toBeVisible();console.info("[Task16A E2E] active and expired permissions visible");
    await expect(panel.getByText("5 goal starts per café-local day").first()).toBeVisible();
    const permissionsTab=panel.getByRole("button",{name:"Permissions",exact:true});
    await permissionsTab.click();
    await expect(panel.getByText("Goal tracking",{exact:true}).first()).toBeVisible();
    await expect(panel.getByText("5 goal starts per café-local day").first()).toBeVisible();
    await expect(panel.getByText("Checking saved permissions and routines")).toHaveCount(0);
    console.info("[Task16A E2E] canonical permission remains after active-tab reselect");
    // No verified phone MFA factor is installed in the seeded project:
    // a simulated grant cannot be shown as enabled.
    await expect(panel.getByRole("button",{name:"Request verification code"})).toHaveCount(0);
    console.info("[Task16A E2E] invoking genuine owner revoke");
    await panel.getByRole("button",{name:"Revoke permission"}).click();
    await expect(panel.getByText("Permission revoked in the database")).toBeVisible();
    const receipt=await db.query("select revision,revoked_at from public.supervisor_mandates "+
      "where id=$1 order by revision desc limit 1",[id.active]);
    expect(Number(receipt.rows[0].revision)).toBe(2);
    expect(receipt.rows[0].revoked_at).not.toBeNull();console.info("[Task16A E2E] revision 2 database revocation receipt verified");
    // Stale revision cannot revoke twice or silently renew the mandate.
    const replay=await ctx.request.post("/api/ai/threads/"+id.thread+"/mandates",{
      headers:{"origin":"http://127.0.0.1:3000"},
      data:{action:"revoke",mandateId:id.active,revision:1},
    });
    expect(replay.status()).not.toBe(200);console.info("[Task16A E2E] stale owner revision rejected");
    const viewport=await page.evaluate(()=>document.documentElement.scrollWidth);
    expect(viewport).toBeLessThanOrEqual(391);
    // A lost read is an explicit failure, never a fabricated empty grant list.
    await panel.getByRole("button",{name:"Library",exact:true}).click();
    await page.route("**/api/ai/threads/*/mandates",route=>{
      if(route.request().method()==="GET")
        return route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'});
      return route.continue();
    });
    await panel.getByRole("button",{name:"Permissions",exact:true}).click();
    await expect(panel.getByRole("alert")).toContainText("Permissions could not be verified");console.info("[Task16A E2E] unavailable permission read cannot claim no grants");
    await page.unroute("**/api/ai/threads/*/mandates");
    console.info("[Task16A E2E] local failure-state complete before switching accounts");
    const foreignPage=await other.newPage();
    await login(foreignPage,foreign);console.info("[Task16A E2E] other café owner signed in");
    const denied=await other.request.get("/api/ai/threads/"+id.thread+"/mandates");
    expect([401,403,404]).toContain(denied.status());
    await openOwnedPage(foreignPage,foreign,"");
    await foreignPage.setViewportSize({width:390,height:844});
    await foreignPage.getByRole("button",{name:"Library, routines and permissions"}).click();
    const foreignPanel=foreignPage.getByRole("dialog",{name:"Supervisor controls"});
    await foreignPanel.getByRole("button",{name:"Routines",exact:true}).click();
    await expect(foreignPanel.getByText("Daily source check")).toHaveCount(0);
    await foreignPanel.getByRole("button",{name:"Permissions",exact:true}).click();
    await expect(foreignPanel.getByText("Task16A approval library")).toHaveCount(0);console.info("[Task16A E2E] other-café isolation proved");

  }finally{
    await Promise.allSettled([ctx.close(),other.close()]);
    if(connected){
      await db.query("delete from public.supervisor_mandates where id=any($1::uuid[])",
        [[id.active,id.old]]).catch(()=>{});
      await db.query("delete from public.supervisor_routines where id=$1",[id.routine]).catch(()=>{});
      await db.query("delete from public.ai_threads where id=$1 and business_id=$2",
        [id.thread,owner.businessId]).catch(()=>{});
      await db.end();
    }
  }
});

test("@home Task 16B persists real Supervisor work through reload, uncertainty and café isolation", async ({browser}) => {
  test.setTimeout(120_000);
  const own = seededCafe(0), other = seededCafe(1);
  const threadId = randomUUID(), runId = randomUUID(), requestId = randomUUID();
  const messageId = randomUUID(), answerId = randomUUID();
  const investigationSourceId = randomUUID();
  const db = new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  let connected = false;
  try {
    await db.connect();
    connected = true;
    // A real local Postgres run/step pair, not a mocked API payload.
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [threadId, own.businessId, own.owner.userId, requestId, "Task 16B persisted work"]);
    await db.query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'pending')",
      [runId, own.businessId, own.owner.userId, threadId, messageId, "a".repeat(64)]);
    await db.query("insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode,status) values($1,$2,'owner_turn',1,'reconcile','pending')",
      [own.businessId, runId]);
    // The existing shared login helper asserts a desktop-visible nav label.
    // Authenticate normally, then switch to the real mobile viewport for ALL
    // status, reconnect, and horizontal-overflow assertions below.
    // The newly merged 15A worker persists unprompted investigation episodes here.
    await db.query("insert into public.supervisor_investigations(business_id,owner_user_id,thread_id,source_type,source_id,revision_hash,stable_key,phase) values($1,$2,$3,'alert',$4,$5,$6,'collect')",
      [own.businessId,own.owner.userId,threadId,investigationSourceId,"b".repeat(64),"c".repeat(64)]);
    const context = await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
    try {
      const page = await context.newPage();
      await login(page,own);
      await openOwnedPage(page,own,"?thread="+threadId);
      await page.setViewportSize({width:390,height:844});
      const work = page.getByRole("region",{name:"Supervisor work"});
      await expect(work).toBeVisible();
      await expect(work.locator('[data-work-kind="durable_run"][data-work-status="queued"]')).toBeVisible();
      await expect(work.locator('[data-work-kind="investigation"][data-work-status="queued"]')).toBeVisible();
      const ownRead = await context.request.get("/api/ai/threads/"+threadId+"/work");
      expect(ownRead.status()).toBe(200);
      expect((await ownRead.json()).work.some(item=>item.id==="run:"+runId)).toBe(true);

      // More than five unresolved 15A episodes remain accessible, not silently
      // hidden behind a recency limit or duplicate approval control.
      for (let i=0;i<6;i++) {
        const episode=randomUUID(), hash=episode.replaceAll("-","").repeat(2);
        await db.query("insert into public.supervisor_investigations(business_id,owner_user_id,thread_id,source_type,source_id,revision_hash,stable_key,phase) values($1,$2,$3,'alert',$4,$5,$6,'collect')",
          [own.businessId,own.owner.userId,threadId,episode,hash,hash]);
      }
      await page.reload();
      const showMore = work.getByRole("button",{name:"Show more saved work"});
      await expect(showMore).toBeVisible();
      await showMore.click();
      await expect(work.locator('[data-work-kind="investigation"]')).toHaveCount(7);

      // Durable worker retry is visible from the canonical lease attempt.
      await db.query("update public.supervisor_run_steps set status='leased',worker_id=$1,claim_token=$2,lease_until=now()+interval '10 minutes',attempts=2,updated_at=now() where run_id=$3",
        [randomUUID(),randomUUID(),runId]);
      await db.query("update public.supervisor_runs set status='running',updated_at=now() where id=$1",[runId]);
      await page.reload();
      await expect(work.locator('[data-work-status="retrying"]')).toBeVisible();

      // A dead reconciliation lease stays UNKNOWN rather than re-executing an effect.
      await db.query("update public.supervisor_run_steps set status='blocked',worker_id=null,claim_token=null,lease_until=null,error_code='lease_expired',updated_at=now() where run_id=$1",
        [runId]);
      await db.query("update public.supervisor_runs set status='blocked',updated_at=now() where id=$1",[runId]);
      await page.reload();
      await expect(work.locator('[data-work-status="uncertain"]')).toContainText("Outcome not yet verified");
      await expect(work.getByText("Effect verified",{exact:true})).toHaveCount(0);

      // The other café's authenticated owner cannot enumerate this work.
      const foreign = await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
      try {
        const foreignPage = await foreign.newPage();
        await login(foreignPage,other);
        const response = await foreign.request.get("/api/ai/threads/"+threadId+"/work");
        expect([401,403,404]).toContain(response.status());
      } finally { await foreign.close(); }

      // Saving the answer does not magically create a provider receipt.
      await db.query("update public.supervisor_run_steps set status='completed',result_ref=$1,completed_at=now(),error_code=null,updated_at=now() where run_id=$2",
        [answerId,runId]);
      await db.query("update public.supervisor_runs set status='completed',final_report_ref=$1,finished_at=now(),updated_at=now() where id=$2",
        [answerId,runId]);
      await page.reload();
      await expect(work.locator('[data-work-status="answer_ready"]')).toContainText("Answer saved");
      await expect(work).toContainText("not an external effect");
      await expect(work.getByText("Effect verified",{exact:true})).toHaveCount(0);

      await db.query("update public.supervisor_investigations set phase='resolved',updated_at=now() where business_id=$1 and source_id=$2",
        [own.businessId, investigationSourceId]);
      await page.reload();
      await expect(work.locator('[data-work-kind="investigation"][data-work-status="source_resolved"]')).toBeVisible();
      await expect(work.getByText("Effect verified",{exact:true})).toHaveCount(0);

      // An offline read is a stale status, not an action failure or success.
      await page.route("**/api/ai/threads/"+threadId+"/work", route=>
        route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'}));
      await page.reload();
      await expect(work).toContainText("Current status cannot be verified");
      await page.unroute("**/api/ai/threads/"+threadId+"/work");
      await page.reload();
      await expect(work.locator('[data-work-status="answer_ready"]')).toBeVisible();
      const bounds = await work.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.x+ bounds.width).toBeLessThanOrEqual(391);

      // Exercise the actual v2 admission/question/cancellation RPCs in this
      // disposable database. This is Work/browser proof, not a real model
      // or scheduled producer test. No provider invocation or flag change.
      const ownerMessage=randomUUID(),questionId=randomUUID();
      await db.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$3,'owner','text','Prepare a report',$5)",
        [ownerMessage,own.businessId,own.owner.userId,threadId,randomUUID()]);
      await db.query("select set_config('request.jwt.claim.role','service_role',false)");
      const scope=[own.businessId,own.owner.userId,threadId];
      const rpc=async(name,args)=>(await db.query("select public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+") as value",args)).rows[0].value;
      const assignment=await rpc("supervisor_admit_owner_run_v2",[...scope,ownerMessage,"d".repeat(64),"en",[]]);
      const authorized=await rpc("supervisor_run_claim",[...scope,assignment.id,randomUUID(),30]);
      await rpc("supervisor_run_complete_step",[...scope,assignment.id,"authorize_owner",authorized.step.claim_token,"owner:"+ownerMessage]);
      const ownerClaim=await rpc("supervisor_run_claim",[...scope,assignment.id,randomUUID(),30]);
      const job=await rpc("supervisor_start_owner_job_v2",[...scope,assignment.id,ownerClaim.step.claim_token]);
      const blocks=[{type:"clarify",question:"Which saved period?",options:[{label:"Today only",value:"today"},{label:"Last week",value:"week"}],allowOther:true}];
      await rpc("supervisor_publish_owner_question_v2",[...scope,assignment.id,ownerClaim.step.claim_token,job.id,questionId,JSON.stringify(blocks),JSON.stringify({status:"requires_owner_input",ownerMessageId:ownerMessage,durableRunId:assignment.id,durableQuestionId:questionId})]);
      await db.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$3,'owner','text','An unrelated question',$5)",
        [randomUUID(),...scope,randomUUID()]);
      await page.reload();
      const persisted=work.locator('[data-work-id="run:'+assignment.id+'"]');
      await expect(persisted).toHaveAttribute("data-work-status","approval_required");
      await expect(persisted).toContainText("Waiting for your answer to the saved question");
      await expect(page.getByText("Which saved period?",{exact:true})).toBeVisible();
      await expect(work.locator('[data-work-id="job:'+job.id+'"]')).toHaveCount(0);
      await persisted.getByRole("button",{name:"Stop assignment",exact:true}).click();
      await expect(persisted.getByText("This assignment was cancelled.",{exact:true}).first()).toBeVisible();
      await page.reload();
      const savedWork=(await (await context.request.get("/api/ai/threads/"+threadId+"/work")).json()).work;
      expect(savedWork.find(item=>item.id==="run:"+assignment.id)).toMatchObject({status:"cancelled",questionId:null,cancelAllowed:false});
      expect((await db.query("select status,awaiting_question_id from public.supervisor_runs where id=$1",[assignment.id])).rows[0]).toEqual({status:"blocked",awaiting_question_id:null});
      await expect(page.getByRole("button",{name:"Today only",exact:true})).toHaveCount(0);
    } finally { await context.close(); }
  } finally {
    if (connected) {
      // Cascade cleans only this unique throwaway thread and its run/steps.
      await db.query("delete from public.ai_threads where id=$1 and business_id=$2",
        [threadId,own.businessId]).catch(()=>{});
      await db.end();
    }
  }
});

test("@home real password sign-in isolates two cafés and ignores an unauthorized café cookie", async ({browser}) => {
  test.setTimeout(90_000); // Two real café sign-ins and protected Money routes.
  const first = seededCafe(0), second = seededCafe(1);
  for (const [own, other] of [[first, second], [second, first]]) {
    const context = await browser.newContext({baseURL: "http://127.0.0.1:3000", serviceWorkers: "block"});
    try {
      const page = await context.newPage();
      await page.goto("/en/");
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      await login(page, own);
      await expect(page.getByText(other.name, {exact: true})).toHaveCount(0);

      // An attacker-controlled selector cookie cannot switch membership or
      // make another café's money appear in the authenticated Money screen.
      await context.addCookies([{
        name: "active_business_id", value: other.businessId,
        url: "http://127.0.0.1:3000",
      }]);
      await openOwnedPage(page, own, "money?view=profit");
      await expect(page.getByText(other.name, {exact: true})).toHaveCount(0);
      await expect(page.getByRole("group", {name: "Money view"}))
        .toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("@home Task15A persisted investigation opens in real Operations without leaking another café",async({browser})=>{
  test.setTimeout(110_000);
  const owner=seededCafe(0),foreign=seededCafe(1);
  const id={thread:randomUUID(),task:"investigation:"+randomUUID()};
  const title="Verified Supervisor inventory investigation "+id.task.slice(-8);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const first=await browser.newContext({baseURL:"http://127.0.0.1:3000",
    serviceWorkers:"block"});
  const other=await browser.newContext({baseURL:"http://127.0.0.1:3000",
    serviceWorkers:"block"});
  let connected=false;
  try{
    await db.connect();connected=true;
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
      [id.thread,owner.businessId,owner.owner.userId,randomUUID()]);
    const payload={title,intent:"priority_investigation",
      threadId:id.thread,sourceType:"operating_task",sourceId:"stock-review",
      episodeId:randomUUID(),stepVersion:2,externalEffects:"not_attempted"};
    await db.query("insert into public.operating_tasks("+
      "business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,"+
      "evidence,entity_type,dedupe_key) values($1,$2,$3,'leo','priority_notice',"+
      "'needs_owner',$4::jsonb,'high','[]'::jsonb,'priority_source',$5)",
      [owner.businessId,id.task,owner.owner.userId,JSON.stringify(payload),id.task]);

    const page=await first.newPage();
    await login(page,owner);
    await openOwnedPage(page,owner,"operations");
    const card=page.locator('article[data-task-kind="priority_notice"]')
      .filter({hasText:title});
    await expect(card).toBeVisible({timeout:30_000});
    await expect(card.getByRole("link",{name:/open in chat/i})).toHaveAttribute(
      "href",new RegExp("thread="+id.thread));
    await card.getByRole("link",{name:/open in chat/i}).click();
    await expect(page).toHaveURL(new RegExp("thread="+id.thread));
    const foreignPage=await other.newPage();
    await login(foreignPage,foreign);
    await openOwnedPage(foreignPage,foreign,"operations");
    await expect(foreignPage.getByText(title,{exact:true})).toHaveCount(0);
  }finally{
    await other.close();
    await first.close();
    if(connected){
      await db.query("delete from public.operating_tasks where business_id=$1 and id=$2",
        [owner.businessId,id.task]).catch(()=>{});
      await db.query("delete from public.ai_threads where business_id=$1 and id=$2",
        [owner.businessId,id.thread]).catch(()=>{});
      await db.end();
    }
  }
});

test("@home Task15B owner reports a real maintenance incident and independently verifies working equipment",async({browser})=>{
  test.setTimeout(120_000);
  const own=seededCafe(0),other=seededCafe(1),label="Disposable espresso "+randomUUID().slice(0,8);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ownContext=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const otherContext=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  let taskId=null,connected=false;
  try{
    await db.connect();connected=true;
    const page=await ownContext.newPage();
    await login(page,own);
    await openOwnedPage(page,own,"operations");
    await page.setViewportSize({width:390,height:844});
    const form=page.getByRole("region",{name:"Report equipment problem"});
    await expect(form).toBeVisible();
    await form.getByLabel("Equipment name or label").fill(label);
    await form.getByLabel("What happened?").fill("Machine stopped extracting espresso during service");
    await form.getByLabel("Urgency").selectOption("high");
    await form.getByRole("button",{name:"Report problem"}).click();
    const getCase=()=>db.query("select id,status,payload,resolved_at from public.operating_tasks "+
      "where business_id=$1 and kind='maintenance_issue' and payload->>'equipmentLabel'=$2",
      [own.businessId,label]).then(r=>r.rows[0]??null);
    await expect.poll(async()=>(await getCase())?.payload?.maintenanceStage,{timeout:25_000}).toBe("reported");
    const reported=await getCase();
    taskId=reported.id;
    expect(reported.status).toBe("needs_owner");
    expect(reported.payload).toMatchObject({externalSent:false,repairVerified:false,
      severity:"high",maintenanceStage:"reported"});
    expect(reported.resolved_at).toBeNull();
    const initialEvents=await db.query("select kind from public.maintenance_case_events "+
      "where business_id=$1 and task_id=$2",[own.businessId,taskId]);
    expect(initialEvents.rows.map(x=>x.kind)).toEqual(["report"]);
    await page.reload();
    const card=page.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label});
    await expect(card).toBeVisible({timeout:30_000});
    await expect(card).toContainText("Reported");
    // A repair CLAIM is saved as evidence but does not close a physical case.
    const controls=card.getByRole("region",{name:"Equipment maintenance"});
    await controls.getByLabel("Details or evidence").fill("Technician told owner the repair is done");
    await controls.getByRole("button",{name:"Record a claimed repair"}).click();
    await expect.poll(async()=>(await getCase())?.payload?.maintenanceStage,{timeout:25_000})
      .toBe("repair_claimed");
    const claimed=await getCase();
    expect(claimed.status).toBe("needs_owner");
    expect(claimed.resolved_at).toBeNull();
    expect(claimed.payload).toMatchObject({repairVerified:false,externalSent:false});
    await page.reload();
    await expect(card).toContainText("Repair claimed");
    await card.getByRole("button",{name:"I inspected the equipment and confirmed it works"}).click();
    await expect.poll(async()=>(await getCase())?.status,{timeout:25_000}).toBe("handled");
    const checked=await getCase();
    expect(checked.resolved_at).not.toBeNull();
    expect(checked.payload).toMatchObject({maintenanceStage:"verified_repaired",
      repairVerified:true,externalSent:false});
    const history=await db.query("select kind,source_kind from public.maintenance_case_events "+
      "where business_id=$1 and task_id=$2",[own.businessId,taskId]);
    expect(new Set(history.rows.map(x=>x.kind)))
      .toEqual(new Set(["report","repair_claim","operational_verification"]));
    expect(history.rows.some(x=>x.source_kind==="owner_operational_check")).toBe(true);
    // The handled case is a real saved Operations row. The global café-name
    // breadcrumb is intentionally hidden at mobile width; it is not proof
    // of authentication or of this case being absent.
    await page.goto("/en/operations?agent=leo&status=handled&task="+encodeURIComponent(taskId));
    await expect(page).not.toHaveURL(/login|onboarding/);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label}))
      .toContainText("Repair independently verified");
    await expect(page.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label})
      .getByRole("link",{name:"Open maintenance case"}))
      .toHaveAttribute("href",/status=handled/);
    const outside=await otherContext.newPage();
    await login(outside,other);
    await outside.goto("/en/operations");
    await expect(outside).not.toHaveURL(/login|onboarding/);
    await expect(outside.getByRole("main")).toBeVisible();
    await expect(outside.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label}))
      .toHaveCount(0);
    await outside.goto("/en/operations?agent=leo&status=handled");
    await expect(outside).not.toHaveURL(/login|onboarding/);
    await expect(outside.getByRole("main")).toBeVisible();
    await expect(outside.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label}))
      .toHaveCount(0);
    // A sent message must never be fabricated by the UI or the SQL workflow.
    const latest=await getCase();
    expect(latest.payload.externalSent).toBe(false);
    // A router refresh can replace the execution context after the save.
    // Retry the exact authenticated handled-case and viewport assertions
    // together; neither a redirect nor a real overflow may pass.
    await expect(async()=>{
      await expect(page).toHaveURL(/\/operations\?.*status=handled/);
      await expect(page.locator('article[data-task-kind="maintenance_issue"]').filter({hasText:label}))
        .toContainText("Repair independently verified");
      const bounds=await page.evaluate(()=>({
        page:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth
      }));
      expect(bounds.page).toBeLessThanOrEqual(bounds.viewport+1);
    }).toPass({timeout:25_000});
  }finally{
    await ownContext.close();await otherContext.close();
    if(connected&&taskId)await db.query(
      "delete from public.operating_tasks where business_id=$1 and id=$2",
      [own.businessId,taskId]).catch(()=>{});
    await db.end().catch(()=>{});
  }
});

test("@home owner uploads and reselects a private receipt while another café cannot read it", async ({browser}) => {
  test.setTimeout(90_000); // Two signed-in sessions, one real Storage upload and a reload.
  const owner = seededCafe(0), other = seededCafe(1);
  const context = await browser.newContext({baseURL: "http://127.0.0.1:3000", serviceWorkers: "block"});
  const otherContext = await browser.newContext({baseURL: "http://127.0.0.1:3000", serviceWorkers: "block"});
  try {
    const page = await context.newPage();
    await login(page, owner);
    await openOwnedPage(page, owner, "");
    const attach = page.getByRole("button", {name: "Add an attachment"});
    await expect(attach).toBeEnabled({timeout: 30_000});
    // Observe only status/path metadata. Failing a real upload must explain
    // whether the lazy thread creation or the private file endpoint failed.
    const uploads=[];
    page.on("response", response=>{
      const pathname=new URL(response.url()).pathname;
      if(pathname.startsWith("/api/ai/threads")) {
        const item={method:response.request().method(),path:pathname,status:response.status(),
          origin:null,fetchSite:null,requestOrigin:new URL(response.url()).origin,
          contentType:response.headers()["content-type"]??null,error:null};
        uploads.push(item);
        void response.request().allHeaders().then(headers=>{
          item.origin=headers.origin??null;
          item.fetchSite=headers["sec-fetch-site"]??null;
        }).catch(()=>undefined);
        if(response.status()>=400)
          void response.text().then(value=>{
            if(item.contentType?.includes("application/json")){
              try{const parsed=JSON.parse(value);
                if(typeof parsed.error==="string")item.error=parsed.error.slice(0,100);}
              catch{item.error="unreadable_json";}
            }else item.error="non_json_response";
          }).catch(()=>undefined);
      }
    });
    page.on("requestfailed", request=>{
      const pathname=new URL(request.url()).pathname;
      if(pathname.startsWith("/api/ai/threads"))
        uploads.push({method:request.method(),path:pathname,error:request.failure()?.errorText?.slice(0,100)});
    });
    // A new chat creates its thread before uploading. Verify this first so
    // 403 origin/auth failures cannot masquerade as 20-second upload timeouts.
    const createdThread=page.waitForResponse(response=>
      new URL(response.url()).pathname==="/api/ai/threads" &&
      response.request().method()==="POST",{timeout:20_000});
    const uploaded = page.waitForResponse(response =>
      /^\/api\/ai\/threads\/[^/]+\/attachments$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",{timeout:20_000}).catch(()=>{
      throw new Error("Private upload POST not reached. Conversation API requests: "+
        JSON.stringify(uploads.slice(-20)));
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XouYAAAAASUVORK5CYII=",
      "base64");
    await page.locator('input[type="file"]').setInputFiles({
      name:"receipt.png",mimeType:"image/png",buffer:png,
    });
    const created=await createdThread;
    if(created.status()!==201){
      let code="non_json_rejection";
      try{const body=await created.json();if(typeof body?.error==="string")code=body.error.slice(0,100);}
      catch{code="non_json_rejection";}
      throw new Error("Thread create rejected, status="+created.status()+", code="+code+
        ", requestOrigin="+new URL(created.url()).origin+
        ", browserOrigin="+(created.request().headers().origin??"absent"));
    }
    const response = await uploaded;
    expect(response.status()).toBe(201);
    const {attachment} = await response.json();
    expect(attachment).toMatchObject({
      originalName:"receipt.png",mediaType:"image/png",
      bytes:png.length,processingState:"stored_unanalysed",
    });
    const match = new URL(response.url()).pathname.match(/^\/api\/ai\/threads\/([^/]+)\/attachments$/);
    expect(match).not.toBeNull();
    const threadId = match[1];
    const route = "/api/ai/threads/" + threadId + "/attachments";
    const listing = await context.request.get(route);
    expect(listing.ok()).toBe(true);
    expect((await listing.json()).items.some(row => row.id === attachment.id)).toBe(true);
    // An owner can download the privately stored original, but another café
    // owner's independently authenticated session cannot see it.
    const ownDownload = await context.request.get(route + "/" + attachment.id,{maxRedirects:0});
    expect([302,303,307,308]).toContain(ownDownload.status());
    await expect(page.getByRole("button",{name:"Remove receipt.png"})).toBeVisible();
    await page.getByRole("button",{name:"Remove receipt.png"}).click();
    await expect(page.getByRole("button",{name:"Remove receipt.png"})).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button",{name:"Remove receipt.png"})).toHaveCount(0);
    await page.getByText("Previous files",{exact:true}).click();
    await page.getByRole("button",{name:"Use receipt.png"}).click();
    await expect(page.getByRole("button",{name:"Remove receipt.png"})).toBeVisible();
    const input=page.locator("#supervisor-home-composer");await input.fill("Saved unsent receipt draft");
    await page.getByRole("button",{name:"New chat",exact:true}).click();
    await expect(input).toHaveValue("");await expect(page.getByRole("button",{name:"Remove receipt.png"})).toHaveCount(0);
    await page.getByRole("button",{name:"Library, routines and permissions"}).click();
    const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
    await drawer.locator('[data-library-thread="'+threadId+'"]').click();
    await expect(input).toHaveValue("Saved unsent receipt draft");
    await expect(page.getByRole("button",{name:"Remove receipt.png"})).toBeVisible();
    await page.getByRole("button",{name:"Library, routines and permissions"}).click();
    await expect(drawer.getByRole("link",{name:"receipt.png",exact:true})).toHaveAttribute("href",route+"/"+attachment.id);
    await page.keyboard.press("Escape");

    const otherPage=await otherContext.newPage();
    await login(otherPage, other);
    const denied=await otherContext.request.get(route + "/" + attachment.id,{maxRedirects:0});
    expect([401,403,404]).toContain(denied.status());
    // The same cross-café boundary must prevent enumeration, not only
    // direct file download. A foreign owner must not see attachment IDs.
    const foreignListing=await otherContext.request.get(route);
    expect([401,403,404]).toContain(foreignListing.status());
    // The foreign owner cannot write into the first owner's thread either.
    // Attempt a real multipart request, keeping all data disposable/local.
    const foreignUpload=await otherContext.request.post(route,{multipart:{
      file:{name:"foreign-receipt.png",mimeType:"image/png",buffer:png}
    }});
    expect([401,403,404]).toContain(foreignUpload.status());
    const unchanged=await context.request.get(route);
    expect(unchanged.ok()).toBe(true);
    expect((await unchanged.json()).items.filter(row=>row.id===attachment.id)).toHaveLength(1);
  } finally {
    await otherContext.close();
    await context.close();
  }
});

test("@staff seeded owner can open actual schedule and Team view", async ({page}) => {
  const own = seededCafe(0);
  await login(page, own);
  await openOwnedPage(page, own, "staff");
  await expect(page.getByRole("button", {name: "Team", exact: true}))
    .toBeVisible();
  await page.getByRole("button", {name: "Team", exact: true}).click();
  await expect(page.getByRole("heading", {name: /team/i}).first()).toBeVisible();
  // Seeded team is real persisted local Postgres data, not a fixture flag.
  await expect(page.getByText(own.employees[0].name, {exact: true}).first())
    .toBeVisible();
});

test("@staff owner sees durable published/accepted/delivered status, isolated by café",async({browser})=>{
 test.setTimeout(100_000);
 const own=seededCafe(0),other=seededCafe(1);
 const week="2026-12-07"; // only disposable seeded local database, no real sender
 const threadId=randomUUID(),proposalId=randomUUID(),publicationId=randomUUID(),deliveryId=randomUUID();
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
   user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const a=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 const b=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 let connected=false,employeeId=null;
 try{
  await db.connect();connected=true;
  const worker=await db.query("select id from public.employees where business_id=$1 order by id limit 1",
   [own.businessId]);expect(worker.rows).toHaveLength(1);employeeId=worker.rows[0].id;
  await db.query(`insert into public.ai_threads
    (id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)`,
    [threadId,own.businessId,own.owner.userId,randomUUID()]);
  await db.query(`insert into public.supervisor_proposals
    (id,business_id,owner_user_id,thread_id,request_key,capability_id,
     capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status)
    values ($1,$2,$3,$4,$5,'olivia.staff_propose_send_schedule.v2',2,
      $6::jsonb,$7,'{}','{}','en','committed')`,
    [proposalId,own.businessId,own.owner.userId,threadId,randomUUID(),
      JSON.stringify({operation:"propose_send_schedule",payload:{
        week_start:week,publish_and_notify:true}}),"b".repeat(64)]);
  const snapshot=[{employee_id:employeeId,date:week,start:"09:00",end:"15:00"}];
  await db.query(`insert into public.staff_schedule_publications
    (id,business_id,owner_user_id,proposal_id,week_start,snapshot)
    values($1,$2,$3,$4,$5,$6::jsonb)`,
    [publicationId,own.businessId,own.owner.userId,proposalId,week,JSON.stringify(snapshot)]);
  await db.query(`insert into public.staff_schedule_deliveries
    (id,business_id,proposal_id,publication_id,employee_id,recipient_e164,status,meta_message_id)
    values($1,$2,$3,$4,$5,'+14155550123','sent',$6)`,
    [deliveryId,own.businessId,proposalId,publicationId,employeeId,
      "wamid.disposable."+randomUUID()]);
  const page=await a.newPage();
  await login(page,own);
  await openOwnedPage(page,own,"staff?week="+week);
  const status=page.getByRole("region",{name:"Supervisor schedule publication status"});
  await expect(status).toBeVisible();
  await expect(status.getByText("1 provider-accepted, awaiting delivery")).toBeVisible();
  await expect(status.getByText("0 delivered")).toBeVisible();
  await db.query(`update public.staff_schedule_deliveries
    set status='delivered',delivered_at=now() where id=$1`,[deliveryId]);
  await page.reload();
  await expect(status.getByText("1 delivered")).toBeVisible();
  await expect(status.getByText("0 provider-accepted, awaiting delivery")).toBeVisible();
  const otherPage=await b.newPage();
  await login(otherPage,other);
  await openOwnedPage(otherPage,other,"staff?week="+week);
  await expect(otherPage.getByRole("region",{name:"Supervisor schedule publication status"}))
    .toHaveCount(0);
 }finally{
  await a.close();await b.close();
  if(connected){
   await db.query("delete from public.staff_schedule_deliveries where id=$1",[deliveryId]).catch(()=>{});
   await db.query("delete from public.staff_schedule_publications where id=$1",[publicationId]).catch(()=>{});
   await db.query("delete from public.supervisor_proposals where id=$1",[proposalId]).catch(()=>{});
   await db.query("delete from public.ai_threads where id=$1",[threadId]).catch(()=>{});
  }
  await db.end().catch(()=>{});
 }
});

test("@menu seeded owner searches real stored products", async ({page}) => {
  const own = seededCafe(0);
  await login(page, own);
  await openOwnedPage(page, own, "menu");
  const search = page.locator("input[placeholder]").first();
  await expect(search).toBeVisible();
  await search.fill(own.menu[0].name);
  await expect(page.getByRole("heading", {name: own.menu[0].name, exact: true}).first())
    .toBeVisible();
});

test("@money seeded owner switches from recovery to real profit & costs", async ({page}) => {
  const own = seededCafe(1);
  await login(page, own);
  await openOwnedPage(page, own, "money");
  const views = page.getByRole("group", {name: "Money view"});
  await expect(views).toBeVisible();
  const profit = views.locator('button[data-perf-value="profit"]');
  await profit.click();
  await expect(profit).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/view=profit/);
  await expect(page.getByText(own.name, {exact: true}).first()).toBeVisible();
});

test("@gmail seeded owner sees Gmail entry, connection status and revocation UX without external Google calls",async({page})=>{
  const own=seededCafe(0);
  let connected=false,disconnects=0;
  await page.route("**/api/connectors/gmail/status",async route=>{
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      status:connected?"active":"disconnected",configured:true,
      email:connected?"owner@example.com":null,
      permissions:{read:connected,draft:connected,send:connected,organize:connected}
    })});
  });
  await page.route("**/api/connectors/gmail/disconnect",async route=>{
    if(route.request().method()!=="POST")throw Error("Unexpected Gmail disconnect method");
    connected=false;disconnects++;
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({status:"disconnected"})});
  });
  await login(page,own);
  await openOwnedPage(page,own,"more");
  await page.getByRole("link",{name:"Connect Gmail"}).click();
  await expect(page).toHaveURL(/\/more\/gmail/);
  await expect(page.getByRole("button",{name:"Connect Gmail",exact:true})).toHaveAttribute("type","submit");
  await expect(page.locator('form[action="/api/connectors/gmail/connect"]')).toHaveAttribute("method","get");
  // A provider callback refreshes the owner-facing status; no real Google OAuth call.
  connected=true;
  await page.reload();
  await expect(page.getByText("Connected and ready")).toBeVisible();
  await expect(page.getByText("owner@example.com",{exact:true})).toBeVisible();
  // Use an exact accessible name: substring matching would incorrectly match
  // "Disconnect Gmail" when asserting that "Connect Gmail" is absent.
  await expect(page.getByRole("button",{name:"Connect Gmail",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Disconnect Gmail",exact:true})).toBeVisible();
  page.once("dialog",dialog=>void dialog.accept());
  await page.getByRole("button",{name:"Disconnect Gmail",exact:true}).click();
  await expect(page.getByText("Not connected",{exact:true})).toBeVisible();
  expect(disconnects).toBe(1);
  await expect(page.getByRole("button",{name:"Connect Gmail",exact:true})).toBeVisible();
});

test("@menu Pantry retains confirmed zero and rejects historical Toast stock as current for two cafés", async ({browser}) => {
  // Two independent authenticated café sessions plus the full stock receipt
  // lifecycle need more time than a single-page smoke test.
  test.setTimeout(120_000);
  // This E2 journey is deliberately local: the existing seed/login helpers
  // refuse preview and real production endpoints, and the DB is loopback-only.
  const own = seededCafe(0), other = seededCafe(1);
  const db = new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ingredientId=randomUUID(),locationId=randomUUID(),restaurantId=randomUUID(),stockGuid=randomUUID();
  const dateParts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
    timeZone:own.timezone,year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const businessDate=dateParts.year+"-"+dateParts.month+"-"+dateParts.day;
  const sourceTime=new Date(Date.now()-5*60_000).toISOString();
  const latestTime=new Date().toISOString();
  let connected=false;
  try {
    await db.connect();connected=true;
    // The generated owner ingredient and location are unique and not part of
    // any existing café data. Local tests cannot send provider requests.
    await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Task14a measured zero','ml')",
      [ingredientId,own.businessId]);
    await db.query(`insert into public.pantry_stock_counts
      (business_id,ingredient_id,count_date,quantity_base,entered_quantity,entered_unit)
      values($1,$2,$3,0,0,'ml')`,[own.businessId,ingredientId,businessDate]);
    await db.query("insert into public.locations(id,business_id,name) values($1,$2,'Task14a sandbox stock')",
      [locationId,own.businessId]);
    await db.query(`insert into public.toast_api_credentials
      (business_id,api_origin,client_id,client_secret_enc)
      values($1,'https://fixture.invalid','task14a-e2e-inert','fixture-not-a-provider-secret')
      on conflict (business_id) do nothing`,[own.businessId]);
    await db.query(`insert into public.toast_location_mappings
      (business_id,location_id,restaurant_guid,verified_at,toast_time_zone,closeout_hour,toast_start_date)
      values($1,$2,$3,now(),$4,4,$5)`,
      [own.businessId,locationId,restaurantId,own.timezone,businessDate]);
    const object={business_id:own.businessId,restaurant_guid:restaurantId,
      endpoint:"stock/v1/inventory",provider_key:stockGuid,source_key_kind:"provider_guid",
      source_business_date_kind:"observed_cafe_day",business_date:businessDate,
      guid:stockGuid,status:"QUANTITY",quantity:7,lastSuccessAt:sourceTime};
    await db.query(`select public.toast_stage_operational_batch(
      $1,$2,'stock/v1/inventory',$3,$4::jsonb)`,[
      own.businessId,restaurantId,businessDate,JSON.stringify([object])]);
    const updateReceipt=async(success,status,count)=>{
      await db.query(`insert into public.toast_optional_sync_state
        (business_id,restaurant_guid,operational_sources) values($1,$2,$3::jsonb)
        on conflict (business_id,restaurant_guid) do update
        set operational_sources=excluded.operational_sources`,[
        own.businessId,restaurantId,JSON.stringify({stock_inventory:{
          last_checked_at:success,last_success_at:success,status,count}})]);
    };
    await updateReceipt(sourceTime,"current",1);
    const first=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
    try {
      const page=await first.newPage();
      await login(page,own);
      await openOwnedPage(page,own,"menu/pantry");
      const evidence=page.locator("section[data-inventory-evidence]");
      await expect(evidence.getByRole("heading",{name:"Stock evidence",exact:true})).toBeVisible();
      await expect(evidence.getByText("Task14a measured zero",{exact:true})).toBeVisible();
      await expect(evidence.getByText("Quantity: 0 ml",{exact:true})).toBeVisible();
      await expect(evidence.getByText(stockGuid,{exact:true})).toBeVisible();
      await expect(evidence.getByText("Quantity: 7",{exact:true})).toBeVisible();
      await updateReceipt(latestTime,"empty",0);
      await page.reload();
      await expect(evidence.getByText(stockGuid,{exact:true})).toBeVisible();
      await expect(evidence.locator('[data-evidence-state="not_observed"]')).toContainText("Historical only");
      await expect(evidence.getByText("Quantity: Unknown (not zero)",{exact:true})).toBeVisible();
      await expect(evidence.getByText("Quantity: 0 ml",{exact:true})).toBeVisible();
    } finally {
      await first.close();
    }
    const second=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
    try{
      const page=await second.newPage();
      await login(page,other);
      await openOwnedPage(page,other,"menu/pantry");
      const evidence=page.locator("section[data-inventory-evidence]");
      await expect(evidence.getByRole("heading",{name:"Stock evidence",exact:true})).toBeVisible();
      await expect(evidence.getByText(stockGuid,{exact:true})).toHaveCount(0);
      await expect(evidence.getByText("Task14a measured zero",{exact:true})).toHaveCount(0);
    } finally {
      await second.close();
    }
  } finally {
    if(connected){
      // Cleanup is limited to IDs created by this disposable fixture.
      await db.query("delete from public.toast_raw_changes where business_id=$1 and restaurant_guid=$2",
        [own.businessId,restaurantId]).catch(()=>{});
      await db.query("delete from public.toast_raw_records where business_id=$1 and restaurant_guid=$2",
        [own.businessId,restaurantId]).catch(()=>{});
      await db.query("delete from public.toast_optional_sync_state where business_id=$1 and restaurant_guid=$2",
        [own.businessId,restaurantId]).catch(()=>{});
      await db.query("delete from public.toast_location_mappings where business_id=$1 and restaurant_guid=$2",
        [own.businessId,restaurantId]).catch(()=>{});
      await db.query("delete from public.locations where id=$1",[locationId]).catch(()=>{});
      await db.query("delete from public.ingredients where id=$1",[ingredientId]).catch(()=>{});
      await db.end();
    }
  }
});


test("@purchasing real supplier quote entry preserves currency and denies cross-café reads",async({browser})=>{
  test.setTimeout(90_000);
  const own=seededCafe(0),other=seededCafe(1);
  const first=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const second=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const supplier="Task14B Supplier "+randomUUID().slice(0,8);
  try{
    const page=await first.newPage();
    await login(page,own);
    await openOwnedPage(page,own,"operations/suppliers");
    const form=page.locator("form").first();
    await expect(form.getByLabel("Quote currency (ISO 4217)")).toBeVisible();
    await form.locator("input").nth(0).fill(supplier);
    await form.locator("input").nth(1).fill("Milk");
    await form.locator("input").nth(2).fill("7.25");
    await form.locator("input").nth(3).fill("1");
    await expect(form.getByLabel("Quote currency (ISO 4217)")).toHaveValue(own.currency);
    await form.getByLabel("Supplier availability").selectOption("confirmed");
    const date=await form.getByLabel("Availability checked on").getAttribute("max");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await form.getByLabel("Availability checked on").fill(date);
    const saved=page.waitForResponse(response=>
      new URL(response.url()).pathname==="/api/ai/suppliers/quotes"&&
      response.request().method()==="POST");
    await form.locator("button").last().click();
    const response=await saved;
    expect(response.status()).toBe(201);
    const record=(await response.json()).quote;
    expect(record).toMatchObject({supplierName:supplier,itemName:"Milk",priceCents:725,
      currencyCode:own.currency,availableStatus:"confirmed",availableCheckedAt:date});
    await page.reload();
    await expect(page.getByText(supplier,{exact:false}).first()).toBeVisible();

    const foreignPage=await second.newPage();
    await login(foreignPage,other);
    const denied=await second.request.get("/api/ai/suppliers/quotes");
    expect(denied.status()).toBe(200);
    expect((await denied.json()).items.some(q=>q.id===record.id)).toBe(false);
  } finally {
    await second.close();
    await first.close();
  }
});


test("@purchasing owner verifies a supplier phone/portal channel and a Gmail address without sending",async({browser})=>{
  test.setTimeout(160_000);
  const own=seededCafe(0),other=seededCafe(1);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const supplierId=randomUUID(),supplier="Task14C Vendor "+supplierId.slice(0,8);
  let connected=false;
  const first=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const second=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  try{
    await db.connect();connected=true;
    await db.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,$3)",
      [supplierId,own.businessId,supplier]);
    const page=await first.newPage();
    await login(page,own);
    await openOwnedPage(page,own,"operations/suppliers");
    const panel=page.getByRole("heading",{name:"Supplier ordering contacts and updates"}).locator("..");
    await expect(panel).toBeVisible({timeout:20_000});
    // Check authenticated scoped API evidence before waiting on native select.
    // Distinguish a broken API/seed from a slow client hydration.
    const contactRead=await first.request.get("/api/ai/suppliers/contacts");
    expect(contactRead.status(), "Task14C GET supplier-contact status").toBe(200);
    const knownSuppliers=(await contactRead.json()).suppliers;
    expect(knownSuppliers.some(s=>s.id===supplierId),
      "The authenticated owner must see the newly inserted supplier").toBe(true);
    // Initial page bootstrap may run before the owner session is settled.
    // Refresh is an actual owner recovery action, not a synthetic API bypass.
    await panel.getByRole("button",{name:"Refresh supplier contacts"}).click();
    await expect(panel.locator('select[aria-label="Supplier"] option[value="'+supplierId+'"]'))
      .toHaveCount(1,{timeout:25_000});
    await panel.getByLabel("Supplier",{exact:true}).selectOption(supplierId,{timeout:20_000});
    await panel.getByLabel("How you contact this supplier").first().selectOption("phone");
    await panel.getByLabel("Contact name, portal or notes (optional)").fill(
      "We normally call our account manager; no Gmail history is expected.");
    const saved=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/ai/suppliers/contacts"&&
      r.request().method()==="POST",{timeout:25_000});
    await panel.getByRole("button",{name:"Verify contact"}).click();
    const result=await saved;
    expect(result.status()).toBe(201);
    // A real click must both persist the owner-verified contact AND show a
    // durable success state. Do not wait on Playwright's response.json()
    // after a 201 header: this has stalled on the local Next.js RSC server.
    await expect(panel.getByRole("status")).toContainText(
      "Contact saved. Every email send still needs your separate approval.",
      {timeout:30_000});
    const phone=await db.query("select channel,email,revoked_at from public.cafe_supplier_order_contacts"+
      " where business_id=$1 and supplier_id=$2",[own.businessId,supplierId]);
    expect(phone.rows).toMatchObject([{channel:"phone",email:null,revoked_at:null}]);
    // The other café cannot read or change the target supplier.
    const outsider=await second.newPage();
    await login(outsider,other);
    const wrongCafe=await second.request.post("/api/ai/suppliers/contacts",{
      headers:{origin:"http://127.0.0.1:3000"},
      data:{action:"verify_contact",supplierId,channel:"gmail",
        email:"attacker@example.com",details:null}});
    expect(wrongCafe.status()).toBe(404);
    const otherRead=await second.request.get("/api/ai/suppliers/contacts");
    expect(otherRead.status()).toBe(200);
    expect((await otherRead.json()).suppliers.some(s=>s.id===supplierId)).toBe(false);
    // Explicit contact revocation blocks future sends; it does not create one.
    const revoked=await first.request.post("/api/ai/suppliers/contacts",{
      headers:{origin:"http://127.0.0.1:3000"},
      data:{action:"revoke_contact",supplierId}});
    expect(revoked.status()).toBe(200);
    const state=await db.query("select revoked_at from public.cafe_supplier_order_contacts"+
      " where business_id=$1 and supplier_id=$2",[own.businessId,supplierId]);
    expect(state.rows[0].revoked_at).not.toBeNull();
  }finally{
    await second.close();await first.close();
    if(connected){
      await db.query("delete from public.cafe_supplier_order_contacts where business_id=$1 and supplier_id=$2",
        [own.businessId,supplierId]).catch(()=>{});
      await db.query("delete from public.cafe_suppliers where business_id=$1 and id=$2",
        [own.businessId,supplierId]).catch(()=>{});
      await db.end();
    }
  }
});

test("@purchasing proactive notice → repeated cron idempotency → owner-approved PO → resolved forever",async({browser})=>{
  // This verifies the real owner/browser/database portion of the workflow.
  // Recorded model tests separately prove the multi-tool sequence; a sentinel
  // provider cannot be passed off as live-model or proactive parity evidence.
  test.setTimeout(240_000);
  const own=seededCafe(0),other=seededCafe(1);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const id={ingredient:randomUUID(),quote:randomUUID(),thread:randomUUID(),
    proposal:randomUUID(),replacedProposal:randomUUID()};
  const now=new Date();
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
    timeZone:own.timezone,year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(now).map(x=>[x.type,x.value]));
  const today=parts.year+"-"+parts.month+"-"+parts.day;
  const shift=d=>{const date=new Date(today+"T12:00:00Z");date.setUTCDate(date.getUTCDate()+d);
    return date.toISOString().slice(0,10)};
  const name="Task14B Milk "+id.ingredient.slice(0,8);
  const supplier="Task14B Farm "+id.quote.slice(0,8);
  const effect={
    supplierName:supplier,currency:own.currency,neededBy:shift(3),subtotalCents:450,
    totalCents:null,shippingCents:null,taxCents:null,
    limitations:["owner_reported_not_supplier_verified","shipping_unknown",
      "tax_unknown","landed_total_not_comparable"],
    lines:[{quoteId:id.quote,ingredientId:id.ingredient,itemName:name,
      neededBaseQuantity:3785.411784,baseUnit:"ml",packs:1,
      packQuantity:1,packUnit:"gal",priceCents:450,lineSubtotalCents:450,
      quotedOn:today,deliveryOn:shift(2)}]
  };
  const canonical=value=>Array.isArray(value)?value.map(canonical):
    value&&typeof value==="object"?Object.fromEntries(Object.entries(value)
      .sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
  const hash=createHash("sha256").update(JSON.stringify(canonical(effect))).digest("hex");
  let connected=false;
  const first=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const second=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  try{
    await db.connect();connected=true;
    await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,$3,'ml')",
      [id.ingredient,own.businessId,name]);
    await db.query("insert into public.ai_supplier_quotes("+
      " id,business_id,owner_user_id,client_request_id,supplier_name,item_name,ingredient_id,"+
      " price_cents,package_count,package_unit,source_kind,quoted_on,currency_code,"+
      " valid_until,available_status,available_checked_at,delivery_on)"+
      " values($1,$2,$3,$4,$5,$6,$7,450,1,'gal','supplier_quote',"+
      " $8::date,$9,$10::date,'confirmed',$8::date,$11::date)",
      [id.quote,own.businessId,own.owner.userId,randomUUID(),supplier,name,id.ingredient,
        today,own.currency,shift(5),shift(2)]);
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title)"+
      " values($1,$2,$3,$4,'Task14B Purchase Acceptance')",
      [id.thread,own.businessId,own.owner.userId,randomUUID()]);
    await db.query("insert into public.supervisor_proposals("+
      " id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,"+
      " canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,created_at)"+
      " values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,"+
      " $6::jsonb,$7,'{}'::jsonb,$8::jsonb,'en',now()-interval '3 hours')",
      [id.proposal,own.businessId,own.owner.userId,id.thread,randomUUID(),
        JSON.stringify(effect),hash,JSON.stringify({durationDays:1,metricScope:"supplier_purchase_order"})]);
    // Two REAL saved assistant cards: original rejected approval + replacement.
    // They share one thread but must NEVER display two action buttons.
    await db.query("insert into public.supervisor_proposals("+
      " id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,"+
      " canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision,created_at)"+
      " values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,"+
      " $6::jsonb,$7,'{}'::jsonb,$8::jsonb,'en','rejected',2,now()-interval '4 hours')",
      [id.replacedProposal,own.businessId,own.owner.userId,id.thread,randomUUID(),
        JSON.stringify(effect),hash,JSON.stringify({durationDays:1,metricScope:"supplier_purchase_order"})]);
    await db.query("insert into public.supplier_po_draft_replacements("+
      " business_id,previous_id,replacement_id,owner_user_id) values($1,$2,$3,$4)",
      [own.businessId,id.replacedProposal,id.proposal,own.owner.userId]);
    await db.query("insert into public.ai_messages("+
      " business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id)"+
      " values($1,$2,$3,$3,'owner','text',$4,$5)",
      [own.businessId,id.thread,own.owner.userId,
        "Compare milk quotes and prepare an order. Do not send it.",randomUUID()]);
    await db.query("insert into public.ai_messages("+
      " business_id,thread_id,owner_user_id,author_user_id,role,content_type,structured_content,grounding)"+
      " values($1,$2,$3,null,'supervisor','blocks',$4::jsonb,$5::jsonb)",
      [own.businessId,id.thread,own.owner.userId,
        JSON.stringify([{type:"text",text:"The earlier order was replaced after your correction."},
          {type:"proposal_card",proposalId:id.replacedProposal}]),
        JSON.stringify({status:"verified",intent:"operating_tasks",
          evidence:[{source:"owner_rules",identifier:"replaced-supplier-approval",asOf:today}]})]);
    await db.query("insert into public.ai_messages("+
      " business_id,thread_id,owner_user_id,author_user_id,role,content_type,structured_content,grounding)"+
      " values($1,$2,$3,null,'supervisor','blocks',$4::jsonb,$5::jsonb)",
      [own.businessId,id.thread,own.owner.userId,
        JSON.stringify([{type:"text",text:"I checked the saved quote and prepared a purchase order for approval. It has NOT been sent."},
          {type:"proposal_card",proposalId:id.proposal}]),
        JSON.stringify({status:"estimated",intent:"operating_tasks",
          evidence:[{source:"owner_rules",identifier:"task14b-e2e-proposal",asOf:today}]})]);
    const oldStock=await db.query("select count(*)::int as n from public.pantry_stock_purchases where business_id=$1",[own.businessId]);
    const oldExpense=await db.query("select count(*)::int as n from public.expenses where business_id=$1",[own.businessId]);

    const page=await first.newPage();
    await login(page,own);
    await openOwnedPage(page,own,"?thread="+encodeURIComponent(id.thread));
    // Verify the existing scheduled dispatcher, not a test-inserted notice.
    // Runner provides a fresh random local cron bearer; no provider key here.
    if(!process.env.CRON_SECRET)throw Error("Task14B local cron credential unavailable");
    const proactive=await first.request.get("/api/cron/refresh-derived",{
      headers:{Authorization:"Bearer "+process.env.CRON_SECRET},timeout:100_000,
    });
    expect([200,207]).toContain(proactive.status());
    const priority=await db.query("select id,status,agent_id,payload from public.operating_tasks"+
      " where business_id=$1 and owner_user_id=$2 and kind='priority_notice'"+
      " and payload->>'sourceType'='supplier_po' and payload->>'sourceId'=$3",
      [own.businessId,own.owner.userId,id.proposal]);
    expect(priority.rows).toHaveLength(1);
    expect(priority.rows[0]).toMatchObject({status:"needs_owner",agent_id:"maya"});
    expect(priority.rows[0].payload.threadId).toBe(id.thread);
    // Other actionable alerts may legitimately post in the SAME thread.
    // Exactly one notice must exist for THIS canonical supplier proposal,
    // never a duplicate and never another source masquerading as its notice.
    const messages=await db.query("select id,grounding from public.ai_messages"+
      " where business_id=$1 and thread_id=$2 and role='supervisor'"+
      " and grounding->>'intent'='priority_notice'"+
      " and grounding #>> '{evidence,0,source}'='supplier_po'"+
      " and grounding #>> '{evidence,0,identifier}'=$3",
      [own.businessId,id.thread,id.proposal]);
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0].grounding).toMatchObject({status:"verified",intent:"priority_notice",
      evidence:[{source:"supplier_po",identifier:id.proposal}]});
    // A second real scheduler tick without another owner message must reuse
    // the same persisted inbox/chat receipt across independent cron invocations.
    const secondTick=await first.request.get("/api/cron/refresh-derived",{
      headers:{Authorization:"Bearer "+process.env.CRON_SECRET},timeout:100_000,
    });
    expect([200,207]).toContain(secondTick.status());
    const dedupedPriority=await db.query("select id,status from public.operating_tasks"+
      " where business_id=$1 and owner_user_id=$2 and kind='priority_notice'"+
      " and payload->>'sourceType'='supplier_po' and payload->>'sourceId'=$3",
      [own.businessId,own.owner.userId,id.proposal]);
    expect(dedupedPriority.rows).toEqual([{
      id:priority.rows[0].id,status:"needs_owner",
    }]);
    const dedupedMessages=await db.query("select id from public.ai_messages"+
      " where business_id=$1 and thread_id=$2 and role='supervisor'"+
      " and grounding->>'intent'='priority_notice'"+
      " and grounding #>> '{evidence,0,source}'='supplier_po'"+
      " and grounding #>> '{evidence,0,identifier}'=$3",
      [own.businessId,id.thread,id.proposal]);
    expect(dedupedMessages.rows).toEqual([{id:messages.rows[0].id}]);
    // Reopened owner chat must show the real cron-generated notice.
    await page.reload();
    await expect(page.getByText("Supplier purchase-order draft needs your approval",{exact:false}).first())
      .toBeVisible({timeout:30_000});
    const cards=page.getByRole("region",{name:"Supplier purchase-order approval"});
    await expect(cards).toHaveCount(2,{timeout:30_000});
    const historical=cards.first(),card=cards.last();
    await expect(historical).toContainText("cancelled");
    await expect(historical.getByRole("button",{name:"Approve purchase order"})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Approve purchase order"})).toHaveCount(1);
    await expect(card).toBeVisible({timeout:30_000});
    await expect(card).toContainText(supplier);
    await expect(card).toContainText(name);
    await expect(card).toContainText("Shipping, tax and full landed total: unknown");
    await expect(card.getByRole("button",{name:"Approve purchase order"})).toBeVisible();
    const approved=page.waitForResponse(r=>new URL(r.url()).pathname===
      "/api/ai/threads/"+id.thread+"/proposals"&&r.request().method()==="POST");
    await card.getByRole("button",{name:"Approve purchase order"}).click();
    const response=await approved;
    expect(response.status()).toBe(200);
    await expect(card).toContainText("Approved for ordering — NOT sent to supplier",
      {timeout:30_000});
    const order=await db.query("select id,status,subtotal_cents,currency_code from public.purchase_orders"+
      " where business_id=$1 and proposal_id=$2",[own.businessId,id.proposal]);
    expect(order.rows).toHaveLength(1);
    expect(order.rows[0]).toMatchObject({status:"approved_for_ordering",
      subtotal_cents:"450",currency_code:own.currency});
    const settled=await db.query("select status from public.operating_tasks where business_id=$1 and id=$2",
      [own.businessId,priority.rows[0].id]);
    expect(settled.rows[0].status).toBe("handled");
    // Subsequent autonomous checks must not resurrect resolved owner work.
    const afterDecision=await first.request.get("/api/cron/refresh-derived",{
      headers:{Authorization:"Bearer "+process.env.CRON_SECRET},timeout:100_000,
    });
    expect([200,207]).toContain(afterDecision.status());
    const resolved=await db.query("select id,status from public.operating_tasks"+
      " where business_id=$1 and owner_user_id=$2 and kind='priority_notice'"+
      " and payload->>'sourceType'='supplier_po' and payload->>'sourceId'=$3",
      [own.businessId,own.owner.userId,id.proposal]);
    expect(resolved.rows).toEqual([{
      id:priority.rows[0].id,status:"handled",
    }]);
    const count=await db.query("select count(*)::int as n from public.purchase_order_lines"+
      " where business_id=$1 and purchase_order_id=$2",[own.businessId,order.rows[0].id]);
    expect(count.rows[0].n).toBe(1);
    const nowStock=await db.query("select count(*)::int as n from public.pantry_stock_purchases where business_id=$1",[own.businessId]);
    const nowExpense=await db.query("select count(*)::int as n from public.expenses where business_id=$1",[own.businessId]);
    expect(nowStock.rows[0].n).toBe(oldStock.rows[0].n);
    expect(nowExpense.rows[0].n).toBe(oldExpense.rows[0].n);
    await page.reload();
    const reopened=page.getByRole("region",{name:"Supplier purchase-order approval"});
    await expect(reopened).toHaveCount(2,{timeout:30_000});
    await expect(reopened.first()).toContainText("cancelled");
    await expect(reopened.last()).toContainText("Approved for ordering — NOT sent to supplier",
      {timeout:30_000});
    await expect(page.getByRole("button",{name:"Approve purchase order"})).toHaveCount(0);
    const foreignPage=await second.newPage();
    await login(foreignPage,other);
    const denied=await second.request.get("/api/ai/threads/"+id.thread+"/proposals?ids="+id.proposal);
    expect(denied.status()).not.toBe(200);
  }finally{
    await second.close();await first.close();
    if(connected){
      const queries=[
        ["delete from public.supplier_po_draft_replacements where business_id=$1 and previous_id=$2",
          [own.businessId,id.replacedProposal]],
        ["delete from public.purchase_order_events where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.purchase_order_lines where business_id=$1 and purchase_order_id in"+
          " (select id from public.purchase_orders where business_id=$1 and proposal_id=$2)",
          [own.businessId,id.proposal]],
        ["delete from public.purchase_orders where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.cafe_suppliers where business_id=$1 and display_name=$2",
          [own.businessId,supplier]],
        ["delete from public.operating_tasks where business_id=$1 and kind='priority_notice'"+
          " and payload->>'sourceType'='supplier_po' and payload->>'sourceId'=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_approvals where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_proposals where business_id=$1 and id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_proposals where business_id=$1 and id=$2",
          [own.businessId,id.replacedProposal]],
        ["delete from public.ai_messages where business_id=$1 and thread_id=$2",
          [own.businessId,id.thread]],
        ["delete from public.ai_threads where business_id=$1 and id=$2",
          [own.businessId,id.thread]],
        ["delete from public.ai_supplier_quotes where business_id=$1 and id=$2",
          [own.businessId,id.quote]],
        ["delete from public.ingredients where business_id=$1 and id=$2",
          [own.businessId,id.ingredient]]
      ];
      for(const [query,params] of queries)await db.query(query,params).catch(()=>{});
      await db.end();
    }
  }
});


test("@gmail Task16C owner revokes live external access across mobile reload and cafés",async({browser})=>{
  test.setTimeout(120_000);
  const own=seededCafe(0),other=seededCafe(1);
  const attachmentId=randomUUID(),threadId=randomUUID(),accountId=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  // Authenticate with the existing desktop login helper first; it checks a
  // desktop-only café-name nav. Then exercise the ENTIRE permission flow at
  // the real 390px mobile viewport, including the second café.
  const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",
    serviceWorkers:"block"});
  const foreign=await browser.newContext({baseURL:"http://127.0.0.1:3000",
    serviceWorkers:"block"});
  let connected=false;
  try{
    await db.connect();connected=true;
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
      [threadId,own.businessId,own.owner.userId,randomUUID()]);
    await db.query("insert into public.ai_attachments(id,business_id,owner_user_id,thread_id,object_path,original_name,media_type,bytes) values($1,$2,$3,$4,$5,'suppliers.csv','text/csv',12)",
      [attachmentId,own.businessId,own.owner.userId,threadId,
        [own.businessId,own.owner.userId,threadId,attachmentId,"suppliers.csv"].join("/")]);
    await db.query("insert into public.connector_accounts(id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,enabled_operations,status) values($1,$2,$3,'gmail','disposable-only','fixture-owner@example.invalid',ARRAY['https://www.googleapis.com/auth/gmail.modify'],ARRAY['read','draft','send','organize'],'active')",
      [accountId,own.businessId,own.owner.userId]);
    await db.query("insert into public.connector_credentials(account_id,generation,access_token_enc,refresh_token_enc,token_expires_at) values($1,1,$2,$3,now()+interval '1 hour')",
      [accountId,"c".repeat(64),"d".repeat(64)]);
    const page=await context.newPage();
    await login(page,own);
    await openOwnedPage(page,own,"more/supervisor-access");
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole("heading",{name:"Supervisor access"})).toBeVisible();
    await expect(page.getByText("fixture-owner@example.invalid")).toBeVisible();
    await expect(page.getByRole("heading",{name:"Website and computer control"})).toBeVisible();
    await expect(page.getByText("suppliers.csv",{exact:true})).toBeVisible();
    const publicWeb=page.getByRole("switch",{name:"Public web research"});
    const fileReading=page.getByRole("switch",{name:"Use my selected files"});
    await expect(publicWeb).toHaveAttribute("aria-checked","true");
    await publicWeb.click();
    await expect(publicWeb).toHaveAttribute("aria-checked","false");
    let current=await db.query("select allowed,revision from public.supervisor_external_access where business_id=$1 and owner_user_id=$2 and kind='public_web' and resource_key='public'",
      [own.businessId,own.owner.userId]);
    expect(current.rows).toMatchObject([{allowed:false,revision:"1"}]);
    await fileReading.click();
    await expect(fileReading).toHaveAttribute("aria-checked","false");
    page.once("dialog",dialog=>void dialog.accept());
    const selectedFile=page.getByRole("group",{name:"suppliers.csv",exact:true});
    await expect(selectedFile).toBeVisible();
    await selectedFile.getByRole("button",{name:"Revoke future access"}).click();
    await expect(page.getByText("Future Supervisor access revoked")).toBeVisible();
    const accountSwitch=page.getByRole("switch",{name:"Send messages after your approval"});
    await expect(accountSwitch).toHaveAttribute("aria-checked","true");
    await accountSwitch.click();
    await expect(accountSwitch).toHaveAttribute("aria-checked","false");
    const gmail=await db.query("select generation,enabled_operations from public.connector_accounts where id=$1",[accountId]);
    expect(Number(gmail.rows[0].generation)).toBe(2);
    expect(gmail.rows[0].enabled_operations).not.toContain("send");
    const secret=await db.query("select generation from public.connector_credentials where account_id=$1",[accountId]);
    expect(Number(secret.rows[0].generation)).toBe(2);
    const audits=await db.query("select kind,resource_key,allowed from public.supervisor_external_access_audit where business_id=$1 and owner_user_id=$2",
      [own.businessId,own.owner.userId]);
    expect(audits.rows).toHaveLength(3);
    const gmailAudits=await db.query("select after_operations from public.connector_operation_change_receipts where account_id=$1",[accountId]);
    expect(gmailAudits.rows).toHaveLength(1);
    // Browser reload must display persistent owner-controlled permissions, not stale local UI state.
    await page.reload();
    await expect(publicWeb).toHaveAttribute("aria-checked","false");
    await expect(fileReading).toHaveAttribute("aria-checked","false");
    await expect(accountSwitch).toHaveAttribute("aria-checked","false");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const otherPage=await foreign.newPage();
    await login(otherPage,other);
    await openOwnedPage(otherPage,other,"more/supervisor-access");
    await otherPage.setViewportSize({width:390,height:844});
    await expect(otherPage.getByText("suppliers.csv",{exact:true})).toHaveCount(0);
    await expect(otherPage.getByText("fixture-owner@example.invalid",{exact:true})).toHaveCount(0);
    const stolen=await foreign.request.post("/api/supervisor/access",{
      headers:{origin:"http://127.0.0.1:3000"},
      data:{kind:"attachment",enabled:false,attachmentId,revision:0}});
    expect(stolen.status()).not.toBe(200);
    // A broken permission endpoint cannot be shown as a successful switch.
    await page.route("**/api/supervisor/access",route=>
      route.request().method()==="POST"?route.fulfill({status:503,
        contentType:"application/json",body:'{"error":"unavailable"}'}):route.continue());
    await publicWeb.click();
    await expect(page.getByRole("alert").filter({hasText:"Could not verify the change"}))
      .toContainText("Could not verify the change");
    await expect(publicWeb).toHaveAttribute("aria-checked","false");
  }finally{
    await context.close();await foreign.close();
    if(connected){
      await db.query("delete from public.supervisor_external_access_audit where business_id=$1 and owner_user_id=$2",
        [own.businessId,own.owner.userId]).catch(()=>{});
      await db.query("delete from public.supervisor_external_access where business_id=$1 and owner_user_id=$2",
        [own.businessId,own.owner.userId]).catch(()=>{});
      await db.query("delete from public.connector_operation_change_receipts where account_id=$1",[accountId]).catch(()=>{});
      await db.query("delete from public.connector_accounts where id=$1",[accountId]).catch(()=>{});
      await db.query("delete from public.ai_attachments where id=$1",[attachmentId]).catch(()=>{});
      await db.query("delete from public.ai_threads where id=$1",[threadId]).catch(()=>{});
      await db.end();
    }
  }
});


test("@home Task16D authenticated responsive Supervisor work across conversations", async ({browser},testInfo) => {
  test.setTimeout(180_000);
  const owner=seededCafe(0);
  const threadId=randomUUID(), runId=randomUUID(), requestId=randomUUID();
  const otherThread=randomUUID(),otherRun=randomUUID(),messageId=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  let connected=false;
  try {
    await db.connect();connected=true;
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [threadId,owner.businessId,owner.owner.userId,randomUUID(),"Supervisor owner journey"]);
    await db.query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'pending')",
      [runId,owner.businessId,owner.owner.userId,threadId,requestId,"a".repeat(64)]);
    await db.query("insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode,status) values($1,$2,'owner_turn',1,'reconcile','pending')",
      [owner.businessId,runId]);
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [otherThread,owner.businessId,owner.owner.userId,randomUUID(),"Earlier supplier conversation"]);
    await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id,created_at) values($1,$2,$3,$4,$4,'owner','text','Please investigate this supplier',gen_random_uuid(),now()-interval '2 days')",
      [messageId,owner.businessId,otherThread,owner.owner.userId]);
    await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id,created_at) select $1,$2,$3,$3,'owner','text','Later message '||n,gen_random_uuid(),now()-n*interval '1 minute' from generate_series(1,60) n",
      [owner.businessId,otherThread,owner.owner.userId]);
    await db.query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'pending')",
      [otherRun,owner.businessId,owner.owner.userId,otherThread,messageId,"b".repeat(64)]);
    await db.query("insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode,status) values($1,$2,'owner_turn',1,'reconcile','pending')",
      [owner.businessId,otherRun]);
    const page=await context.newPage();
    await login(page,owner);
    await openOwnedPage(page,owner,"?thread="+threadId);
    const controls=page.getByRole("button",{name:"Library, routines and permissions"});
    const work=page.getByRole("region",{name:"Supervisor work"});
    for (const viewport of [{width:390,height:844},{width:1440,height:900}]) {
      await page.setViewportSize(viewport);
      await expect(controls).toBeVisible();
      await expect(work.locator('[data-work-status="queued"]')).toBeVisible();
      const before=await page.evaluate(()=>({
        viewport:window.innerWidth, documentWidth:document.documentElement.scrollWidth,
        composerVisible:!!document.querySelector("#supervisor-home-composer")?.getBoundingClientRect().height,
      }));
      await page.screenshot({path:testInfo.outputPath("baseline-chat-"+viewport.width+".png")});
      await controls.click();
      const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button",{name:"Library",exact:true}).click();
      await expect(drawer.getByRole("button",{name:"Supervisor owner journey"})).toBeVisible();
      await drawer.getByRole("button",{name:"Permissions",exact:true}).click();
      await page.screenshot({path:testInfo.outputPath("baseline-controls-"+viewport.width+".png")});
      const accessLink=await drawer.locator('a[href*="supervisor-access"]').count();
      await drawer.evaluate(el=>{const elements=[...el.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled])')].filter(e=>e.getClientRects().length);elements.at(-1)?.focus();});
      await page.keyboard.press("Tab");
      const tabContained=await drawer.evaluate(el=>el.contains(document.activeElement));
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      const focusRestored=await controls.evaluate(el=>document.activeElement===el);
      expect(before.documentWidth).toBeLessThanOrEqual(viewport.width);
      expect(before.composerVisible).toBe(true);
      expect(accessLink).toBe(1);expect(tabContained).toBe(true);expect(focusRestored).toBe(true);
      console.info("[Task16D authenticated]",JSON.stringify({...before,accessLink,tabContained,focusRestored}));
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button",{name:"Supervisor work",exact:true}).click();
    const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
    const earlier=drawer.locator('[data-work-id="run:'+otherRun+'"]');
    await expect(earlier).toContainText("Earlier supplier conversation");
    // Initial target-thread message read fails; no terminal job exists to reload it.
    const initialMessages=`**/api/ai/threads/${otherThread}/messages?offset=0`;
    await page.route(initialMessages,route=>route.fulfill({status:503,body:"{}"}));
    await earlier.getByRole("button").click();
    await expect(page.getByText("I couldn't finish that answer.",{exact:true})).toBeVisible();
    await page.unroute(initialMessages);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    const target=page.locator('[data-work-message="'+messageId+'"]');
    await expect(target).toBeFocused({timeout:30_000});
    await expect(target).toContainText("Please investigate this supplier");
    expect((await db.query("select status from public.supervisor_runs where id=$1",[otherRun])).rows[0].status).toBe("pending");
    await controls.click();
    await drawer.getByRole("link",{name:"Supervisor access"}).click();
    await expect(page.getByRole("switch").first()).toBeVisible();
    console.info("[Task16D authenticated] canonical external access page rendered");
    await page.getByRole("link",{name:"Back",exact:true}).click();
    await expect(page).toHaveURL(new RegExp("thread="+otherThread));
    await page.screenshot({path:testInfo.outputPath("baseline-access.png")});
  } finally {
    await context.close();
    if(connected){
      await db.query("delete from public.ai_threads where id=any($1::uuid[]) and business_id=$2",[[threadId,otherThread],owner.businessId]).catch(()=>{});
      await db.end();
    }
  }
});

test("@money historical statement imports work without a bank connection and persist only owner-confirmed balances",async({page})=>{
 test.setTimeout(90000);
 const cafe=seededCafe(0),alias="checking "+randomUUID().slice(0,8).replace(/[0-9]/g,"a");
 const csv="Date,Description,Amount,Balance\n2026-01-01,Test deposit "+alias+",100,1000\n2026-01-02,Test deposit "+alias+",50,1050\n";
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const digest=createHash("sha256").update(csv).digest("hex");
 await db.connect();
 try{
  await login(page,cafe);
  await page.goto("/en/add-cost/statement");
  await page.locator('input[type=file]').setInputFiles({name:"statement.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});
  await expect(page.getByText("Balance checks out")).toBeVisible();
  const confirm=page.getByRole("checkbox",{name:/Use this original statement as historical cash evidence/});
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await page.getByRole("textbox",{name:/Account nickname/}).fill(alias);
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByText(/Not a live balance or proof of all accounts/)).toBeVisible();
  await page.getByRole("button",{name:"Save all",exact:true}).click();
  await expect.poll(async()=>{
   const {rows}=await db.query("select financial_currency,financial_to::text,financial_closing_cents,financial_owner_user_id from public.uploads where business_id=$1 and financial_source_sha256=$2",[cafe.businessId,digest]);
   return rows.map(r=>[r.financial_currency,r.financial_to,Number(r.financial_closing_cents),r.financial_owner_user_id]);
  },{timeout:20000}).toEqual([[cafe.currency,"2026-01-02",105000,cafe.owner.userId]]);
 }finally{await db.query("delete from public.uploads where business_id=$1 and financial_source_sha256=$2",[cafe.businessId,digest]);await db.end();}
});

test("@gmail Task15A authenticated usage and admin cost ledger are scoped",async({browser})=>{
  test.setTimeout(120_000);
  const owner=seededCafe(0),foreign=seededCafe(1),thread=randomUUID(),attempt=randomUUID(),source=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const a=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"}),b=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  try{
    await db.connect();
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values ($1,$2,$3,$4,$5)",[thread,owner.businessId,owner.owner.userId,randomUUID(),"Usage verification"]);
    await db.query("insert into public.supervisor_system_usage_events(attempt_id,business_id,owner_user_id,thread_id,source_type,source_id,model,attempt_day,reserved_input_upper,reserved_output_cap,status) values ($1,$2,$3,$4,'alert',$5,'gpt-6-luna',(now() at time zone 'UTC')::date,100,50,'attempted')",[attempt,owner.businessId,owner.owner.userId,thread,source]);
    const count=async(cafe)=>Number((await db.query("select count(distinct (source_type,source_id)) n from public.supervisor_system_usage_events where business_id=$1 and owner_user_id=$2 and source_type in ('alert','operating_task') and attempt_day>=date_trunc('month',now() at time zone 'UTC')::date",[cafe.businessId,cafe.owner.userId])).rows[0].n);
    for(const [context,cafe] of [[a,owner],[b,foreign]]){
      const page=await context.newPage();
      await login(page,cafe);
      await openOwnedPage(page,cafe,"more/supervisor-access");
      const usage=page.getByRole("region",{name:"Supervisor usage"});
      await expect(usage.getByText("Max · Unlimited",{exact:true})).toBeVisible();
      await expect(usage.getByText("Proactive work items",{exact:true}).locator("..").locator("dd")).toHaveText((await count(cafe)).toLocaleString("en-US"));
      await expect(usage.getByText("Owner requests",{exact:true})).toBeVisible();
      await page.goto("/admin/costs");
      if(cafe===owner){
        const ledger=page.locator("section").filter({has:page.getByRole("heading",{name:"Supervisor metered activity"})});
        await expect(ledger.getByRole("row").filter({hasText:cafe.name}).filter({hasText:"Proactive"})).toContainText("calls unknown");
      }else{
        await expect(page.getByRole("heading",{name:"Supervisor metered activity"})).toHaveCount(0);
      }
    }
  }finally{
    await a.close();await b.close();
    await db.query("delete from public.supervisor_system_usage_events where attempt_id=$1",[attempt]).catch(()=>{});
    await db.query("delete from public.ai_threads where id=$1",[thread]).catch(()=>{});
    await db.end();
  }
});

test("@home Task15A scheduler detects reduced sales from actual daily source rows",async({browser})=>{
 test.setTimeout(180_000);
 const own=seededCafe(0);
 const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 let original=[],activeSchedules=[],connected=false;
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:own.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const date=(n)=>new Date(Date.parse(today+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
 const start=date(-14),end=date(-1);
 if(!process.env.CRON_SECRET)throw Error("Task15A local cron credential unavailable");
 try{
  await db.connect();connected=true;
  original=(await db.query("select to_jsonb(d) row from public.daily_rollups d where business_id=$1 and business_date between $2 and $3",[own.businessId,start,end])).rows.map(x=>x.row);
  // Isolate stored actual daily source facts from unrelated schedule materialization.
  activeSchedules=(await db.query("select id from public.staff_schedules where business_id=$1 and active",[own.businessId])).rows.map(row=>row.id);
  await db.query("update public.staff_schedules set active=false where business_id=$1 and id=any($2::uuid[])",[own.businessId,activeSchedules]);
  const prior=await db.query("select id from public.alerts where business_id=$1 and kind='business_anomaly' and payload->>'dedupeKey'='sales_decline:cafe'",[own.businessId]);
  await db.query("insert into public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status) select $1,d::date,case when d::date<=$3::date then 100000 else 60000 end,50,50,10000,10000,1000,1000,0,'actual' from generate_series($2::date,$4::date,interval '1 day') d on conflict(business_id,business_date) do update set net_sales_cents=excluded.net_sales_cents,sales_data_status='actual'",[own.businessId,start,date(-8),end]);
  const tick=()=>context.request.get("/api/cron/refresh-derived",{headers:{Authorization:"Bearer "+process.env.CRON_SECRET},timeout:100_000});
  expect([200,207]).toContain((await tick()).status());
  const active=()=>db.query("select id,status,payload from public.alerts where business_id=$1 and kind='business_anomaly' and status in ('new','seen') and payload->>'dedupeKey'='sales_decline:cafe'",[own.businessId]).then(r=>r.rows);
  const facts=await db.query("select sum(net_sales_cents) filter(where business_date < $2::date)::int previous,sum(net_sales_cents) filter(where business_date >= $2::date)::int current,count(*) filter(where sales_data_status='actual')::int covered from public.daily_rollups where business_id=$1 and business_date between $3 and $4",[own.businessId,date(-7),start,end]);
  expect(facts.rows[0]).toEqual({previous:700000,current:420000,covered:14});
  const rows=await active();expect(rows).toHaveLength(1);
  expect(rows[0].payload).toMatchObject({current:420000,previous:700000,unit:"cents",family:"sales_decline"});
  const page=await context.newPage();await login(page,own);await openOwnedPage(page,own,"more/alerts");
  await expect(page.getByText("Sales declined",{exact:true}).first()).toBeVisible({timeout:30000});
  // Restore known healthy comparable source facts rather than marking the alert handled manually.
  await db.query("update public.daily_rollups set net_sales_cents=100000 where business_id=$1 and business_date between $2 and $3",[own.businessId,date(-7),end]);
  expect([200,207]).toContain((await tick()).status());expect(await active()).toHaveLength(0);
  // No fixture downstream of the real detector; rollback source data in finally.
  if(!prior.rows.some(x=>x.id===rows[0].id))await db.query("delete from public.alerts where business_id=$1 and id=$2",[own.businessId,rows[0].id]);
 }finally{
  await context.close();
  if(connected){
   await db.query("delete from public.daily_rollups where business_id=$1 and business_date between $2 and $3",[own.businessId,start,end]);
   if(original.length)await db.query("insert into public.daily_rollups select * from jsonb_populate_recordset(null::public.daily_rollups,$1::jsonb)",[JSON.stringify(original)]);
   await db.query("update public.staff_schedules set active=true where business_id=$1 and id=any($2::uuid[])",[own.businessId,activeSchedules]);
   await db.end();
  }
 }
});

// Task16E design-stage observation only. Real authenticated seeded app, no model
// calls, mutations of business facts, new workflow or production access.
test("@home Task16E design baseline observes empty and long Supervisor conversations",async({browser},testInfo)=>{
  test.setTimeout(300_000);
  const owner=seededCafe(0), thread=randomUUID(), empty=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  await db.connect();
  try{
    for(const [id,title] of [[thread,"Task16E long synthetic conversation"],[empty,"Task16E empty synthetic conversation"]])
      await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",[id,owner.businessId,owner.owner.userId,randomUUID(),title]);
    await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id,created_at) select $1,$2,$3,$3,'owner','text','Synthetic owner question '||n,gen_random_uuid(),now()-n*interval '2 minutes' from generate_series(1,505) n",[owner.businessId,thread,owner.owner.userId]);
    await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,'supervisor','blocks',$4::jsonb,$5::jsonb)",
      [owner.businessId,thread,owner.owner.userId,JSON.stringify([{type:"text",text:"Synthetic audit reply: review the saved business evidence. No external action was taken."}]),JSON.stringify({status:"estimated",intent:"operating_tasks",evidence:[]})]);
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
      const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
      try{
        const page=await ctx.newPage();
        await login(page,owner);
        // The shared auth helper checks a visible desktop café label; mobile hides it.
        // Verify owner on desktop first, then assert the exact thread URL on each measured navigation.
        await openOwnedPage(page,owner,"?thread="+empty);
        await page.setViewportSize(viewport);
        const requests={threads:0,messages:0,attachments:0,work:0,otherApi:0,rsc:0};
        const readFailures=[];
        page.on("response",response=>{
          const url=new URL(response.url());
          if(url.pathname.startsWith("/api/ai/threads")&&response.status()>=400)
            readFailures.push({kind:url.pathname.endsWith("/messages")?"messages":url.pathname.endsWith("/attachments")?"attachments":"threads-or-work",status:response.status()});
        });
        page.on("request",r=>{
          const u=new URL(r.url());
          if(u.origin!=="http://127.0.0.1:3000")return;
          if(u.searchParams.has("_rsc"))requests.rsc++;
          if(u.pathname==="/api/ai/threads")requests.threads++;
          else if(/^\/api\/ai\/threads\/[^/]+\/messages$/.test(u.pathname))requests.messages++;
          else if(/^\/api\/ai\/threads\/[^/]+\/attachments$/.test(u.pathname))requests.attachments++;
          else if(/^\/api\/ai\/threads\/[^/]+\/work$/.test(u.pathname))requests.work++;
          else if(u.pathname.startsWith("/api/"))requests.otherApi++;
        });
        const geometry=()=>page.evaluate(()=>{
          const input=document.querySelector("#supervisor-home-composer");
          const rect=input?.getBoundingClientRect();
          const scrollRegions=[...document.querySelectorAll("main *, [role=log]")].filter(el=>{
            const style=getComputedStyle(el);
            return /auto|scroll/.test(style.overflowY)&&el.clientHeight>0&&el.scrollHeight>el.clientHeight+2;
          });
          const nav=performance.getEntriesByType("navigation")[0];
          return {documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,
            viewportHeight:innerHeight,composerInViewport:!!rect&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight+1,
            scrollRegions:scrollRegions.length,renderedMessages:document.querySelectorAll("[data-work-message]").length,
            navigationMs:nav?Math.round(nav.domContentLoadedEventEnd):null};
        });
        const controls=page.getByRole("button",{name:"Library, routines and permissions"});
        const input=page.locator("#supervisor-home-composer");
        const start=Date.now();
        await expect(page).toHaveURL(new RegExp("[?&]thread="+empty+"(?:&|$)"));
        await expect(page.getByTestId("supervisor-welcome")).toBeVisible();
        await expect(input).toBeVisible();
        const emptyMs=Date.now()-start;
        const emptyMetrics=await geometry();
        await page.screenshot({path:testInfo.outputPath("16e-empty-"+viewport.width+".png")});
        const longStart=Date.now();
        await controls.click();
        const historyDrawer=page.getByRole("dialog",{name:"Supervisor controls"});
        await historyDrawer.getByRole("button",{name:"Library",exact:true}).click();
        await historyDrawer.getByRole("button",{name:"Task16E long synthetic conversation",exact:true}).click();
        await expect(page).toHaveURL(new RegExp("[?&]thread="+thread+"(?:&|$)"));
        await expect(page.getByText("Synthetic owner question 1",{exact:true})).toBeVisible();
        await expect(input).toBeVisible();
        const longMs=Date.now()-longStart;
        const longMetrics=await geometry();
        await page.screenshot({path:testInfo.outputPath("16e-thread-"+viewport.width+".png")});
        const drawerStart=Date.now();
        await controls.click();
        const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
        await expect(drawer).toBeVisible();
        const drawerMs=Date.now()-drawerStart;
        await page.screenshot({path:testInfo.outputPath("16e-controls-"+viewport.width+".png")});
        await page.keyboard.press("Escape");
        await expect(drawer).toHaveCount(0);
        const restored=await controls.evaluate(el=>document.activeElement===el);
        await input.focus();
        const focused=await geometry();
        console.info("[Task16E baseline]",JSON.stringify({viewport,emptyMs,longMs,drawerMs,emptyMetrics,longMetrics,focused,focusRestored:restored,requests,condition:"seeded CI dev server, warm authenticated navigation, desktop Chromium viewport; not real mobile keyboard or production"}));
        if(viewport.width===1440){
          await page.getByRole("button",{name:"Load older messages",exact:true}).click();
          await expect(page.getByText("Synthetic owner question 65",{exact:true})).toBeAttached();
          // Load the complete long history through the actual owner pagination path.
          // Treat this as a diagnostic, not a claim about production latency.
          const historyStarted=Date.now();
          const older=page.getByRole("button",{name:"Load older messages",exact:true});
          const messageRows=page.locator("[data-work-message]");
          for(let i=0;i<12&&await older.isVisible();i++){
            const before=await messageRows.count();
            await older.click();
            try{
              await expect.poll(()=>messageRows.count(),{timeout:30000}).toBeGreaterThan(before);
            }catch(error){
              console.info("[Task16E history failure]",JSON.stringify({before,after:await messageRows.count(),readFailures,ownerSessionDenied:await page.getByText("Your owner session needs to be verified again",{exact:false}).count()>0,threadUnavailable:await page.getByRole("alert").count()>0}));
              throw error;
            }
          }
          await expect(page.getByText("Synthetic owner question 505",{exact:true})).toBeAttached();
          await expect(older).toHaveCount(0);
          await expect(messageRows).toHaveCount(506);
          console.info("[Task16E 500+ history]",JSON.stringify({loaded:await messageRows.count(),paginationMs:Date.now()-historyStarted,geometry:await geometry(),requests,condition:"seeded dev server; no production latency claim"}));
          const latest="Synthetic persisted refresh after history pagination";
          await db.query("insert into public.ai_messages(business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,'supervisor','blocks',$4::jsonb,$5::jsonb)",[owner.businessId,thread,owner.owner.userId,JSON.stringify([{type:"text",text:latest}]),JSON.stringify({status:"estimated",intent:"unknown",evidence:[]})]);
          await expect.poll(async()=>{await page.evaluate(()=>window.dispatchEvent(new Event("focus")));return await page.getByText(latest,{exact:true}).count();},{timeout:30000}).toBe(1);
          await expect(page.getByText("Synthetic owner question 505",{exact:true})).toBeAttached();
          await expect(messageRows).toHaveCount(507);
          expect(await page.locator("[data-work-message]").evaluateAll(nodes=>new Set(nodes.map(n=>n.getAttribute("data-work-message"))).size)).toBe(await page.locator("[data-work-message]").count());
          // Switching threads must not abandon a reader in older history.
          const oldQuestion=page.getByText("Synthetic owner question 505",{exact:true});
          await oldQuestion.scrollIntoViewIfNeeded();
          const oldId=await oldQuestion.locator("xpath=ancestor::*[@data-work-message][1]").getAttribute("data-work-message");
          const log=page.getByRole("log");
          const previous=await log.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight}));
          expect(previous.height-previous.client-previous.top).toBeGreaterThan(64);
          await controls.click();
          await page.getByRole("button",{name:"Task16E empty synthetic conversation",exact:true}).click();
          await expect(page.getByTestId("supervisor-welcome")).toBeVisible();
          await controls.click();
          await page.getByRole("button",{name:"Task16E long synthetic conversation",exact:true}).click();
          await expect(page.locator('[data-work-message="'+oldId+'"]')).toBeAttached({timeout:30000});
          await expect.poll(()=>log.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop),{timeout:10000}).toBeGreaterThan(64);
          const restoredPosition=await page.locator('[data-work-message="'+oldId+'"]').evaluate(el=>{
            const parent=el.closest('[role="log"]');const a=el.getBoundingClientRect(),b=parent.getBoundingClientRect();
            return a.bottom>b.top&&a.top<b.bottom;
          });
          expect(restoredPosition).toBe(true);
        }
      }finally{await ctx.close();}
    }
  }finally{
    await db.query("delete from public.ai_threads where id=any($1::uuid[]) and business_id=$2",[[thread,empty],owner.businessId]).catch(()=>{});
    await db.end();
  }
});


// Task16E acceptance: exercise the real persisted renderer and controls in the
// disposable café. This is a synthetic presentation fixture, not model or
// financial truth acceptance. Task17B/C/D own live evidence and effect proof.
test("@home Task16E quiet shell, optional visuals, editable follow-up and mobile navigation",async({browser},testInfo)=>{
  test.setTimeout(300_000);
  const owner=seededCafe(0), empty=randomUUID(), thread=randomUUID(), replyId=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const text="Sales rose from $100.00 to $125.00. That is $25.00 more, although it does not prove profit increased.";
  const visual={type:"rich_presentation",version:1,layout:"stack",panels:[{
    kind:"line",title:"Synthetic daily sales",unit:"cents",currency:"USD",
    from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-02",source:"daily_rollups",
    points:[{label:"2026-01-01",value:10000},{label:"2026-01-02",value:12500}],
  }],suggestions:["Explain how costs affect this"]};
  await db.connect();
  try{
    for(const [id,title] of [[empty,"Task16E welcome fixture"],[thread,"Task16E answer fixture"]])
      await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",[id,owner.businessId,owner.owner.userId,randomUUID(),title]);
    await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,$4,'supervisor','blocks',$5::jsonb,$6::jsonb)",[replyId,owner.businessId,thread,owner.owner.userId,JSON.stringify([{type:"text",text},visual]),JSON.stringify({status:"verified",intent:"sales_quantity",evidence:[{source:"historical_rollups",identifier:"synthetic-e2e",asOf:"2026-01-02"}]})]);
    const page=await ctx.newPage();await login(page,owner);
    // The first viewport navigates to the empty fixture below. Avoid a redundant
    // full load wait; assert actual owner shell and fixture state on every navigation.
    async function openFixture(id){
      const response=await page.goto("/en/?thread="+id,{waitUntil:"domcontentloaded",timeout:30000});
      expect(response?.ok()).toBe(true);
      await expect(page).not.toHaveURL(/\/login(?:\?|$)|\/onboarding(?:\?|$)/);
      // The authenticated desktop café label stays in the DOM on mobile but is
      // intentionally hidden; the actual interactive owner shell must be visible.
      await expect(page.getByText(owner.name,{exact:true}).first()).toBeAttached({timeout:30000});
      await expect(page.locator("#supervisor-home-composer")).toBeVisible({timeout:30000});
    }
    let writes=0;
    page.on("request",r=>{if(r.method()==="POST"&&/\/api\/ai\/threads\/[^/]+\/(agent|messages)$/.test(new URL(r.url()).pathname))writes++;});
    for(const viewport of [{width:320,height:720},{width:390,height:844},{width:430,height:932},{width:768,height:1024},{width:1024,height:768},{width:1440,height:900}]){
      await page.setViewportSize(viewport);await openFixture(empty);
      const input=page.locator("#supervisor-home-composer");
      const welcome=page.getByTestId("supervisor-welcome");
      await expect(welcome).toBeVisible({timeout:30000});
      await page.emulateMedia({reducedMotion:"reduce"});
      expect(await welcome.evaluate(el=>getComputedStyle(el).animationName)).toBe("none");
      await expect(input).toBeVisible();
      const board=page.getByTestId("chat-start").locator("button[aria-expanded]").first();
      await expect(board).toHaveAttribute("aria-expanded","false");
      await board.click();
      await expect(board).toHaveAttribute("aria-expanded","true");
      await expect(page.getByRole("region",{name:"Key numbers",exact:true})).toBeVisible();
      await board.click();await expect(board).toHaveAttribute("aria-expanded","false");
      const controls=page.getByRole("button",{name:"Library, routines and permissions"});
      await controls.click();
      const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
      await expect(drawer.getByRole("button",{name:"Library",exact:true})).toBeVisible();
      if(viewport.width<768){
        const nav=drawer.getByRole("navigation",{name:"Primary navigation"});
        for(const route of ["/en","/en/operations","/en/money","/en/menu","/en/staff","/en/more"]){
          const path=route==="/en"?/\/en\/?$/:new RegExp(route+"$");
          expect(await nav.getByRole("link").evaluateAll(links=>links.map(l=>l.getAttribute("href")))).toEqual(expect.arrayContaining([expect.stringMatching(path)]));
        }
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);await expect(controls).toBeFocused();
      if(viewport.width>=768){
        const nav=page.getByRole("navigation",{name:"Primary navigation"});
        const rail=nav.getByRole("button",{name:"Primary navigation",exact:true});
        await expect(rail).toHaveAttribute("aria-expanded","true");
        await rail.click();await expect(rail).toHaveAttribute("aria-expanded","false");
        await expect(nav.getByRole("link",{name:"Money",exact:true})).toBeVisible();
        await rail.click();await expect(rail).toHaveAttribute("aria-expanded","true");
      }
      await openFixture(thread);
      const answer=page.locator('[data-work-message="'+replyId+'"]');
      await expect(answer).toContainText(text,{timeout:30000});
      const rich=answer.getByTestId("supervisor-rich-presentation");
      await expect(rich.getByTestId("supervisor-rich-chart")).toBeVisible({timeout:30000});
      await rich.locator("details summary").click();
      await expect(rich.getByRole("table")).toBeVisible();
      await expect(rich.getByRole("row").filter({hasText:"2026-01-02"})).toContainText("$125.00");
      const suggest=rich.getByRole("button",{name:"Explain how costs affect this"});
      await suggest.click();await expect(input).toHaveValue("Explain how costs affect this");
      expect(writes).toBe(0);
      // Simulate a suppressed/unavailable visual, preserving the actual text element.
      await rich.evaluate(el=>{el.hidden=true;});
      await expect(answer.getByText(text,{exact:true})).toBeVisible();
      await rich.evaluate(el=>{el.hidden=false;});
      await input.fill("");
      await page.emulateMedia({reducedMotion:"reduce"});
      expect(await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      const geometry=await input.evaluate(el=>({width:document.documentElement.scrollWidth,viewport:innerWidth,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,height:innerHeight}));
      expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height+1);
      await page.screenshot({path:testInfo.outputPath("16e-acceptance-"+viewport.width+".png")});
    }
    // All existing palettes/modes share the same actual app tokens, not
    // mockups. Inspect rendered foreground/background and reflow in place.
    await page.setViewportSize({width:320,height:720});
    const themeChecks=await page.evaluate(()=>{
      const root=document.documentElement, priorTheme=root.getAttribute("data-theme"),priorMode=root.getAttribute("data-mode");
      const luminance=channels=>channels.reduce((n,v,i)=>n+[0.2126,0.7152,0.0722][i]*(v/255<=0.04045?v/255/12.92:((v/255+0.055)/1.055)**2.4),0);
      const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
      const results=[];
      try{
        for(const theme of ["fresh-pour","night-roast","market-green","berry-mocha","blue-hour","matcha","caramel-sky","cherry-cola"]){
          for(const mode of ["light","dark"]){
            root.setAttribute("data-theme",theme);root.setAttribute("data-mode",mode);
            const style=getComputedStyle(root),color=name=>style.getPropertyValue(name).trim().split(/\s+/).map(Number);
            results.push({theme,mode,body:ratio(color("--c-text"),color("--c-surface")),muted:ratio(color("--c-muted"),color("--c-surface")),send:ratio(color("--c-on-accent"),color("--c-accent")),overflow:root.scrollWidth>innerWidth});
          }
        }
      }finally{
        if(priorTheme===null)root.removeAttribute("data-theme");else root.setAttribute("data-theme",priorTheme);
        if(priorMode===null)root.removeAttribute("data-mode");else root.setAttribute("data-mode",priorMode);
      }
      return results;
    });
    expect(themeChecks).toHaveLength(16);
    for(const check of themeChecks){
      expect(check.body,JSON.stringify(check)).toBeGreaterThanOrEqual(4.5);
      expect(check.muted,JSON.stringify(check)).toBeGreaterThanOrEqual(4.5);
      expect(check.send,JSON.stringify(check)).toBeGreaterThanOrEqual(4.5);
      expect(check.overflow,JSON.stringify(check)).toBe(false);
    }
    console.info("[Task16E theme contrast]",JSON.stringify(themeChecks));
    await page.setViewportSize({width:1440,height:900});
    // Switch between exact persisted conversations. A draft stays in the
    // original mounted owner session, never moves to another thread.
    const input=page.locator("#supervisor-home-composer");
    await input.fill("My unsent answer-thread draft");
    const controls=page.getByRole("button",{name:"Library, routines and permissions"});
    const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
    await controls.click();
    const search=drawer.getByRole("searchbox",{name:"Search loaded Library"});
    await search.fill("Task16E welcome fixture");
    await expect(drawer.getByRole("button",{name:"Task16E answer fixture"})).toHaveCount(0);
    await drawer.getByRole("button",{name:"Task16E welcome fixture"}).click();
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("supervisor-welcome")).toBeVisible();
    await controls.click();await drawer.getByRole("searchbox").fill("Task16E answer fixture");
    await drawer.getByRole("button",{name:"Task16E answer fixture"}).click();
    await expect(page).toHaveURL(new RegExp("[?&]thread="+thread+"(?:&|$)"));
    await expect(input).toHaveValue("My unsent answer-thread draft");
    await expect(page.locator('[data-work-message="'+replyId+'"]')).toContainText(text);
    const attach=page.getByRole("button",{name:"Add an attachment"});
    await attach.click();
    await expect(page.getByRole("button",{name:"Choose file or photo"})).toBeFocused();
    const camera=page.getByRole("button",{name:"Take photo"});
    for(const control of [attach,camera,page.getByRole("button",{name:"Choose file or photo"})]){
      const rect=await control.boundingBox();expect(rect?.height??0).toBeGreaterThanOrEqual(48);
    }
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),camera.click()]);
    await expect(page.locator('input[type="file"]')).toHaveAttribute("capture","environment");
    await chooser.setFiles([]);
    await attach.click();
    const [files]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Choose file or photo"}).click()]);
    await expect(page.locator('input[type="file"]')).not.toHaveAttribute("capture","environment");
    await files.setFiles([]);
    await ctx.setOffline(true);
    await expect(page.getByText("Offline. Saved information may be out of date. Your draft is kept; reconnect to send.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Send",exact:true})).toBeDisabled();
    await input.press("Enter");
    await expect(input).toHaveValue("My unsent answer-thread draft");
    expect(writes).toBe(0);
    await ctx.setOffline(false);
    await expect(page.getByText("Offline. Saved information may be out of date. Your draft is kept; reconnect to send.")).toHaveCount(0);
    await expect(input).toHaveValue("My unsent answer-thread draft");
    await page.getByRole("button",{name:"New chat",exact:true}).click();
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("supervisor-welcome")).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await expect(page.locator('[data-work-message="'+replyId+'"]')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]newChat=1(?:&|$)/);
    await page.reload();
    await expect(page.getByTestId("supervisor-welcome")).toBeVisible({timeout:30000});
    await expect(page.locator('[data-work-message="'+replyId+'"]')).toHaveCount(0);
    await controls.click();await drawer.getByRole("searchbox").fill("Task16E answer fixture");
    await drawer.getByRole("button",{name:"Task16E answer fixture"}).click();
    await expect(page.locator('[data-work-message="'+replyId+'"]')).toContainText(text);
    await expect(page).toHaveURL(new RegExp("[?&]thread="+thread+"(?:&|$)"));
    await page.reload();
    await expect(page.locator('[data-work-message="'+replyId+'"]')).toContainText(text);
    // A denied owner session hides the prior private content and controls.
    await page.route("**/api/ai/threads",route=>route.fulfill({status:401,contentType:"application/json",body:'{"error":"unauthorized"}'}));
    const deniedAlert=page.getByRole("alert").filter({hasText:"Your owner session needs to be verified again"});
    await expect.poll(async()=>{await page.evaluate(()=>window.dispatchEvent(new Event("online")));return await deniedAlert.isVisible();},{timeout:30000}).toBe(true);
    await expect(input).toHaveCount(0);
    expect(writes).toBe(0);
  }finally{
    await ctx.close();await db.query("delete from public.ai_threads where id=any($1::uuid[]) and business_id=$2",[[empty,thread],owner.businessId]).catch(()=>{});await db.end();
  }
});

test("@home Task16E adaptive answer survives reload, preserves prose and opens a safe editable follow-up",async({browser})=>{
  test.setTimeout(120_000);
  const owner=seededCafe(0),foreign=seededCafe(1),thread=randomUUID(),reply=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const other=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  await db.connect();
  try{
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [thread,owner.businessId,owner.owner.userId,randomUUID(),"Disposable adaptive answer"]);
    const page=await ctx.newPage();
    await login(page,owner);await openOwnedPage(page,owner,"?thread="+thread);
    const fileRoute="/api/ai/threads/"+thread+"/attachments";
    const uploaded=await ctx.request.post(fileRoute,{headers:{Origin:"http://127.0.0.1:3000"},multipart:{
      file:{name:"example-sales.csv",mimeType:"text/csv",buffer:Buffer.from("day,sales\n2026-01-01,12\n")}
    }});
    expect(uploaded.status()).toBe(201);
    const attachment=(await uploaded.json()).attachment;
    const text="## Sales overview\nRevenue increased from the first day to the next. The chart is optional.";
    const suggestion="Compare another period";
    const blocks=[{type:"text",text},{type:"rich_presentation",version:1,layout:"stack",panels:[
      {kind:"line",title:"Daily net sales",unit:"cents",currency:owner.currency,source:"daily_rollups",from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-03",
        points:[{label:"2026-01-01",value:1200},{label:"2026-01-02",value:2400}]},
      {kind:"metric",title:"Recorded sales",unit:"cents",currency:owner.currency,source:"profitability",from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-03",points:[{label:"Sales",value:3600}]},
      {kind:"metric",title:"Recorded costs",unit:"cents",currency:owner.currency,source:"business_costs",from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-03",points:[{label:"Costs",value:1000}]}
    ],groups:[{id:"g0",layout:"stack",items:["g1","g2","g4","suggestions"]},{id:"g1",layout:"compare",items:["panel1","panel2"]},{id:"g2",layout:"stack",items:["panel0","g3"]},{id:"g3",layout:"grid",items:["agenda","scenario","table0","calculator"]},{id:"g4",layout:"details",title:"Saved evidence and export",items:["files","report"]}],report:true,files:[attachment.id],tables:[{title:"Saved query results",view:"cv_orders",from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-03",currency:owner.currency,
      coverage:"partial",scope:"Requested query",columns:[{label:"Order channel",unit:"label"},{label:"Orders",unit:"count"},{label:"Sales",unit:"cents"}],rows:[["Takeaway",0,0],["Dine in",7,null]]}],
      calculator:{title:"Order cost estimate",asOf:"2026-01-03",currency:owner.currency,inputs:[
        {id:"cost",label:"Unit cost",value:{unit:"cents",valueCents:250},editable:false},
        {id:"quantity",label:"Quantity",value:{unit:"count",quantity:10},editable:true}],
        steps:[{id:"total",op:"multiply",args:["cost","quantity"]}],original:{unit:"cents",valueCents:2500}},
      agenda:{kind:"calendar",source:"cafe_events",title:"Saved event dates",from:"2026-01-01",to:"2026-01-04",asOf:"2026-01-03",coverage:"partial",
      entries:[{label:"Market",date:"2026-01-02",endDate:"2026-01-04",start:null,end:null,status:"unverified",checkedAt:null}]},
      scenario:{title:"Modeled monthly profit",currency:owner.currency,asOf:"2026-01-03",provenance:"estimate",cases:[
        {assumption:"Small adjustment",beforeCents:348000,afterCents:338000,editor:{metric:"monthlyProfitCents",basis:{monthlyBillsCents:100000,monthlyStaffCents:200000,monthlyRevenueCents:900000,ingredientRate:0.25,feeRate:0.03,daysInMonth:30,targetMargin:0.2},delta:{kind:"bill",monthlyChangeCents:10000}}},{assumption:"Larger adjustment",beforeCents:348000,afterCents:318000}]},suggestions:[suggestion]}];
    await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,$4,'supervisor','blocks',$5::jsonb,$6::jsonb)",
      [reply,owner.businessId,thread,owner.owner.userId,JSON.stringify(blocks),JSON.stringify({status:"verified",intent:"unknown",evidence:[],agentMetadata:{endReason:"complete",unverified:[]}})]);
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
      await page.setViewportSize(viewport);
      await page.reload();
      const answer=page.locator('[data-work-message="'+reply+'"]');
      await expect(answer.getByRole("heading",{name:"Sales overview"})).toBeVisible();
      await expect(answer.getByText("Revenue increased from the first day to the next. The chart is optional.")).toBeVisible();
      const rich=answer.getByTestId("supervisor-rich-presentation");
      await expect(rich.locator('[data-supervisor-layout="stack"] [data-supervisor-layout="stack"] [data-supervisor-layout="grid"]')).toHaveCount(1);
      const chartDetail=rich.locator("figure details summary");
      await expect(chartDetail).toHaveAccessibleName(/Daily net sales/);
      await chartDetail.focus();await page.keyboard.press("Enter");
      await expect(chartDetail.locator("..")).toHaveAttribute("open","");
      await expect(rich.getByTestId("supervisor-rich-chart")).toHaveAttribute("aria-hidden","true");
      await expect(rich.getByTestId("supervisor-comparison-chart")).toHaveAttribute("aria-hidden","true");
      const ax=await answer.ariaSnapshot();
      expect(ax).toContain('heading "Sales overview"');
      expect(ax).toContain('table "Daily net sales"');
      expect(ax).toContain('table "Comparison values"');
      expect(ax).toContain('columnheader "Category"');
      expect(ax).toContain('rowheader "2026-01-02"');
      expect(ax).toContain('textbox "Quantity"');
      expect(ax).toContain('combobox "Compare calculated assumptions"');
      expect(ax).not.toContain("application");
      await expect(answer).toHaveAccessibleName("Supervisor");
      await expect(rich.getByRole("table",{name:"Daily net sales"})).toBeVisible();
      const expected=new Intl.NumberFormat("en-US",{style:"currency",currency:owner.currency}).format(24);
      await expect(rich.getByRole("table",{name:"Daily net sales"}).getByRole("cell",{name:expected,exact:true})).toBeVisible();
      const recordTable=rich.getByTestId("supervisor-record-table");
      await expect(recordTable).toContainText("Incomplete information");
      await expect(recordTable.getByRole("row").filter({hasText:"Dine in"})).toContainText("Not recorded");
      const calc=rich.getByTestId("supervisor-calculator");
      const calcField=calc.getByRole("textbox",{name:"Quantity"});
      await expect(calcField).toHaveValue("10");
      await calcField.fill("12");
      await expect(calc.getByRole("status")).toContainText(new Intl.NumberFormat("en-US",{style:"currency",currency:owner.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(30));
      await calcField.fill("invalid");
      await expect(calc.getByRole("status")).toHaveText("Cannot calculate from these inputs");
      await calc.getByRole("button",{name:"Reset assumptions"}).click();
      await expect(calcField).toHaveValue("10");
      await expect(rich.locator(".recharts-line")).toBeAttached({timeout:30000});
      await expect(rich.getByTestId("supervisor-agenda")).toContainText("Not independently verified");
      await expect(rich.getByTestId("supervisor-comparison")).toContainText("Recorded costs");
      await expect(rich.getByTestId("supervisor-comparison-chart")).toBeVisible();
      const calendar=rich.getByTestId("supervisor-calendar-grid");
      await expect(calendar.getByRole("button",{name:/Jan 4, 2026/})).toBeVisible();
      const dateChoice=calendar.getByRole("button",{name:/Jan 4, 2026/});
      await dateChoice.focus();await page.keyboard.press("Space");
      await expect(dateChoice).toHaveAttribute("aria-pressed","true");
      const detailsId=await dateChoice.getAttribute("aria-controls");
      const selectedDetails=rich.locator('[id='+JSON.stringify(detailsId)+']');
      await expect(selectedDetails).toHaveAttribute("aria-live","polite");
      await expect(selectedDetails).toContainText("Market");
      await expect(rich.getByTestId("supervisor-agenda")).toContainText("Market");
      const scenario=rich.getByTestId("supervisor-scenario");
      const scenarioEditor=scenario.getByTestId("supervisor-scenario-editor");
      await scenarioEditor.getByRole("textbox",{name:/Monthly bill change/}).fill("20");
      await expect(scenario.getByRole("status")).toHaveText(new Intl.NumberFormat("en-US",{style:"currency",currency:owner.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(3460));
      await scenarioEditor.getByRole("button",{name:"Reset assumptions"}).click();
      await expect(scenario.getByRole("status")).toHaveText(new Intl.NumberFormat("en-US",{style:"currency",currency:owner.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(3380));
      await scenario.getByRole("combobox").selectOption("1");
      await expect(scenario).toContainText(new Intl.NumberFormat("en-US",{style:"currency",currency:owner.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(3180));
      const disclosure=rich.locator('[data-supervisor-layout="details"]');
      await expect(disclosure).not.toHaveAttribute("open","");
      await disclosure.getByText("Saved evidence and export",{exact:true}).click();
      const sourceLink=rich.getByRole("link",{name:"example-sales.csv",exact:true});
      await expect(sourceLink).toHaveAttribute("href",fileRoute+"/"+attachment.id);
      const fileResponse=await ctx.request.get(fileRoute+"/"+attachment.id,{maxRedirects:0});
      expect(fileResponse.status()).toBe(302);
      const downloadEvent=page.waitForEvent("download");
      await rich.getByRole("button",{name:"Download saved answer report"}).click();
      expect((await downloadEvent).suggestedFilename()).toBe("supervisor-report.txt");
      const library=page.getByRole("dialog",{name:"Supervisor controls"});
      const opener=page.getByRole("button",{name:"Library, routines and permissions"});
      await opener.focus();await page.keyboard.press("Enter");
      const close=library.getByRole("button",{name:"Close Supervisor controls"});
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(await library.evaluate(el=>el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Tab");await expect(close).toBeFocused();
      await page.keyboard.press("Escape");await expect(opener).toBeFocused();
      await page.keyboard.press("Enter");
      await library.getByRole("button",{name:"Library",exact:true}).click();
      const librarySearch=library.getByRole("searchbox",{name:"Search loaded Library"});
      await librarySearch.fill("example-sales.csv");
      await expect(library.getByRole("link",{name:"example-sales.csv",exact:true})).toBeVisible();
      await expect(library.locator('[data-library-report="'+reply+'"]')).toHaveCount(0);
      await librarySearch.fill("Daily net sales");
      await expect(library.getByRole("link",{name:"example-sales.csv",exact:true})).toHaveCount(0);
      await library.locator('[data-library-report="'+reply+'"]').click();
      await expect(library).toHaveCount(0);
      await expect(answer).toBeFocused();
      await expect(rich.getByRole("button",{name:"Download saved answer report"})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const input=page.locator("#supervisor-home-composer");
      await input.fill("");
      await rich.getByRole("button",{name:suggestion,exact:true}).focus();
      await page.keyboard.press("Enter");
      await expect(input).toHaveValue(suggestion);
      await expect(input).toBeFocused();
      // Suggestions are editable, never a submitted message/effect/approval.
      await input.fill("My existing draft");
      await rich.getByRole("button",{name:suggestion,exact:true}).click();
      await expect(input).toHaveValue("My existing draft\n"+suggestion);
      const count=await db.query("select count(*)::int as n from public.ai_messages where thread_id=$1",[thread]);
      expect(count.rows[0].n).toBe(1);
    }
    const foreignPage=await other.newPage();await login(foreignPage,foreign);
    const denied=await other.request.get("/api/ai/threads/"+thread+"/messages");
    expect([401,403,404]).toContain(denied.status());
    const foreignFile=await other.request.get(fileRoute+"/"+attachment.id,{maxRedirects:0});
    expect([401,403,404]).toContain(foreignFile.status());
  }finally{
    await ctx.close();await other.close();
    await db.query("delete from public.ai_threads where id=$1 and business_id=$2",[thread,owner.businessId]).catch(()=>{});
    await db.end();
  }
});

// Synthetic transport check in the real authenticated UI. It deliberately does
// not claim a real model run or durable job: Task17C verifies the actual worker.
test("@home Task16E stops an acknowledged live view without invoking a cancel or effect",async({browser})=>{
  test.setTimeout(120_000);
  const owner=seededCafe(0),thread=randomUUID();
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  await db.connect();
  try{
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",[thread,owner.businessId,owner.owner.userId,randomUUID(),"Task16E live view fixture"]);
    const page=await ctx.newPage();await login(page,owner);await openOwnedPage(page,owner,"?thread="+thread);
    let realWrites=0;
    page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname.startsWith("/api/ai/"))realWrites++;});
    await page.evaluate(id=>{
      const original=window.fetch.bind(window),state={opened:false,detached:0,ack:null};
      window.__task16eStream=state;
      window.fetch=(request,init)=>{
        const url=new URL(typeof request==="string"?request:request instanceof URL?request.href:request.url,location.href);
        if(url.pathname!=="/api/ai/threads/"+id+"/agent"||init?.method!=="POST")return original(request,init);
        const stream=new ReadableStream({
          start(controller){
            state.opened=true;
            state.ack=()=>controller.enqueue(new TextEncoder().encode("event: ack\ndata: "+JSON.stringify({runId:"synthetic-run",mode:"queued"})+"\n\n"));
          },
          cancel(){state.detached++;}
        });
        return Promise.resolve(new Response(stream,{headers:{"content-type":"text/event-stream"}}));
      };
    },thread);
    const input=page.locator("#supervisor-home-composer");
    await input.fill("Synthetic live stream view check");
    await page.getByRole("button",{name:"Send",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.__task16eStream.opened)).toBe(true);
    const stop=page.getByRole("button",{name:"Stop live view",exact:true});
    await expect(stop).toHaveCount(0);
    await page.evaluate(()=>window.__task16eStream.ack());
    await expect(stop).toBeVisible();
    await stop.click();
    await expect.poll(()=>page.evaluate(()=>window.__task16eStream.detached)).toBe(1);
    await expect(stop).toHaveCount(0);
    await expect(page.getByText("Live view stopped. Saved work may continue; check Work for its status.",{exact:true})).toBeVisible();
    await expect(input).toBeEnabled();
    expect(realWrites).toBe(0);
    const records=await db.query("select count(*)::int as n from public.ai_messages where thread_id=$1",[thread]);
    expect(records.rows[0].n).toBe(0);
  }finally{
    await ctx.close();
    await db.query("delete from public.ai_threads where id=$1 and business_id=$2",[thread,owner.businessId]).catch(()=>{});
    await db.end();
  }
});
