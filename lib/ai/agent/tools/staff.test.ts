import { describe,expect,it,vi } from "vitest";
import { scheduleReadTools } from "./scheduleReads";
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
        people:[{name:"Ada",role:"Barista",sourceType:"connected_pos",sourceProvider:"Toast",
          start:"2026-10-22T13:00:00Z",breakStatus:"ok",isSchedulePrediction:false}]},quality:q,
    }),
    getStaffAttendance:async()=>({available:true,value:{timecardCount:1,onClockCount:1,attendanceTracked:true},quality:q})}));
    expect(data.count).toBe(1);
    expect(data.agentId).toBe("olivia");
    expect(data.people).toHaveLength(1);
  });
  it("never invents zero clock-ins for a café with only repeating patterns",async()=>{
    const r=await staffTools.get_staff.execute({},ctx({
      getCurrentStaff:async()=>({available:true,value:{count:0,asOf:"2026-10-22T14:00:00Z",people:[]},quality:q}),
      getStaffAttendance:async()=>({available:true,value:{timecardCount:0,onClockCount:null,attendanceTracked:false},
        quality:{...q,missingInputs:["attendanceNotTracked"]}}),
    }));
    expect(r.attendanceTracked).toBe(false);
    expect(r.onClockCount).toBeNull();
    expect(r.count).toBeNull();
    expect(r.people).toEqual([]);
    expect(r.missing).toContain("attendanceNotTracked");
  });
  it("does not claim a whole week is unset or reuse weekly totals for an empty day",async()=>{
    const read=vi.spyOn(scheduleReadTools.get_week_schedule,"execute").mockResolvedValue({
      source:"scheduled_shifts",period:{from:"2026-10-19",to:"2026-10-25"},
      scheduleSet:true,missing:[],paidMinutes:480,knownWagesCents:16000,estimated:false,
      estimatedShiftCount:0,gaps:[{date:"2026-10-19",kind:"gap"}],
      shifts:[{date:"2026-10-19",employeeId:"barista",paidMinutes:480,costCents:16000}],
    } as never);
    try{
      const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
      expect(r.source).toBe("scheduled_shifts");
      expect(r.scheduleSet).toBe(true);
      expect(r.windowHasShifts).toBe(false);
      expect(r.shifts).toEqual([]);
      expect(r.paidMinutes).toBeNull();
      expect(r.knownWagesCents).toBeNull();
      expect(r.gaps).toEqual([]);
      expect(r.missing).toContain("noShiftsInRequestedRange");
      expect(r.missing).not.toContain("scheduleNotSet");
    }finally{read.mockRestore();}
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
