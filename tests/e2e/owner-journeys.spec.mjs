import {test, expect} from "@playwright/test";
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
  await expect(page.getByRole("button",{name:"Connect Gmail"})).toHaveAttribute("type","submit");
  await expect(page.locator('form[action="/api/connectors/gmail/connect"]')).toHaveAttribute("method","get");
  // A provider callback refreshes the owner-facing status; no real Google OAuth call.
  connected=true;
  await page.reload();
  await expect(page.getByText("Connected and ready")).toBeVisible();
  await expect(page.getByText("owner@example.com",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Connect Gmail"})).toHaveCount(0);
  page.once("dialog",dialog=>void dialog.accept());
  await page.getByRole("button",{name:"Disconnect Gmail"}).click();
  await expect(page.getByText("Not connected",{exact:true})).toBeVisible();
  expect(disconnects).toBe(1);
  await expect(page.getByRole("button",{name:"Connect Gmail"})).toBeVisible();
});
