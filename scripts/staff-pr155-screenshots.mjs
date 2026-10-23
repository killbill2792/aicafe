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
  await page.getByRole("button",{name:"Cancel",exact:true}).first().click();
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
await browser.close();
if(errors.length)throw Error("Client runtime errors: "+errors.join("\n"));
console.log("Captured Schedule, Team, Rules at 390/1280, shift editing, 8 themes in light/dark, and es/ar at 390.");
