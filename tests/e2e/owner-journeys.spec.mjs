import {test, expect} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment, seededCafe, login, openOwnedPage}
  from "./seeded-auth.mjs";

test.beforeEach(() => {
  assertDisposableEnvironment();
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


test("@purchasing owner approves real PO from the Supervisor screen, reopens status and proves no receiving",async({browser})=>{
  // This verifies the real owner/browser/database portion of the workflow.
  // Recorded model tests separately prove the multi-tool sequence; a sentinel
  // provider cannot be passed off as live-model or proactive parity evidence.
  test.setTimeout(120_000);
  const own=seededCafe(0),other=seededCafe(1);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const id={ingredient:randomUUID(),quote:randomUUID(),thread:randomUUID(),proposal:randomUUID()};
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
      " canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)"+
      " values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,"+
      " $6::jsonb,$7,'{}'::jsonb,$8::jsonb,'en')",
      [id.proposal,own.businessId,own.owner.userId,id.thread,randomUUID(),
        JSON.stringify(effect),hash,JSON.stringify({durationDays:1,metricScope:"supplier_purchase_order"})]);
    await db.query("insert into public.ai_messages("+
      " business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id)"+
      " values($1,$2,$3,$3,'owner','text',$4,$5)",
      [own.businessId,id.thread,own.owner.userId,
        "Compare milk quotes and prepare an order. Do not send it.",randomUUID()]);
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
    const card=page.getByRole("region",{name:"Supplier purchase-order approval"});
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
    const count=await db.query("select count(*)::int as n from public.purchase_order_lines"+
      " where business_id=$1 and purchase_order_id=$2",[own.businessId,order.rows[0].id]);
    expect(count.rows[0].n).toBe(1);
    const nowStock=await db.query("select count(*)::int as n from public.pantry_stock_purchases where business_id=$1",[own.businessId]);
    const nowExpense=await db.query("select count(*)::int as n from public.expenses where business_id=$1",[own.businessId]);
    expect(nowStock.rows[0].n).toBe(oldStock.rows[0].n);
    expect(nowExpense.rows[0].n).toBe(oldExpense.rows[0].n);
    await page.reload();
    await expect(page.getByRole("region",{name:"Supplier purchase-order approval"}))
      .toContainText("Approved for ordering — NOT sent to supplier",{timeout:30_000});
    const foreignPage=await second.newPage();
    await login(foreignPage,other);
    const denied=await second.request.get("/api/ai/threads/"+id.thread+"/proposals?ids="+id.proposal);
    expect(denied.status()).not.toBe(200);
  }finally{
    await second.close();await first.close();
    if(connected){
      const queries=[
        ["delete from public.purchase_order_events where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.purchase_order_lines where business_id=$1 and purchase_order_id in"+
          " (select id from public.purchase_orders where business_id=$1 and proposal_id=$2)",
          [own.businessId,id.proposal]],
        ["delete from public.purchase_orders where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.cafe_suppliers where business_id=$1 and display_name=$2",
          [own.businessId,supplier]],
        ["delete from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_approvals where business_id=$1 and proposal_id=$2",
          [own.businessId,id.proposal]],
        ["delete from public.supervisor_proposals where business_id=$1 and id=$2",
          [own.businessId,id.proposal]],
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
