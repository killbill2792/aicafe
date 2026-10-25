import { describe,expect,it,vi } from "vitest";
import { getWeekSchedule } from "@/lib/actions/schedule";
import { staffTools } from "./staff";
import type { AgentToolContext } from "./index";

vi.mock("@/lib/actions/schedule",()=>({
  getWeekSchedule:vi.fn(),getTeam:vi.fn(),getShiftCost:vi.fn(),
}));
const week="2026-10-19";
const dates=Array.from({length:7},(_,i)=>
  new Date(Date.parse(week+"T12:00:00Z")+i*86400000).toISOString().slice(0,10));
const employee={id:"barista",name:"Ava",role:"Barista",wageCents:2000,minWeeklyMinutes:0,maxWeeklyMinutes:2400};
function datedShift(id:string,date:string,employeeId=employee.id){
  return {id,date,employeeId,start:"08:00",end:"12:00",paidMinutes:240,costCents:8000,estimated:false};
}
function confirmed(shifts:ReturnType<typeof datedShift>[]){
  return {ok:true as const,data:{dates,team:[employee],shifts,adjacentShifts:[],
    openHours:null,rules:{coverage_enabled:true,min_headcount:1}}};
}
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
    vi.mocked(getWeekSchedule).mockResolvedValue(confirmed([datedShift("mon",week)]) as never);
    const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
    expect(getWeekSchedule).toHaveBeenCalledWith({weekStart:week});
    expect(r.source).toBe("scheduled_shifts");
    expect(r.scheduleSet).toBe(true);
    expect(r.windowHasShifts).toBe(false);
    expect(r.shifts).toEqual([]);
    expect(r.paidMinutes).toBeNull();
    expect(r.knownWagesCents).toBeNull();
    expect(r.gaps).toEqual([]);
    expect(r.missing).toContain("noShiftsInRequestedRange");
    expect(r.missing).not.toContain("scheduleNotSet");
  });
  it("finds late-week assignments beyond the 40-item weekly response cap",async()=>{
    // Read source order is start-time, not date; all 45 Monday shifts precede
    // this Thursday shift despite being in the same café week.
    const shifts=[
      ...Array.from({length:45},(_,i)=>datedShift("mon-"+i,week)),
      datedShift("thu","2026-10-22"),
      datedShift("inactive","2026-10-22","former"),
    ];
    vi.mocked(getWeekSchedule).mockResolvedValue(confirmed(shifts) as never);
    const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
    expect(r.scheduleSet).toBe(true);
    expect(r.windowHasShifts).toBe(true);
    expect((r.shifts as {id:string}[]).map(s=>s.id)).toEqual(["thu"]);
    expect(r.missing).not.toContain("noShiftsInRequestedRange");
    expect(r.missing).not.toContain("moreShifts");
    expect(r.paidMinutes).toBeNull();
    expect(JSON.stringify(r)).not.toContain("inactive");
  });
  it("marks a large selected window as truncated without hiding its shifts",async()=>{
    vi.mocked(getWeekSchedule).mockResolvedValue(confirmed(
      Array.from({length:43},(_,i)=>datedShift("thu-"+i,"2026-10-22")),
    ) as never);
    const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
    expect(r.windowHasShifts).toBe(true);
    expect((r.shifts as unknown[]).length).toBe(40);
    expect(r.missing).toContain("moreShifts");
  });
  it("reports an entirely unset week without invented coverage",async()=>{
    vi.mocked(getWeekSchedule).mockResolvedValue(confirmed([]) as never);
    const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
    expect(r.scheduleSet).toBe(false);
    expect(r.windowHasShifts).toBe(false);
    expect(r.missing).toContain("scheduleNotSet");
    expect(r.missing).not.toContain("noShiftsInRequestedRange");
    expect(r.gaps).toEqual([]);
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
