import {test,expect} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
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

  test("@home 17D:D05-"+width+" real decline and stale second-tab approval cannot execute",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread,open})=>{
      const t=await thread(),proposal=randomUUID(),ingredient=randomUUID(),quote=randomUUID();
      const item="17D milk "+ingredient.slice(0,8),supplier="17D farm "+quote.slice(0,8);
      const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:cafe.timezone,
        year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
      const today=parts.year+"-"+parts.month+"-"+parts.day;
      const plus=d=>{const value=new Date(today+"T12:00:00Z");value.setUTCDate(value.getUTCDate()+d);
        return value.toISOString().slice(0,10);};
      const effect={supplierName:supplier,currency:cafe.currency,neededBy:plus(3),subtotalCents:450,
        totalCents:null,shippingCents:null,taxCents:null,limitations:["owner_reported_not_supplier_verified",
          "shipping_unknown","tax_unknown","landed_total_not_comparable"],
        lines:[{quoteId:quote,ingredientId:ingredient,itemName:item,neededBaseQuantity:3785.411784,baseUnit:"ml",
          packs:1,packQuantity:1,packUnit:"gal",priceCents:450,lineSubtotalCents:450,
          quotedOn:today,deliveryOn:plus(2)}]};
      const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?
        Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
      const hash=createHash("sha256").update(JSON.stringify(canonical(effect))).digest("hex");
      try{
        await query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,$3,'ml')",[ingredient,cafe.businessId,item]);
        await query("insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,quoted_on,currency_code,valid_until,available_status,available_checked_at,delivery_on) values($1,$2,$3,$4,$5,$6,$7,450,1,'gal','supplier_quote',$8::date,$9,$10::date,'confirmed',$8::date,$11::date)",[quote,cafe.businessId,cafe.owner.userId,randomUUID(),supplier,item,ingredient,today,cafe.currency,plus(5),plus(2)]);
        await query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,$6::jsonb,$7,'{}'::jsonb,$8::jsonb,'en')",[proposal,cafe.businessId,cafe.owner.userId,t.id,randomUUID(),JSON.stringify(effect),hash,JSON.stringify({durationDays:1,metricScope:"supplier_purchase_order"})]);
        await query("insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,null,'supervisor','blocks',$4::jsonb,$5::jsonb)",[cafe.businessId,t.id,cafe.owner.userId,JSON.stringify([{type:"proposal_card",proposalId:proposal}]),JSON.stringify({status:"estimated",intent:"operating_tasks",evidence:[{source:"owner_rules",identifier:"17d-decline",asOf:today}]})]);
        const {ctx,page}=await session();await open(page,t);
        const second=await ctx.newPage();await open(second,t);
        const region=p=>p.getByRole("region",{name:"Supplier purchase-order approval"});
        for(const p of [page,second]){
          await expect(region(p)).toContainText(supplier);await expect(region(p)).toContainText(item);
          await expect(region(p)).toContainText("Shipping, tax and full landed total: unknown");
          await expect(region(p).getByRole("button",{name:"Approve purchase order"})).toBeEnabled();
        }
        const route="/api/ai/threads/"+t.id+"/proposals";
        const before=await query("select revision,status,effect_hash from public.supervisor_proposals where business_id=$1 and id=$2",[cafe.businessId,proposal]);
        expect(before).toHaveLength(1);expect(before[0]).toMatchObject({status:"draft",effect_hash:hash});
        const staleRevision=Number(before[0].revision);
        await page.bringToFront();await region(page).getByRole("button",{name:/decline|cancel/i}).click();
        await expect(region(page)).toContainText(/cancelled|declined/i);
        await expect(region(page).getByRole("button",{name:"Approve purchase order"})).toHaveCount(0);
        // Real stale authenticated request uses the exact old card revision.
        const stale=await second.request.post(route,{headers:{Origin:"http://127.0.0.1:3000"},data:{action:"approve",proposalId:proposal,revision:staleRevision}});
        expect(stale.status()).toBe(409);
        await second.reload();await expect(region(second)).toContainText(/cancelled|declined/i);
        await expect(region(second).getByRole("button",{name:"Approve purchase order"})).toHaveCount(0);
        const foreign=await session(other);
        expect([401,403,404]).toContain((await foreign.ctx.request.post(route,{headers:{Origin:"http://127.0.0.1:3000"},data:{action:"approve",proposalId:proposal,revision:staleRevision}})).status());
        const after=await query("select revision,status,effect_hash from public.supervisor_proposals where business_id=$1 and id=$2",[cafe.businessId,proposal]);
        expect(after).toHaveLength(1);expect(after[0]).toMatchObject({status:"rejected",effect_hash:hash});
        expect(Number(after[0].revision)).toBe(staleRevision+1);
        for(const table of ["purchase_orders","supervisor_effect_attempts","supervisor_approvals"])
          expect(await query("select proposal_id from public."+table+" where business_id=$1 and proposal_id=$2",[cafe.businessId,proposal])).toEqual([]);
      }finally{
        await query("delete from public.ai_threads where business_id=$1 and id=$2",[cafe.businessId,t.id]);
        await query("delete from public.supervisor_proposals where business_id=$1 and id=$2",[cafe.businessId,proposal]);
        await query("delete from public.ai_supplier_quotes where business_id=$1 and id=$2",[cafe.businessId,quote]);
        await query("delete from public.ingredients where business_id=$1 and id=$2",[cafe.businessId,ingredient]);
      }
    });
  });

  test("@home 17D:D06-"+width+" keyboard controls, focus and narrow reflow",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({session,thread,open})=>{
      const t=await thread(),{page}=await session();await open(page,t);
      const trigger=page.getByRole("button",{name:"Library, routines and permissions"});
      await trigger.focus();await page.keyboard.press("Enter");
      const panel=page.getByRole("dialog",{name:"Supervisor controls"});
      await expect(panel).toBeVisible();
      await expect.poll(()=>panel.evaluate(el=>el.contains(document.activeElement))).toBe(true);
      for(let i=0;i<12;i++){
        await page.keyboard.press("Tab");
        expect(await panel.evaluate(el=>el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);await expect(trigger).toBeFocused();
      await page.setViewportSize({width:320,height:844});
      const reopened=await controls(page,"Routines");
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect(reopened.getByRole("button",{name:"Routines",exact:true})).toBeVisible();
      await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
    });
  });
}
