import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {withOwner,controls} from "./task17d-owner-fixtures.mjs";

for(const width of [390,1440]) {
  test("@home 17D:D01-"+width+" saved conversation and routine identity",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread,open})=>{
      const t=await thread(),id=randomUUID(),title="Daily owner check "+id.slice(0,8);
      await query("insert into public.supervisor_routines(id,business_id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status) values($1,$2,$3,$4,$5,'daily','{}'::integer[],'08:00',$6,'active')",
        [id,cafe.businessId,cafe.owner.userId,t.id,title,cafe.timezone]);
      try {
        const {page}=await session();
        await open(page,t);
        const panel=await controls(page,"Library");
        await expect(panel.getByRole("button",{name:t.title})).toBeVisible();
        await panel.getByRole("button",{name:"Routines",exact:true}).click();
        await expect(panel.getByText(title,{exact:true})).toBeVisible();
        const rows=await query("select id,title,status,timezone,owner_user_id from public.supervisor_routines where id=$1 and business_id=$2",[id,cafe.businessId]);
        expect(rows).toEqual([{id,title,status:"active",timezone:cafe.timezone,owner_user_id:cafe.owner.userId}]);
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(page.getByRole("button",{name:"Library, routines and permissions"})).toBeFocused();
        const foreign=await session(other);
        const response=await foreign.ctx.request.get("/api/ai/supervisor/routines");
        expect(response.ok()).toBe(true);
        expect((await response.json()).routines.some(x=>x.id===id)).toBe(false);
        const ownForeign=await foreign.ctx.request.get("/api/ai/threads/"+t.id+"/work?scope=owner");
        expect([401,403,404]).toContain(ownForeign.status());
      }finally{await query("delete from public.supervisor_routines where id=$1 and business_id=$2",[id,cafe.businessId]);}
    });
  });

  test("@home 17D:D02-"+width+" proactive private notice opens exact saved conversation",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread})=>{
      const t=await thread(),id="investigation:"+randomUUID(),title="17D private issue "+id.slice(-8);
      const payload={title,intent:"priority_investigation",threadId:t.id,sourceType:"operating_task",
        sourceId:"stock-review",episodeId:randomUUID(),stepVersion:2,externalEffects:"not_attempted"};
      await query("insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,evidence,entity_type,dedupe_key) values($1,$2,$3,'leo','priority_notice','needs_owner',$4::jsonb,'high','[]'::jsonb,'priority_source',$5)",
        [cafe.businessId,id,cafe.owner.userId,JSON.stringify(payload),id]);
      try {
        const {page}=await session();
        await page.goto("/en/operations");
        const card=page.locator('article[data-task-kind="priority_notice"]').filter({hasText:title});
        await expect(card).toHaveCount(1);await expect(card).toBeVisible();
        const rows=await query("select status,payload,owner_user_id from public.operating_tasks where business_id=$1 and id=$2",[cafe.businessId,id]);
        expect(rows).toEqual([{status:"needs_owner",payload,owner_user_id:cafe.owner.userId}]);
        await card.getByRole("link",{name:/open in chat/i}).click();
        await expect(page).toHaveURL(new RegExp("thread="+t.id));
        const foreign=await session(other);
        await foreign.page.goto("/en/operations");
        await expect(foreign.page.getByText(title,{exact:true})).toHaveCount(0);
        expect(await query("select id from public.operating_tasks where business_id=$1 and id=$2",[other.businessId,id])).toEqual([]);
      }finally{await query("delete from public.operating_tasks where business_id=$1 and id=$2",[cafe.businessId,id]);}
    });
  });

  test("@home 17D:D03-"+width+" real offline return and two-tab reconciliation",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,query,session,thread,open})=>{
      const t=await thread(),run=randomUUID(),request=randomUUID();
      await query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'pending')",
        [run,cafe.businessId,cafe.owner.userId,t.id,request,"a".repeat(64)]);
      await query("insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode,status) values($1,$2,'owner_turn',1,'reconcile','pending')",[cafe.businessId,run]);
      const {ctx,page}=await session();
      await open(page,t);
      const selector='[data-work-id="run:'+run+'"]';
      const card=page.locator(selector);
      await expect(card).toHaveAttribute("data-work-status","queued");
      const second=await ctx.newPage();await open(second,t);
      await expect(second.locator(selector)).toHaveAttribute("data-work-status","queued");
      await ctx.setOffline(true);
      try {
        await expect(page.getByText(/Current status cannot be verified/)).toBeVisible();
        await query("update public.supervisor_runs set status='blocked',updated_at=now() where business_id=$1 and id=$2",[cafe.businessId,run]);
        await query("update public.supervisor_run_steps set status='blocked',error_code='lease_expired',updated_at=now() where business_id=$1 and run_id=$2",[cafe.businessId,run]);
        await expect(card).toHaveAttribute("data-work-status","queued");
      }finally{await ctx.setOffline(false);}
      // Focus is a real owner return; the hook reads but never starts a worker.
      for(const p of [second,page]){
        await p.bringToFront();
        await expect(p.locator(selector)).toHaveAttribute("data-work-status","uncertain",{timeout:30000});
        await expect(p.locator(selector)).toContainText("Outcome not yet verified");
        await expect(p.getByText("Effect verified",{exact:true})).toHaveCount(0);
      }
      expect(await query("select id,status from public.supervisor_runs where business_id=$1 and request_key=$2",[cafe.businessId,request])).toEqual([{id:run,status:"blocked"}]);
      const steps=await query("select status,error_code,attempts from public.supervisor_run_steps where business_id=$1 and run_id=$2",[cafe.businessId,run]);
      expect(steps.map(s=>({...s,attempts:Number(s.attempts)}))).toEqual([{status:"blocked",error_code:"lease_expired",attempts:0}]);
      expect(await query("select id from public.supervisor_proposals where business_id=$1 and thread_id=$2",[cafe.businessId,t.id])).toEqual([]);
    });
  });

  test("@home 17D:D04-"+width+" private file upload, independent storage and foreign denial",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread,open})=>{
      const t=await thread(),{ctx,page}=await session();
      await open(page,t);
      const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XouYAAAAASUVORK5CYII=","base64");
      const name="receipt-"+randomUUID().slice(0,8)+".png";
      const url="/api/ai/threads/"+t.id+"/attachments";
      const response=page.waitForResponse(r=>new URL(r.url()).pathname===url&&r.request().method()==="POST");
      await page.locator('input[type=file]').setInputFiles({name,mimeType:"image/png",buffer:bytes});
      const uploaded=await response;expect(uploaded.status()).toBe(201);
      const {attachment}=await uploaded.json();
      await expect(page.getByRole("button",{name:"Remove "+name})).toBeVisible();
      const rows=await query("select a.id,a.original_name,a.bytes,a.processing_state,a.owner_user_id,o.name as object_name from public.ai_attachments a join storage.objects o on o.bucket_id='ai-chat-private' and o.name=a.object_path where a.id=$1 and a.business_id=$2 and a.thread_id=$3",[attachment.id,cafe.businessId,t.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({id:attachment.id,original_name:name,bytes:bytes.length,processing_state:"stored_unanalysed",owner_user_id:cafe.owner.userId});
      expect(rows[0].object_name).toContain(attachment.id);
      const download=await ctx.request.get(url+"/"+attachment.id);
      expect(download.ok()).toBe(true);expect(await download.body()).toEqual(bytes);
      await page.getByRole("button",{name:"Remove "+name}).click();await page.reload();
      await page.getByText("Previous files",{exact:true}).click();
      await page.getByRole("button",{name:"Use "+name}).click();
      await expect(page.getByRole("button",{name:"Remove "+name})).toBeVisible();
      const foreign=await session(other);
      for(const path of [url,url+"/"+attachment.id])
        expect([401,403,404]).toContain((await foreign.ctx.request.get(path,{maxRedirects:0})).status());
      expect(await query("select id from public.ai_attachments where id=$1 and business_id=$2",[attachment.id,other.businessId])).toEqual([]);
    });
  });
}
