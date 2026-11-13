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
      if(pathname.startsWith("/api/ai/threads"))
        uploads.push({method:response.request().method(),path:pathname,status:response.status()});
    });
    page.on("requestfailed", request=>{
      const pathname=new URL(request.url()).pathname;
      if(pathname.startsWith("/api/ai/threads"))
        uploads.push({method:request.method(),path:pathname,error:request.failure()?.slice(0,100)});
    });
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
