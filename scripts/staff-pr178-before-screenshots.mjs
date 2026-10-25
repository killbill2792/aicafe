import {chromium} from "playwright";
import {mkdirSync} from "node:fs";
import {join} from "node:path";

const root=process.env.STAFF_SCREENSHOT_URL??"http://127.0.0.1:3000";
const folder=process.env.STAFF_SCREENSHOT_DIR??"test-results/staff";
mkdirSync(folder,{recursive:true});
const browser=await chromium.launch({headless:true,channel:"chrome"});

async function openDialog(page,button) {
 const dialog=page.locator('dialog[aria-labelledby="staff-sheet-heading"]');
 for(let attempt=0;attempt<8&&!await dialog.isVisible();attempt++){
  await button.click();
  if(!await dialog.isVisible())await page.waitForTimeout(1200);
 }
 await dialog.waitFor({state:"visible",timeout:15000});
 return dialog;
}
async function openFixture(page,url) {
 // Restoring the merged main file changes the disposable webpack dev server.
 // Retry only the initial navigation while it recompiles; never retry writes.
 for(let attempt=0;attempt<8;attempt++) {
  const response=await page.goto(url,{waitUntil:"networkidle",timeout:30000}).catch(()=>null);
  if(response?.ok()&&await page.locator("header button[aria-label]").count())return;
  if(attempt===7)throw Error("Before-state Staff fixture did not recompile");
  await page.waitForTimeout(1500);
 }
}
try {
 for(const [width,height] of [[390,844],[1440,900]]) {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  try {
   // The immediately preceding version is merged Step 12, not pre-Step-12.
   // Verify Step 13's *shift* form is not present in the baseline.
   await openFixture(page,root+"/en/staff?fixture=1&week=2026-10-26");
   const shift=await openDialog(page,page.locator("header button[aria-label]").first());
   if(await shift.locator('input[type="time"]').count()!==0)
    throw Error("Before-state shift already has Step 13 minute-level clock inputs");
   await page.screenshot({path:join(folder,"shift-before-en-"+width+".png"),fullPage:true});

   await page.goto(root+"/en/staff?tab=team&fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
   const team=await openDialog(page,page.locator("button.border-dashed").first());
   const wage=team.locator("#staff-hourly-wage");
   if(await wage.count()!==1)
    throw Error("Merged Step 12 baseline unexpectedly lacks the typed wage editor");
   await wage.fill("invalid");
   await team.locator("#staff-wage-error").waitFor({state:"visible"});
   await wage.fill("18.73");
   await team.locator("#staff-wage-error").waitFor({state:"hidden"});
   await page.screenshot({path:join(folder,"team-person-before-en-"+width+".png"),fullPage:true});
  } finally {await page.close();}
 }
} finally {await browser.close();}
console.log("Verified merged Step 12 wage editor and captured real pre-Step-13 shift forms at 390x844 and 1440x900.");
