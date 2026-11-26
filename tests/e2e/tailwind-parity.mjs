import {chromium,expect} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import {assertDisposableEnvironment,seededCafe,login,openOwnedPage,navigateLocal} from "./seeded-auth.mjs";
assertDisposableEnvironment();
const variant=process.env.VISUAL_VARIANT;
if(!["before","after"].includes(variant))throw Error("Set visual variant");
const output="test-results/tailwind-visual";
mkdirSync(output,{recursive:true});
const routes=["","staff","menu","menu/pantry","money","money?view=profit","operations","operations/suppliers","more","more/gmail","more/cafe-profile","more/plan","more/toast"];
const owner=seededCafe(0),browser=await chromium.launch({channel:"chrome",headless:true});
const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block",reducedMotion:"reduce"});
const page=await context.newPage();
const results=[];
async function capture(route,width,mode){
 // Use the app's real theme cookies BEFORE navigation so hydration cannot
 // reset a manually changed DOM attribute or capture the loading shell.
 await context.addCookies([{name:"cp_theme",value:"glass",url:"http://127.0.0.1:3000"},{name:"cp_mode",value:mode,url:"http://127.0.0.1:3000"}]);
 if(route==="login")await navigateLocal(page,"/en/login");else await openOwnedPage(page,owner,route);
 // The app declares real route readiness; background requests can stay active
 // after the screen has rendered, so networkidle is not a readiness signal.
 await expect(page.locator('main[data-perf-ready="true"]')).toBeVisible({timeout:30000});
 await expect(page.locator('main[data-perf-loading="true"]')).toHaveCount(0);
 // The desktop navigation has its own Suspense boundary, independent of main.
 // The seeded identity must be visible in that actual nav, not merely elsewhere
 // on the page (the profile form can contain the same café name).
 if(route!=="login"&&width>=768){
  await expect(page.locator("nav").getByText(owner.name,{exact:true})).toBeVisible({timeout:30000});
 }
 // Connector screens have independent client-side status requests. The seeded
 // cafe has no connected Gmail/Toast account; capture the resolved states.
 if(route==="more/gmail"){
  await expect(page.getByText("Not connected",{exact:true})).toBeVisible({timeout:30000});
 }
 if(route==="more/toast"){
  await expect(page.locator("main details ol li > span[aria-hidden=true]").filter({hasText:"○"})).toHaveCount(8,{timeout:30000});
  await expect(page.getByRole("status").filter({hasText:"Working…"})).toHaveCount(0,{timeout:30000});
 }
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 const name=(route||"home").replace(/[^a-z0-9-]+/gi,"-")+"-"+width+"-"+mode;
 const data=await page.evaluate(({variant,route})=>{
  const root=document.documentElement,body=getComputedStyle(document.body);
  const color=value=>{const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const c=canvas.getContext("2d");c.fillStyle=value;c.fillRect(0,0,1,1);return Array.from(c.getImageData(0,0,1,1).data);};
  const sample=(classes,props)=>{
   const el=document.createElement("div");el.className=classes;document.body.appendChild(el);
   const style=getComputedStyle(el),out={};
   for(const p of props){
    // v3 and v4 have different numbers of invisible ring-shadow layers.
    // Remove only fully transparent rgba layers, retain every visible shadow.
    const val=style[p];
    out[p]=p.toLowerCase().includes("color")?color(val):p==="boxShadow"?(val.split(/,\s*(?![^()]*\))/).filter(layer=>!/^rgba\(0, 0, 0, 0\)(?:\s|$)/.test(layer)).join(", ")||"none"):val;
   }
   el.remove();return out;
  };
  const rootWidth=root.clientWidth,scrollWidth=root.scrollWidth;
  // Verify actual affected controls as well as the generic utility samples.
  const actualControls=route==="more/cafe-profile"||route==="operations/suppliers"||route==="menu/pantry"?Array.from(document.querySelectorAll("main input, main select")).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0;}).map(el=>{const r=el.getBoundingClientRect(),style=getComputedStyle(el);return {type:el.getAttribute("type")??el.tagName,top:Math.round(r.top*10)/10,height:Math.round(r.height*10)/10,background:color(style.backgroundColor)};}):[];
  return {actualControls,overflow:Math.max(0,scrollWidth-rootWidth),theme:root.getAttribute("data-theme"),mode:root.getAttribute("data-mode"),
   body:{background:color(body.backgroundColor),foreground:color(body.color),font:body.fontFamily,size:body.fontSize,lineHeight:body.lineHeight},
   samples:{
    card:sample("bg-card text-ink border border-line rounded-card shadow-card",["backgroundColor","color","borderTopColor","borderTopWidth","borderTopLeftRadius","boxShadow"]),
    nav:sample("w-sidenav",["width"]),
    typography:sample("text-base font-semibold",["fontSize","lineHeight","fontWeight"]),
    wrapAnywhere:sample(variant==="before"?"[overflow-wrap:anywhere]":"wrap-anywhere",["overflowWrap"]),
    wrap:sample(variant==="before"?"break-words":"wrap-break-word",["overflowWrap"]),
    radius:sample(variant==="before"?"rounded":"rounded-sm",["borderTopLeftRadius"]),
    shadow:sample(variant==="before"?"shadow-sm":"shadow-xs",["boxShadow"]),
    outline:sample(variant==="before"?"outline outline-2":"outline-solid outline-2",["outlineWidth","outlineStyle"]),
   }};
 },{variant,route});
 if(data.mode!==mode||data.theme!=="glass")throw Error("Theme was not applied: "+name);
 await page.screenshot({path:output+"/"+name+".png",animations:"disabled"});
 results.push({name,...data});console.log("STYLE_CAPTURE "+JSON.stringify({name,overflow:data.overflow}));
}
try{
 for(const width of [390,1440]){
  await page.setViewportSize({width,height:900});
  if(width===390){
   for(const mode of ["light","dark"])await capture("login",width,mode);
   await login(page,owner);
  }
  for(const route of routes){
   for(const mode of ["light","dark"])await capture(route,width,mode);
  }
 }
}finally{await context.close();await browser.close();}
writeFileSync(output+"/styles.json",JSON.stringify(results,null,2));
