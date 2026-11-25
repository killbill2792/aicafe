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
  it("also protects nested JSON values and figures from café data",async()=>{
    const nested={rpc:async()=>({data:{ok:true,row_count:1,rows:[{payload:{employee:"Zainab Alharbi",wages:2500,
      detail:'{"manager":"Rashid Karimi"}'}}]},error:null})} as unknown as SupabaseClient;
    const seen:string[]=[];
    const s2:ResearchScope={db:nested,businessId:"b",ownerUserId:"u",privateValues:new Set(),
      webSearch:async q=>{seen.push(q);return {available:true,answer:"ok",sources:[]};}};
    await executeResearchTool(s2,"run_sql",JSON.stringify({sql:"select payload from staff"}));
    for(const query of ["overtime owed to Zainab Alharbi","is 2500 per month below the minimum wage","rules about Rashid Karimi"]){
      const r=await executeResearchTool(s2,"search_web",JSON.stringify({query}));
      expect(r.ok,query).toBe(false);
    }
    expect(seen).toEqual([]);
    // Public questions, including a year, still go through.
    const ok=await executeResearchTool(s2,"search_web",JSON.stringify({query:"2026 minimum wage Florida"}));
    expect(ok.ok).toBe(true);
  });
});
