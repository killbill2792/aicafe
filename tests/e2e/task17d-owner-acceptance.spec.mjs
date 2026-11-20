import {test,expect} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {withOwner,controls} from "./task17d-owner-fixtures.mjs";

const matrix=JSON.parse(readFileSync(new URL("./task17d-owner-matrix.json",import.meta.url),"utf8"));

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
        await page.setViewportSize({width:1440,height:900});
        await page.goto("/en/operations?agent=leo&status=needs_you&task="+encodeURIComponent(id));
        await expect(page.getByText(cafe.name,{exact:true}).first()).toBeVisible({timeout:30000});
        await page.setViewportSize({width,height:width===390?844:900});
        const card=page.locator('article[data-task-kind="priority_notice"]').filter({hasText:title});
        await expect(card).toHaveCount(1,{timeout:30000});await expect(card).toBeVisible();
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

  test("@home 17D:D07-"+width+" source loss, retry and resolved investigation never imply external completion",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,query,session,thread,open})=>{
      const t=await thread(),episode=randomUUID(),source=randomUUID(),run=randomUUID();
      const hash=createHash("sha256").update(source).digest("hex");
      await query("insert into public.supervisor_investigations(business_id,owner_user_id,thread_id,source_type,source_id,revision_hash,stable_key,episode_id,phase,last_error) values($1,$2,$3,'alert',$4,$5,$5,$6,'blocked','source_missing')",[cafe.businessId,cafe.owner.userId,t.id,source,hash,episode]);
      await query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'blocked')",[run,cafe.businessId,cafe.owner.userId,t.id,randomUUID(),hash]);
      await query("insert into public.supervisor_run_steps(business_id,run_id,step_key,step_index,retry_mode,status,error_code) values($1,$2,'owner_turn',1,'reconcile','blocked','lease_expired')",[cafe.businessId,run]);
      const {page}=await session();await open(page,t);
      const investigation=page.locator('[data-work-id="investigation:'+episode+'"]');
      const durable=page.locator('[data-work-id="run:'+run+'"]');
      await expect(investigation).toHaveAttribute("data-work-status","uncertain");
      await expect(investigation).toContainText("original issue is missing or reassigned");
      await expect(durable).toHaveAttribute("data-work-status","uncertain");
      await expect(durable).not.toContainText("Saved reply reference");
      await query("update public.supervisor_investigations set phase='collect',failure_count=1,last_error='source_unavailable',updated_at=now() where business_id=$1 and episode_id=$2",[cafe.businessId,episode]);
      await page.reload();await expect(investigation).toHaveAttribute("data-work-status","retrying");
      // This is a presentation fixture for a source transition, not proof the
      // worker really resolved it. 17C owns the source-trigger/closure evidence.
      await query("update public.supervisor_investigations set phase='resolved',last_error=null,failure_count=0,updated_at=now() where business_id=$1 and episode_id=$2",[cafe.businessId,episode]);
      await page.reload();await expect(investigation).toHaveAttribute("data-work-status","source_resolved");
      await expect(investigation).toContainText("does not prove an external effect");
      await expect(page.getByText("Effect verified",{exact:true})).toHaveCount(0);
      const rows=await query("select episode_id,source_id,phase from public.supervisor_investigations where business_id=$1 and thread_id=$2",[cafe.businessId,t.id]);
      expect(rows).toEqual([{episode_id:episode,source_id:source,phase:"resolved"}]);
      expect(await query("select id,final_report_ref from public.supervisor_runs where business_id=$1 and id=$2",[cafe.businessId,run])).toEqual([{id:run,final_report_ref:null}]);
    });
  });

  test("@home 17D:D08-"+width+" sign out removes owner session and private thread access",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread,open})=>{
      const t=await thread(),id=randomUUID(),text="Private owner question "+id;
      await query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$4,'owner','text',$5,$6)",[id,cafe.businessId,t.id,cafe.owner.userId,text,randomUUID()]);
      const {page,ctx}=await session();
      await open(page,t);
      await expect(page.locator('[data-work-message="'+id+'"]')).toContainText(text);
      await page.goto("/en/more");
      await page.getByRole("button",{name:"Sign Out",exact:true}).click();
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      const endpoint="/api/ai/threads/"+t.id+"/messages";
      expect([401,403,404]).toContain((await ctx.request.get(endpoint)).status());
      await page.goto("/en?thread="+t.id);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      const foreign=await session(other);
      expect([401,403,404]).toContain((await foreign.ctx.request.get(endpoint)).status());
      await open(foreign.page,t,other);
      await expect(foreign.page.getByText(text,{exact:true})).toHaveCount(0);
      const restored=await session();await open(restored.page,t);
      await expect(restored.page.locator('[data-work-message="'+id+'"]')).toContainText(text);
      expect(await query("select id,text_content from public.ai_messages where business_id=$1 and thread_id=$2 and id=$3",[cafe.businessId,t.id,id])).toEqual([{id,text_content:text}]);
    });
  });

  test("@money 17D:D09-"+width+" monthly bills match independent recurring-source arithmetic and cafe currency",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session})=>{
      // Independent arithmetic from saved source rows, not the Money viewmodel.
      for(const who of [cafe,other]){
        const costs=await query("select id,amount_cents,frequency,is_estimate,category_code from public.recurring_costs where business_id=$1 and active_to is null",[who.businessId]);
        expect(costs.length).toBeGreaterThan(1);
        const equivalents={monthly:n=>n,weekly:n=>Math.round(n*52/12),quarterly:n=>Math.round(n/3),yearly:n=>Math.round(n/12)};
        const total=costs.reduce((n,row)=>n+equivalents[row.frequency](Number(row.amount_cents)),0);
        const money=n=>new Intl.NumberFormat("en",{style:"currency",currency:who.currency}).format(n/100);
        const {page}=await session(who);await page.goto("/en/more/bills");
        const totalSection=page.locator("section").filter({hasText:"Total monthly bills"});
        await expect(totalSection).toHaveCount(1);
        // Compare the actual active café currency, not a browser or default currency.
        await expect.soft(totalSection).toContainText(money(total));
        const estimated=costs.find(row=>row.category_code==="utilities_power"&&row.is_estimate);
        expect(estimated).toBeTruthy();
        const estimate=page.getByRole("button",{name:/Electricity/i}).filter({hasText:"Estimate"});
        await expect(estimate).toHaveCount(1);
        await expect.soft(estimate).toContainText(money(Number(estimated.amount_cents)));
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      }
    });
  });

  test("@gmail 17D:D10-"+width+" file-specific revocation persists, stale retry denied, failure never implies permission",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,other,query,session,thread})=>{
      const t=await thread(),file=randomUUID(),name="17D-private-"+file.slice(0,8)+".csv";
      const route="/api/supervisor/access";
      await query("insert into public.ai_attachments(id,business_id,owner_user_id,thread_id,object_path,original_name,media_type,bytes) values($1,$2,$3,$4,$5,$6,'text/csv',12)",[file,cafe.businessId,cafe.owner.userId,t.id,[cafe.businessId,cafe.owner.userId,t.id,file,name].join("/"),name]);
      const read=()=>query("select allowed,revision from public.supervisor_external_access where business_id=$1 and owner_user_id=$2 and kind='attachment' and resource_key=$3",[cafe.businessId,cafe.owner.userId,file]);
      try{
        const {ctx,page}=await session();await page.goto("/en/more/supervisor-access");
        const group=page.getByRole("group",{name,exact:true});
        await expect(group).toBeVisible();expect(await read()).toEqual([]);
        await expect(page.getByText("Not connected. Supervisor cannot log in to websites, operate a computer or submit forms through this setting.",{exact:true})).toBeVisible();
        const second=await ctx.newPage();await second.setViewportSize({width,height:width===390?844:900});await second.goto("/en/more/supervisor-access");
        await expect(second.getByRole("group",{name,exact:true}).getByRole("button",{name:"Revoke future access"})).toBeEnabled();
        // Network fault is deliberate: no server mutation must take place.
        await page.route("**"+route,request=>request.request().method()==="POST"?request.fulfill({status:503,body:"{}"}):request.continue());
        page.once("dialog",dialog=>void dialog.accept());
        await group.getByRole("button",{name:"Revoke future access"}).click();
        await expect(page.getByRole("alert").filter({hasText:"Could not verify the change"})).toBeVisible();
        expect(await read()).toEqual([]);
        await page.unroute("**"+route);
        page.once("dialog",dialog=>void dialog.accept());
        await group.getByRole("button",{name:"Revoke future access"}).click();
        await expect(group).toContainText("Future Supervisor access revoked");
        const saved=await read();expect(saved).toHaveLength(1);
        expect(saved[0].allowed).toBe(false);expect(Number(saved[0].revision)).toBe(1);
        const stale=await second.request.post(route,{headers:{Origin:"http://127.0.0.1:3000"},data:{kind:"attachment",attachmentId:file,enabled:false,revision:0}});
        expect(stale.status()).toBe(409);
        await second.reload();await expect(second.getByRole("group",{name,exact:true})).toContainText("Future Supervisor access revoked");
        await expect(group.getByRole("button",{name:"Revoke future access"})).toHaveCount(0);
        const foreign=await session(other);await foreign.page.goto("/en/more/supervisor-access");
        await expect(foreign.page.getByRole("heading",{name:"Website and computer control"})).toBeVisible();
        await expect(foreign.page.getByRole("group",{name,exact:true})).toHaveCount(0);
        const denied=await foreign.ctx.request.post(route,{headers:{Origin:"http://127.0.0.1:3000"},data:{kind:"attachment",attachmentId:file,enabled:false,revision:0}});
        expect(denied.ok()).toBe(false);
        expect(await read()).toEqual(saved);
        expect(await query("select id from public.ai_attachments where business_id=$1 and id=$2",[cafe.businessId,file])).toEqual([{id:file}]);
        const audit=await query("select allowed from public.supervisor_external_access_audit where business_id=$1 and owner_user_id=$2 and kind='attachment' and resource_key=$3",[cafe.businessId,cafe.owner.userId,file]);
        expect(audit).toEqual([{allowed:false}]);
      }finally{
        await query("delete from public.supervisor_external_access_audit where business_id=$1 and owner_user_id=$2 and kind='attachment' and resource_key=$3",[cafe.businessId,cafe.owner.userId,file]);
        await query("delete from public.supervisor_external_access where business_id=$1 and owner_user_id=$2 and kind='attachment' and resource_key=$3",[cafe.businessId,cafe.owner.userId,file]);
      }
    });
  });

  test("@home 17D:D11-"+width+" standing permission read failure, retry and no grant without MFA",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,query,session,thread,open})=>{
      const t=await thread(),{page}=await session();await open(page,t);
      const before=await query("select id,revision,capability_id,revoked_at from public.supervisor_mandates where business_id=$1 and owner_user_id=$2 order by id,revision",[cafe.businessId,cafe.owner.userId]);
      await page.route("**/api/ai/threads/*/mandates**",route=>route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'}));
      const panel=await controls(page,"Permissions");
      await expect(panel.getByText("Permissions could not be verified. Do not assume any authorization is active.",{exact:true})).toBeVisible();
      await page.unroute("**/api/ai/threads/*/mandates**");
      await panel.getByRole("button",{name:"Refresh status",exact:true}).click();
      await expect(panel.getByText("No standing permissions have been granted.",{exact:true})).toBeVisible();
      await expect(panel.getByText(/No permission here authorizes payments/)).toBeVisible();
      expect(await query("select id,revision,capability_id,revoked_at from public.supervisor_mandates where business_id=$1 and owner_user_id=$2 order by id,revision",[cafe.businessId,cafe.owner.userId])).toEqual(before);
      expect(before).toEqual([]);
      await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
    });
  });

  test("@home 17D:D12-"+width+" owner opens saved work from another conversation and returns to library",async({browser})=>{
    test.setTimeout(120_000);
    await withOwner(browser,width,async({cafe,query,session,thread,open})=>{
      const first=await thread(),second=await thread(),run=randomUUID();
      await query("insert into public.supervisor_runs(id,business_id,owner_user_id,thread_id,request_key,plan_hash,status) values($1,$2,$3,$4,$5,$6,'pending')",[run,cafe.businessId,cafe.owner.userId,second.id,randomUUID(),createHash("sha256").update(run).digest("hex")]);
      const {page}=await session();await open(page,first);
      const panel=await controls(page,"Library");
      await panel.getByRole("button",{name:second.title,exact:true}).click();
      await expect(panel).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp("thread="+second.id));
      await expect(page.locator('[data-work-id="run:'+run+'"]')).toHaveAttribute("data-work-status","queued");
      await page.reload();
      await expect(page.locator('[data-work-id="run:'+run+'"]')).toHaveAttribute("data-work-status","queued");
      const library=await controls(page,"Library");
      await library.getByRole("button",{name:first.title,exact:true}).click();
      await expect(page).toHaveURL(new RegExp("thread="+first.id));
      const rows=await query("select id,thread_id,status from public.supervisor_runs where business_id=$1 and id=$2",[cafe.businessId,run]);
      expect(rows).toEqual([{id:run,thread_id:second.id,status:"pending"}]);
    });
  });

  for(const group of matrix.routeGroups){
    test("@"+group.tag+" 17D:"+group.id+"-"+width+" "+group.name,async({browser})=>{
      test.setTimeout(240_000);
      await withOwner(browser,width,async({cafe,session})=>{
        const {page}=await session(cafe);
        for(const [path,marker,redirect,search,hash] of group.routes){
          await test.step(path,async()=>{
            const response=await page.goto("/en"+path,{waitUntil:"domcontentloaded"});
            expect(response?.status()).toBe(200);
            await expect.poll(()=>new URL(page.url()).pathname,{timeout:30000}).toBe("/en"+(redirect??path));
            const final=new URL(page.url());
            if(search)expect(final.searchParams.toString()).toContain(search);
            if(hash)expect(final.hash).toBe(hash);
            await expect(page.getByText(marker,{exact:true}).filter({visible:true}).first()).toBeVisible({timeout:30000});
            expect(await page.evaluate(()=>innerWidth)).toBe(width);
            expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          });
        }
      });
    });
  }

  test("@menu 17D:D17-"+width+" product detail uses correct source price and denies a foreign item ID",async({browser})=>{
    test.setTimeout(180_000);
    await withOwner(browser,width,async({cafe,other,query,session})=>{
      const own=await session(cafe),foreign=await session(other);
      for(const [who,active,denied] of [[cafe,own,foreign],[other,foreign,own]]){
        const items=await query("select id,name,coalesce(base_name,name) as base_name,price_cents from public.menu_items where business_id=$1 and is_active and price_cents>0 and size_label is null order by id limit 1",[who.businessId]);
        expect(items).toHaveLength(1);
        const item=items[0],url="/en/menu/"+item.id;
        const result=await active.page.goto(url);
        expect(result?.status()).toBe(200);
        await expect(active.page.getByRole("heading",{name:item.base_name,level:1,exact:true})).toBeVisible();
        const money=new Intl.NumberFormat("en",{style:"currency",currency:who.currency}).format(Number(item.price_cents)/100);
        // Independent currency and cents are checked even if legacy formatting
        // assumes USD. The test never changes prices or calls a payment tool.
        await expect.soft(active.page.getByRole("button",{name:money,exact:true}).first()).toBeVisible();
        const deniedResult=await denied.page.goto(url);
        expect([200,404]).toContain(deniedResult?.status());
        await expect(denied.page.getByText("This page could not be found.",{exact:true})).toBeVisible();
        await expect(denied.page.getByRole("heading",{name:item.base_name,exact:true})).toHaveCount(0);
        expect(await query("select id,price_cents from public.menu_items where business_id=$1 and id=$2",[who.businessId,item.id])).toEqual([{id:item.id,price_cents:item.price_cents}]);
      }
    });
  });

  test("@home 17D:D18-"+width+" exact alert source, owner disposition and cross-cafe isolation",async({browser})=>{
    test.setTimeout(180_000);
    await withOwner(browser,width,async({cafe,other,query,session})=>{
      const id=randomUUID(),marker="Private unmapped sale "+id.slice(0,8),payload={itemNames:[marker]};
      const cents=7123;
      // Owner's actual UI must show a genuine EUR source amount, not USD.
      await query("insert into public.alerts(id,business_id,kind,impact_cents,payload,status) values($1,$2,'unmatched_sales_items',$3,$4::jsonb,'new')",[id,other.businessId,cents,JSON.stringify(payload)]);
      try{
        const owner=await session(other),foreign=await session(cafe),url="/en/more/alerts/"+id;
        const denied=await foreign.page.goto(url);
        expect([200,404]).toContain(denied?.status());
        await expect(foreign.page.getByText("This page could not be found.",{exact:true})).toBeVisible();
        await expect(foreign.page.getByText(marker,{exact:false})).toHaveCount(0);
        expect(await query("select status from public.alerts where id=$1 and business_id=$2",[id,other.businessId])).toEqual([{status:"new"}]);
        const response=await owner.page.goto(url);
        expect(response?.status()).toBe(200);
        await expect(owner.page.getByText(marker,{exact:false})).toBeVisible();
        await expect.soft(owner.page.getByText(new Intl.NumberFormat("en",{style:"currency",currency:other.currency}).format(cents/100),{exact:true})).toBeVisible();
        expect(await query("select status from public.alerts where id=$1 and business_id=$2",[id,other.businessId])).toEqual([{status:"seen"}]);
        await owner.page.getByRole("button",{name:"Done",exact:true}).click();
        await expect(owner.page).toHaveURL(/\/more\/alerts$/);
        const saved=await query("select status,payload,impact_cents from public.alerts where id=$1 and business_id=$2",[id,other.businessId]);
        expect(saved).toHaveLength(1);
        expect(saved[0].status).toBe("resolved");
        expect(saved[0].payload).toEqual({...payload,dispositionSource:"owner"});
        expect(Number(saved[0].impact_cents)).toBe(cents);
        // Owner marked the alert reviewed; do not infer source data was repaired.
        await expect(owner.page.getByText(marker,{exact:false})).toHaveCount(0);
      }finally{await query("delete from public.alerts where business_id=$1 and id=$2",[other.businessId,id]);}
    });
  });

  test("@gmail 17D:D19-"+width+" saved import outcome and private upload ID denial",async({browser})=>{
    test.setTimeout(180_000);
    await withOwner(browser,width,async({cafe,other,query,session})=>{
      const id=randomUUID(),marker="Imported source "+id.slice(0,8);
      const summary={rowsInFile:3,imported:2,newIngredients:[marker]};
      // Persisted source summary fixture only; actual importer execution is
      // a different scenario and must be reconciled with 17B.
      await query("insert into public.uploads(id,business_id,kind,status,summary) values($1,$2,'ingredients_csv','done',$3::jsonb)",[id,cafe.businessId,JSON.stringify(summary)]);
      try{
        const owner=await session(),foreign=await session(other),url="/en/more/uploads/"+id;
        await owner.page.goto("/en/more/uploads");
        const link=owner.page.locator('a[href="'+url+'"]');
        await expect(link).toHaveCount(1);await link.click();
        await expect(owner.page).toHaveURL(new RegExp("/more/uploads/"+id+"$"));
        await expect(owner.page.getByRole("heading",{name:"Ingredient costs",exact:true})).toBeVisible();
        await expect(owner.page.getByText("2 of 3 rows",{exact:true})).toBeVisible();
        await expect(owner.page.getByText(marker,{exact:true})).toBeVisible();
        const denied=await foreign.page.goto(url);
        expect([200,404]).toContain(denied?.status());
        await expect(foreign.page.getByText("This page could not be found.",{exact:true})).toBeVisible();
        await expect(foreign.page.getByText(marker,{exact:true})).toHaveCount(0);
        await owner.page.reload();
        await expect(owner.page.getByText(marker,{exact:true})).toBeVisible();
        expect(await query("select id,status,summary from public.uploads where business_id=$1 and id=$2",[cafe.businessId,id])).toEqual([{id,status:"done",summary}]);
      }finally{await query("delete from public.uploads where business_id=$1 and id=$2",[cafe.businessId,id]);}
    });
  });
}

for(const width of [390,768,1024,1440]){
  test("@home 17D:D20-"+width+" tablet and RTL owner transcript preserves text, source details and local controls",async({browser})=>{
    test.setTimeout(180_000);
    await withOwner(browser,width,async({cafe,query,session,thread,open})=>{
      const t=await thread(),reply=randomUUID();
      const text="Sales are recorded. The comparison is incomplete; no profit conclusion is justified.";
      const blocks=[{type:"text",text},{type:"rich_presentation",version:1,layout:"stack",panels:[
        {kind:"line",title:"Recorded sales",unit:"cents",currency:cafe.currency,source:"daily_rollups",from:"2026-01-01",to:"2026-01-02",asOf:"2026-01-03",points:[{label:"2026-01-01",value:1200},{label:"2026-01-02",value:2400}]}
      ],suggestions:["Check missing costs"]}];
      await query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,$4,'supervisor','blocks',$5::jsonb,$6::jsonb)",[reply,cafe.businessId,t.id,cafe.owner.userId,JSON.stringify(blocks),JSON.stringify({status:"verified",intent:"unknown",evidence:[]})]);
      const {page}=await session();
      await open(page,t);
      const answer=page.locator('[data-work-message="'+reply+'"]'),rich=answer.getByTestId("supervisor-rich-presentation"),composer=page.locator("#supervisor-home-composer");
      let sent=0;page.on("request",r=>{if(r.method()==="POST"&&/\/api\/ai\/threads\/[^/]+\/(agent|messages)$/.test(new URL(r.url()).pathname))sent++;});
      await expect(answer.getByText(text,{exact:true})).toBeVisible();
      await expect(rich).toBeVisible();
      await rich.locator("figure details summary").focus();await page.keyboard.press("Enter");
      await expect(rich.getByRole("table",{name:"Recorded sales"})).toBeVisible();
      await expect(rich.getByRole("cell",{name:new Intl.NumberFormat("en-US",{style:"currency",currency:cafe.currency}).format(24),exact:true})).toBeVisible();
      await rich.evaluate(el=>{el.hidden=true;});
      await expect(answer.getByText(text,{exact:true})).toBeVisible();
      await rich.evaluate(el=>{el.hidden=false;});
      await rich.getByRole("button",{name:"Check missing costs",exact:true}).click();
      await expect(composer).toHaveValue("Check missing costs");
      expect(sent).toBe(0);
      await composer.fill("");
      // Reducing CSS width is a reflow simulation, NOT native browser zoom.
      await page.setViewportSize({width:Math.max(320,Math.floor(width/2)),height:844});
      await expect(composer).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.setViewportSize({width,height:width===768?1024:900});
      for(const [locale,dir] of [["ar","rtl"],["es","ltr"]]){
        await page.goto("/"+locale+"?thread="+t.id);
        await expect(page.locator("html")).toHaveAttribute("dir",dir);
        await expect(page.locator("html")).toHaveAttribute("lang",locale);
        await expect(answer.getByText(text,{exact:true})).toBeVisible();
        await expect(composer).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.reload();await expect(answer.getByText(text,{exact:true})).toBeVisible();
      }
      expect(await query("select id,thread_id,structured_content from public.ai_messages where business_id=$1 and id=$2",[cafe.businessId,reply])).toEqual([{id:reply,thread_id:t.id,structured_content:blocks}]);
      expect(sent).toBe(0);
    });
  });
}
