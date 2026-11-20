import {randomUUID} from "node:crypto";
import pg from "pg";
import {expect} from "@playwright/test";
import {assertDisposableEnvironment,seededCafe,login,openOwnedPage} from "./seeded-auth.mjs";

export async function withOwner(browser,width,fn) {
  assertDisposableEnvironment();
  const cafe=seededCafe(0),other=seededCafe(1);
  const db=new pg.Client({host:"127.0.0.1",port:54322,database:"postgres",
    user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  const contexts=[],threads=[];
  const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
  async function session(who=cafe) {
    const ctx=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
    contexts.push(ctx);
    const page=await ctx.newPage();
    await login(page,who);
    await page.setViewportSize({width,height:width===390?844:900});
    expect(await page.evaluate(()=>innerWidth)).toBe(width);
    return {ctx,page};
  }
  async function thread(who=cafe) {
    const id=randomUUID(),title="17D owner "+id.slice(0,8);
    await query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [id,who.businessId,who.owner.userId,randomUUID(),title]);
    threads.push([id,who.businessId]);
    return {id,title};
  }
  async function open(page,t,who=cafe) {
    // Seeded navigation requires the café name before the mobile nav collapses.
    await page.setViewportSize({width:1440,height:900});
    await openOwnedPage(page,who,"?thread="+t.id);
    await page.setViewportSize({width,height:width===390?844:900});
    await expect(page.locator("#supervisor-home-composer")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await db.connect();
  try {await fn({cafe,other,query,session,thread,open});}
  finally {
    try {
      for(const ctx of contexts)await ctx.close();
      for(const [id,business] of threads)
        await query("delete from public.ai_threads where id=$1 and business_id=$2",[id,business]);
    } finally {await db.end();}
  }
}
export const drawer=page=>page.getByRole("dialog",{name:"Supervisor controls"});
export async function controls(page,tab) {
  await page.getByRole("button",{name:"Library, routines and permissions"}).click();
  const panel=drawer(page);
  await expect(panel).toBeVisible();
  await panel.getByRole("button",{name:tab,exact:true}).click();
  return panel;
}
