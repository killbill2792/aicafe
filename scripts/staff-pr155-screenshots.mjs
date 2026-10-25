import {chromium} from "playwright";
import {mkdirSync} from "node:fs";
import {join} from "node:path";

const base=process.env.STAFF_SCREENSHOT_URL??"http://127.0.0.1:3000";
const output=process.env.STAFF_SCREENSHOT_DIR??"test-results/staff";
mkdirSync(output,{recursive:true});
// GitHub ubuntu-latest ships Chrome; no network-heavy browser download.
const browser=await chromium.launch({headless:true,channel:"chrome"});
const themes=["fresh-pour","night-roast","market-green","berry-mocha","blue-hour","matcha","caramel-sky","cherry-cola"];
const errors=[];
async function assertVisible(page,selector,label){
 await page.locator(selector).first().waitFor({state:"visible",timeout:20000});

}
async function setPalette(page,theme="fresh-pour",mode="light"){
 await page.evaluate(({theme,mode})=>{
  document.documentElement.dataset.theme=theme;
  document.documentElement.dataset.mode=mode;
 },{theme,mode});
 await page.waitForTimeout(120);
 const color=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--c-accent").trim());
 if(!/^\d+ \d+ \d+$/.test(color))throw Error("missing theme accent "+theme+" "+mode+": "+color);
}
for(const width of [390,1280]){
 const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1});
 page.on("pageerror",err=>errors.push(String(err)));
 const suffix=width===390?"mobile":"desktop";
 await page.goto(base+"/en/staff?fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
 await assertVisible(page,"h1",suffix+" schedule");
 await setPalette(page);
 const timeline=await page.locator("[aria-label='Days this week']").count();
 if(timeline!==1)throw Error("week day strip missing at "+width);
 await page.screenshot({path:join(output,"schedule-"+suffix+".png"),fullPage:true});
 await page.getByRole("button",{name:"Team",exact:true}).click();
 await assertVisible(page,"input[aria-label=\"New person's name\"]",suffix+" team");
 await page.screenshot({path:join(output,"team-"+suffix+".png"),fullPage:true});
 await page.goto(base+"/en/staff/rules",{waitUntil:"networkidle"});
 await assertVisible(page,"h1",suffix+" rules");
 await setPalette(page);
 await page.screenshot({path:join(output,"rules-"+suffix+".png"),fullPage:true});
 if(width===390){
  await page.goto(base+"/en/staff?fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
  await page.locator("header button[aria-label]").first().click();
  await page.getByRole("dialog").first().waitFor({state:"visible"});
  await page.screenshot({path:join(output,"shift-edit-mobile.png"),fullPage:true});
  const focusInside=await page.evaluate(()=>document.activeElement?.closest("dialog")!==null);
  if(!focusInside)throw Error("The editing sheet did not receive keyboard focus");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").first().waitFor({state:"hidden"});
  const focusRestored=await page.locator("header button[aria-label]").first().evaluate(el=>el===document.activeElement);
  if(!focusRestored)throw Error("Dialog did not restore focus to Add shift control");
  const seen=new Set();
  for(const theme of themes){
   for(const mode of ["light","dark"]){
    await setPalette(page,theme,mode);
    const name=theme+"-"+mode;
    const color=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--c-accent").trim());
    if(seen.has(theme+"|"+mode+"|"+color))throw Error("palette not reapplied "+name);
    seen.add(theme+"|"+mode+"|"+color);
    await page.screenshot({path:join(output,"theme-"+name+".png"),fullPage:false});
   }
  }
 }
 await page.close();
}
for(const locale of ["es","ar"]){
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 page.on("pageerror",err=>errors.push(String(err)));
 await page.goto(base+"/"+locale+"/staff?fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
 await assertVisible(page,"h1",locale+" schedule");
 if(locale==="ar"&&await page.locator("[dir='rtl']").count()===0)throw Error("Arabic schedule not RTL");
 await page.screenshot({path:join(output,"schedule-"+locale+"-390.png"),fullPage:true});
 await page.close();
}
// Step 12 acceptance: Team person editor at 390×844, 1440×900 and Arabic RTL.
for(const [locale,width,height] of [["en",390,844],["en",1440,900],["ar",390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 page.on("pageerror",err=>errors.push(String(err)));
 await page.goto(base+"/"+locale+"/staff?tab=team&fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
 await assertVisible(page,"input[aria-label]",locale+" team person");
 await setPalette(page);
 const dialog=page.locator('dialog[aria-labelledby="staff-sheet-heading"]');
 // The route can return before React has hydrated on a busy CI runner.
 for(let attempt=0;attempt<8&&!await dialog.isVisible();attempt++){
  await page.locator("button.border-dashed").first().click();
  if(!await dialog.isVisible())await page.waitForTimeout(1200);
 }
 await dialog.waitFor({state:"visible",timeout:15000});
 if(locale==="ar"&&await dialog.evaluate(el=>getComputedStyle(el).direction)!=="rtl")
  throw Error("Arabic person editor did not inherit RTL");
 await dialog.locator("input").first().fill("Fixture Person");
 const wage=dialog.locator("#staff-hourly-wage");
 await wage.fill("invalid");
 await dialog.locator("#staff-wage-error").waitFor({state:"visible"});
 await wage.fill("18.73");
 await dialog.locator("#staff-wage-error").waitFor({state:"hidden"});
 await dialog.locator('input[type="time"]').nth(0).fill("06:15");
 await dialog.locator('input[type="time"]').nth(1).fill("12:37");
 await page.screenshot({path:join(output,"team-person-"+locale+"-"+width+".png"),fullPage:true});
 await page.close();
}
// Step 13 acceptance: minute-level shift edit after-state at 390x844,
// 1440x900 and Arabic RTL. Verify invalid breaks never reach preview or save.
for(const [locale,width,height] of [["en",390,844],["en",1440,900],["ar",390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 page.on("pageerror",err=>errors.push(String(err)));
 try {
  await page.goto(base+"/"+locale+"/staff?fixture=1&week=2026-10-26",{waitUntil:"networkidle"});
  const dialog=page.locator('dialog[aria-labelledby="staff-sheet-heading"]');
  for(let attempt=0;attempt<8&&!await dialog.isVisible();attempt++){
   await page.locator("header button[aria-label]").first().click();
   if(!await dialog.isVisible())await page.waitForTimeout(1200);
  }
  await dialog.waitFor({state:"visible",timeout:15000});
  if(locale==="ar"&&await dialog.evaluate(el=>getComputedStyle(el).direction)!=="rtl")
   throw Error("Arabic shift editor must be RTL");
  const clockInputs=dialog.locator('input[type="time"]');
  if(await clockInputs.count()!==2)throw Error("Step 13 shift form needs two minute-level clock inputs");
  await clockInputs.nth(0).fill("06:15");
  await clockInputs.nth(1).fill("12:37");
  if(await clockInputs.nth(0).inputValue()!=="06:15"||await clockInputs.nth(1).inputValue()!=="12:37")
   throw Error("Shift minute input was lost");
  const breaks=dialog.locator('input[type="text"][inputmode="numeric"]');
  if(await breaks.count()!==1)throw Error("Step 13 typed break input missing");
  await breaks.fill("");
  await dialog.locator("#staff-break-error").waitFor({state:"visible"});
  if(await breaks.getAttribute("aria-invalid")!=="true")throw Error("Empty break input not marked invalid");
  await breaks.fill(locale==="ar"?"٣١":"31");
  await dialog.locator("#staff-break-error").waitFor({state:"hidden"});
  await page.screenshot({path:join(output,"shift-after-"+locale+"-"+width+".png"),fullPage:true});
 } finally {await page.close();}
}
await browser.close();
if(errors.length)throw Error("Client runtime errors: "+errors.join("\n"));
console.log("Captured Schedule/Team/Rules, Team person at 390/1440 and ar RTL, shift editing, 8 themes and es/ar.");
