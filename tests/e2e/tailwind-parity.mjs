import {chromium} from "@playwright/test";
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
 await page.evaluate(mode=>{document.documentElement.setAttribute("data-theme","glass");document.documentElement.setAttribute("data-mode",mode);},mode);
 await page.evaluate(()=>document.fonts.ready);
 const name=(route||"home").replace(/[^a-z0-9-]+/gi,"-")+"-"+width+"-"+mode;
 const data=await page.evaluate(({variant})=>{
  const root=document.documentElement,body=getComputedStyle(document.body);
  const color=value=>{const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const c=canvas.getContext("2d");c.fillStyle=value;c.fillRect(0,0,1,1);return Array.from(c.getImageData(0,0,1,1).data);};
  const sample=(classes,props)=>{
   const el=document.createElement("div");el.className=classes;document.body.appendChild(el);
   const style=getComputedStyle(el),out={};
   for(const p of props)out[p]=p.toLowerCase().includes("color")?color(style[p]):style[p];
   el.remove();return out;
  };
  const rootWidth=root.clientWidth,scrollWidth=root.scrollWidth;
  return {overflow:Math.max(0,scrollWidth-rootWidth),theme:root.getAttribute("data-theme"),mode:root.getAttribute("data-mode"),
   body:{background:color(body.backgroundColor),foreground:color(body.color),font:body.fontFamily,size:body.fontSize,lineHeight:body.lineHeight},
   samples:{
    card:sample("bg-card text-ink border border-line rounded-card shadow-card",["backgroundColor","color","borderTopColor","borderTopWidth","borderTopLeftRadius","boxShadow"]),
    nav:sample("w-sidenav",["width"]),
    money:sample("text-money-md",["fontSize","lineHeight"]),
    wrap:sample(variant==="before"?"break-words":"wrap-break-word",["overflowWrap"]),
    radius:sample(variant==="before"?"rounded":"rounded-sm",["borderTopLeftRadius"]),
    shadow:sample(variant==="before"?"shadow-sm":"shadow-xs",["boxShadow"]),
    outline:sample(variant==="before"?"outline outline-2":"outline-solid outline-2",["outlineWidth","outlineStyle"]),
   }};
 },{variant});
 if(data.mode!==mode||data.theme!=="glass")throw Error("Theme was not applied: "+name);
 await page.screenshot({path:output+"/"+name+".png",animations:"disabled"});
 results.push({name,...data});console.log("STYLE_CAPTURE "+JSON.stringify({name,overflow:data.overflow}));
}
try{
 for(const width of [390,1440]){
  await page.setViewportSize({width,height:900});
  if(width===390){
   await navigateLocal(page,"/en/login");
   for(const mode of ["light","dark"])await capture("login",width,mode);
   await login(page,owner);
  }
  for(const route of routes){
   await openOwnedPage(page,owner,route);
   for(const mode of ["light","dark"])await capture(route,width,mode);
  }
 }
}finally{await context.close();await browser.close();}
writeFileSync(output+"/styles.json",JSON.stringify(results,null,2));
