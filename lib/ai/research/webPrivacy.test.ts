import {describe,expect,it} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {executeResearchTool,type ResearchScope} from "./tools.server";

// A public search may be written by the model, but never contain text read from private café data.
describe("public web search privacy",()=>{
  const db={rpc:async()=>({data:{ok:true,row_count:1,rows:[{employee:"Zainab Alharbi",hours:"7.5"}]},error:null})} as unknown as SupabaseClient;
  const searched:string[]=[];
  const scope:ResearchScope={db,businessId:"b",ownerUserId:"u",privateValues:new Set(),
    webSearch:async q=>{searched.push(q);return {available:true,answer:"ok",sources:[]};}};
  it("lets the model search any public question",async()=>{
    const r=await executeResearchTool(scope,"search_web",JSON.stringify({query:"meal break rules for cafe employees in Florida"}));
    expect(r.ok).toBe(true);expect(searched).toHaveLength(1);
  });
  it("blocks a query containing text read from the café's data",async()=>{
    await executeResearchTool(scope,"run_sql",JSON.stringify({sql:"select employee, hours from timecards"}));
    const r=await executeResearchTool(scope,"search_web",JSON.stringify({query:"is zainab alharbi owed a meal break premium in California"}));
    expect(r.ok).toBe(false);expect(String(r.error)).toContain("private café data");
    expect(searched).toHaveLength(1);
    const ok=await executeResearchTool(scope,"search_web",JSON.stringify({query:"California meal break premium pay rules"}));
    expect(ok.ok).toBe(true);
  });
});
