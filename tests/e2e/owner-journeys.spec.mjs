import {test, expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {assertDisposableEnvironment, seededCafe, login, openOwnedPage}
  from "./seeded-auth.mjs";

test.beforeEach(() => {
  assertDisposableEnvironment();
});

test("@home real password sign-in isolates two cafés and ignores an unauthorized café cookie", async ({browser}) => {
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
