import { describe,expect,it } from "vitest";
import { staffTools } from "./staff";
import type { AgentToolContext } from "./index";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,quality:{...q,missingInputs:["notAvailable"]}};
function ctx(extra:Partial<AgentToolContext["tools"]>={}):AgentToolContext{
  return {asOf:"2026-10-22",locale:"en",timezone:"America/Los_Angeles",
    tools:{getMenuCatalog:async()=>unavailable,getProfitability:async()=>unavailable,
      getSalesTrend:async()=>unavailable,...extra}};
}
describe("Olivia bounded reads",()=>{
  it("reads real on-shift projection shape",async()=>{
    const data=await staffTools.get_staff.execute({},ctx({getCurrentStaff:async()=>({
      available:true,value:{count:1,asOf:"2026-10-22T14:00:00Z",
        people:[{name:"Ada",role:"Barista",sourceType:"owner_schedule",sourceProvider:null,
          start:"2026-10-22T13:00:00Z",breakStatus:"ok",isSchedulePrediction:true}]},quality:q,
    })}));
    expect(data.count).toBe(1);
    expect(data.agentId).toBe("olivia");
    expect(data.people).toHaveLength(1);
  });
  it("does not reconstruct historical recurring schedules",async()=>{
    const r=await staffTools.get_schedule.execute({from:"2026-10-21",to:"2026-10-22"},ctx());
    expect(r.missing).toEqual(["historicalScheduleNotReconstructable"]);
  });
  it("keeps attendance unavailable separate from labor",async()=>{
    const r=await staffTools.get_labor.execute({period:"today"},ctx({
      getLaborMetrics:async()=>({available:true,value:[{date:"2026-10-22",wagesCents:1500,
        staffTaxCents:100,loadedStaffCostCents:1600}],quality:q}),
      getStaffAttendance:async()=>unavailable,
    }));
    expect(r.missing).toContain("notAvailable");
    expect(r.attendance).toBeNull();
    expect(r.laborDays).toHaveLength(1);
  });
  it("rejects extraneous owner-supplied scope",async()=>{
    await expect(staffTools.get_staff.execute({businessId:"other"},ctx())).rejects.toThrow();
  });
});
