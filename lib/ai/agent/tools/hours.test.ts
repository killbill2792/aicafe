import { describe,expect,it } from "vitest";
import { hoursTools } from "./hours";
import type { AgentToolContext } from "./index";
const unavailable={available:false as const,value:null,quality:{level:"low" as const,missingInputs:["notAvailable"],estimatedInputs:[],staleInputs:[]}};
function ctx(hours:AgentToolContext["tools"]["getBusinessHours"]):AgentToolContext{
  return {asOf:"2026-10-22",locale:"en",tools:{
    getMenuCatalog:async()=>unavailable,getProfitability:async()=>unavailable,
    getSalesTrend:async()=>unavailable,getBusinessHours:hours}};
}
describe("location open hours",()=>{
  it("returns configured intervals verbatim",async()=>{
    const r=await hoursTools.get_business_hours.execute({},ctx(async()=>({
      available:true,value:{mon:[["07:00","16:00"]],tue:[]},
      quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]},
    })));
    expect(r.hours).toEqual({mon:[["07:00","16:00"]],tue:[]});
    expect(r.missing).toEqual([]);
  });
  it("returns honest missing hours instead of a fabricated schedule",async()=>{
    const r=await hoursTools.get_business_hours.execute({},ctx(async()=>unavailable));
    expect(r.hours).toBeNull();expect(r.missing).toEqual(["notAvailable"]);
  });
  it("rejects unknown fields",async()=>{
    await expect(hoursTools.get_business_hours.execute({businessId:"other"},ctx(undefined))).rejects.toThrow();
  });
});
