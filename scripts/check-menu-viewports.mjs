/** Manual authenticated visual regression: npm install --no-save playwright && npx playwright install chromium
 * MENU_E2E_BASE_URL=http://localhost:3000 MENU_E2E_ITEM_ID=<own priced item uuid>
 * MENU_E2E_STORAGE_STATE=./path/to/playwright-auth.json node scripts/check-menu-viewports.mjs
 * No auth bypass; tests run as a real signed-in café owner. Screenshots stay out of git.
 */
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
const playwright=await import("playwright").catch(()=>{throw new Error("Install Playwright locally: npm install --no-save playwright && npx playwright install chromium");});
const origin=process.env.MENU_E2E_BASE_URL??"http://localhost:3000";
const itemId=process.env.MENU_E2E_ITEM_ID;
const screenshotDir=process.env.MENU_E2E_SCREENSHOT_DIR??"menu-viewport-screenshots";
const storageState=process.env.MENU_E2E_STORAGE_STATE;
const allThemes=["fresh-pour","night-roast","market-green","berry-mocha","blue-hour","matcha","caramel-sky","cherry-cola"];
const screens=[["pantry","menu/pantry"],["new-item","menu/new"],...(itemId?[["recipe",`menu/${itemId}?tab=recipe`],["addons",`menu/${itemId}?tab=addons`]]:[])];
await mkdir(screenshotDir,{recursive:true});
const browser=await playwright.chromium.launch({headless:true});
let checked=0;
try{
 for(const locale of ["en","es","ar"])for(const width of [390,1280])for(const theme of allThemes)for(const mode of ["light","dark"]){
  const context=await browser.newContext({
   viewport:{width,height:844},deviceScaleFactor:1,
   ...(storageState?{storageState}:{})
  });
  await context.addCookies([{name:"cp_theme",value:theme,url:origin},{name:"cp_mode",value:mode,url:origin}]);
  const page=await context.newPage();
  try{
   for(const [label,path] of screens){
    const response=await page.goto(new URL(`/${locale}/${path}`,origin).href,{waitUntil:"networkidle"});
    if(!response?.ok())throw new Error(`${label} returned ${response?.status()??"no response"}`);
    if(/\/(login|onboarding)(\/|$)/.test(new URL(page.url()).pathname))throw new Error("Sign in with MENU_E2E_STORAGE_STATE to run protected menu checks");
    const metrics=await page.evaluate(()=>({
     pageWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,
     direction:document.documentElement.dir,theme:document.documentElement.dataset.theme,
     mode:document.documentElement.dataset.mode
    }));
    if(metrics.pageWidth>metrics.innerWidth+2)throw new Error(`${locale}/${theme}/${mode}/${width}/${label}: horizontal overflow ${metrics.pageWidth} > ${metrics.innerWidth}`);
    if(metrics.direction!==(locale==="ar"?"rtl":"ltr"))throw new Error(`${locale}/${label}: incorrect RTL direction ${metrics.direction}`);
    if(metrics.theme!==theme||metrics.mode!==mode)throw new Error(`${label}: theme mismatch ${JSON.stringify(metrics)}`);
    if((theme==="fresh-pour"&&mode==="light")||(theme==="night-roast"&&mode==="dark")){
     await page.screenshot({path:join(screenshotDir,`${locale}-${width}-${label}-${theme}-${mode}.png`),fullPage:true});
    }
    checked++;
   }
  }finally{await context.close();}
 }
 console.log(`Validated ${checked} authenticated menu screens at 390px / 1280px, all eight themes, light/dark, EN/ES/AR RTL.`);
}finally{await browser.close();}
