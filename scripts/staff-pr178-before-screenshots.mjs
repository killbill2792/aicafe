import {chromium} from "playwright";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
const root=process.env.STAFF_SCREENSHOT_URL??"http://127.0.0.1:3000";
const folder=process.env.STAFF_SCREENSHOT_DIR??"test-results/staff";
mkdirSync(folder,{recursive:true});
const browser=await chromium.launch({headless:true,channel:"chrome"});
try {
 for(const [width,height] of [[390,844],[1440,900]]) {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  try {
   const url=root+"/en/staff?tab=team&fixture=1&week=2026-10-26";
   // Replacing a source module under the disposable dev server triggers
   // recompilation. Retry only the initial page-load, never a save.
   for(let attempt=0;attempt<8;attempt++) {
    const response=await page.goto(url,{waitUntil:"networkidle",timeout:30000}).catch(()=>null);
    if(response?.ok()&&await page.locator("button.border-dashed").count())break;
    if(attempt===7)throw Error("before-state Staff fixture never loaded");
    await page.waitForTimeout(1500);
   }
   const dialog=page.locator('dialog[aria-labelledby="staff-sheet-heading"]');
   for(let attempt=0;attempt<8&&!await dialog.isVisible();attempt++){
    await page.locator("button.border-dashed").first().click();
    if(!await dialog.isVisible())await page.waitForTimeout(1200);
   }
   await dialog.waitFor({state:"visible",timeout:15000});
   if(await dialog.locator("#staff-hourly-wage").count())throw Error("Before screenshot still shows PR178 typed wage form");
   await page.screenshot({path:join(folder,"team-person-before-en-"+width+".png"),fullPage:true});
  } finally {await page.close();}
 }
} finally {await browser.close();}
console.log("Captured before-state Team person at 390×844 and 1440×900.");
