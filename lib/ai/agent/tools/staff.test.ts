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
  it("retains independently recorded on-shift staff when attendance check fails",async()=>{
    const r=await staffTools.get_staff.execute({},ctx({
      getCurrentStaff:async()=>({available:true,value:{count:1,asOf:"2026-10-22T14:00:00Z",
        people:[{name:"Casey",role:"Barista",sourceType:"connected_pos",sourceProvider:"Toast",
          start:"2026-10-22T13:00:00Z",breakStatus:"ok",isSchedulePrediction:false}]},quality:q}),
      getStaffAttendance:async()=>unavailable,
    }));
    expect(r.count).toBe(1);
    expect(r.people).toMatchObject([{name:"Casey",isSchedulePrediction:false}]);
    expect(r.onClockCount).toBeNull();
    expect(r.missing).toContain("notAvailable");
  });
  it("keeps recorded on-shift staff when attendance read throws",async()=>{
    const result=await staffTools.get_staff.execute({},ctx({
      getCurrentStaff:async()=>({available:true,value:{count:1,asOf:"2026-10-22T14:00:00Z",
        people:[{name:"Casey",role:"Barista",sourceType:"connected_pos",sourceProvider:"Toast",
          start:"2026-10-22T13:00:00Z",breakStatus:"ok",isSchedulePrediction:false}]},quality:q}),
      getStaffAttendance:async()=>{throw new Error("database offline");},
    }));
    expect(result.people).toMatchObject([{name:"Casey"}]);
    expect(result.count).toBe(1);
    expect(result.onClockCount).toBeNull();
    expect(result.missing).toContain("staffAttendanceReadFailed");
    expect(result.dataNotes).toEqual([expect.stringContaining("attendance check failed")]);
  });
  it("keeps independent attendance when current-staff reader is absent",async()=>{
    const r=await staffTools.get_staff.execute({},ctx({
      getStaffAttendance:async()=>({available:true,value:{
        timecardCount:3,onClockCount:2,attendanceTracked:true},quality:q}),
    }));
    expect(r.onClockCount).toBe(2);
    expect(r.count).toBe(2);
    expect(r.people).toBeNull();
    expect(r.missing).toContain("staffReaderUnavailable");
  });
  it("keeps independent attendance when current-staff reader throws",async()=>{
    const r=await staffTools.get_staff.execute({},ctx({
      getCurrentStaff:async()=>{throw new Error("staff offline");},
      getStaffAttendance:async()=>({available:true,value:{
        timecardCount:3,onClockCount:0,attendanceTracked:true},quality:q}),
    }));
    expect(r.count).toBe(0);
    expect(r.onClockCount).toBe(0);
    expect(r.missing).toContain("staffReadFailed");
    expect(r.dataNotes).toEqual([expect.stringContaining("readers failed")]);
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
    expect(r.source).toBe("scheduled_shifts+pos_scheduled_shifts");
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
    expect((r.shifts as {id:string}[]).map(s=>s.id)).toEqual(["thu","inactive"]);
    expect(r.missing).not.toContain("noShiftsInRequestedRange");
    expect(r.missing).not.toContain("moreShifts");
    expect(r.paidMinutes).toBeNull();
    expect(JSON.stringify(r)).toContain("inactive");
  });
  it("marks a large selected window as truncated without hiding its shifts",async()=>{
    vi.mocked(getWeekSchedule).mockResolvedValue(confirmed(
      Array.from({length:43},(_,i)=>datedShift("thu-"+i,"2026-10-22")),
    ) as never);
    const r=await staffTools.get_schedule.execute({from:"2026-10-22",to:"2026-10-22"},ctx());
    expect(r.windowHasShifts).toBe(true);
    expect((r.shifts as unknown[]).length).toBe(43);
    expect(r.missing).not.toContain("moreShifts");
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
  it("past, cross-week and 120-day ranges answer",async()=>{
    vi.mocked(getWeekSchedule).mockClear();
    vi.mocked(getWeekSchedule).mockImplementation(async(raw:unknown)=>{
      const {weekStart}=raw as {weekStart:string};
      return confirmed([datedShift("planned-"+weekStart,weekStart)]) as never;
    });
    const past=await staffTools.get_schedule.execute({from:"2026-10-19",to:"2026-10-20"},ctx());
    expect(past.missing).not.toContain("historicalScheduleNotReconstructable");
    expect(past.windowHasShifts).toBe(true);
    const cross=await staffTools.get_schedule.execute({from:"2026-10-24",to:"2026-10-26"},ctx());
    expect(cross.missing).not.toContain("scheduleRangeRequiresWeeklyRead");
    const long=await staffTools.get_schedule.execute({from:"2026-06-01",to:"2026-09-28"},ctx());
    expect(long.period).toEqual({from:"2026-06-01",to:"2026-09-28"});
    expect(long.missing).not.toContain("scheduleRangeInvalid");
    expect(getWeekSchedule).toHaveBeenCalledTimes(1+2+18);
  });
  it("deduplicates Toast overnight assignments returned by two adjacent weeks",async()=>{
    vi.mocked(getWeekSchedule).mockClear();
    const overnight={id:"toast-night",employeeId:null,employeeName:"Taylor",
      start:"2026-10-26T06:00:00Z",end:"2026-10-26T11:00:00Z",
      locationId:"location-a",source:"toast" as const,paid:false as const};
    vi.mocked(getWeekSchedule).mockImplementation(async(raw:unknown)=>{
      const {weekStart}=raw as {weekStart:string};
      return {ok:true,data:{dates:Array.from({length:7},(_,i)=>new Date(
        Date.parse(weekStart+"T12:00:00Z")+i*86400000).toISOString().slice(0,10)),
        team:[],shifts:[],posShifts:[overnight],timezone:"America/Los_Angeles",
        posScheduleError:null,adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}}} as never;
    });
    const result=await staffTools.get_schedule.execute({from:"2026-10-24",to:"2026-10-26"},ctx());
    const shifts=result.shifts as {id:string;source:string;date:string}[];
    expect(getWeekSchedule).toHaveBeenCalledTimes(2);
    expect(shifts).toEqual([expect.objectContaining({id:"toast-night",source:"toast",date:"2026-10-25"})]);
    expect(result.windowHasShifts).toBe(true);
    expect(result.missing).not.toContain("moreShifts");
  });
  it("continues to other weeks when one schedule reader throws",async()=>{
    vi.mocked(getWeekSchedule).mockImplementation(async(raw:unknown)=>{
      const {weekStart}=raw as {weekStart:string};
      if(weekStart==="2026-10-19")throw new Error("temporary failure");
      return confirmed([datedShift("mon","2026-10-26")]) as never;
    });
    const result=await staffTools.get_schedule.execute({from:"2026-10-24",to:"2026-10-27"},ctx());
    expect(result.shifts).toMatchObject([{id:"mon",date:"2026-10-26"}]);
    expect(result.missing).toContain("scheduleReadFailed:2026-10-19");
    expect(result.dataNotes).toEqual([expect.stringContaining("week of 2026-10-19")]);
  });
  it("caps ranges longer than 366 days with a note but preserves shifts",async()=>{
    vi.mocked(getWeekSchedule).mockImplementation(async(raw:unknown)=>{
      const {weekStart}=raw as {weekStart:string};
      return confirmed([datedShift("planned-"+weekStart,weekStart)]) as never;
    });
    const result=await staffTools.get_schedule.execute({from:"2024-01-01",to:"2026-01-01"},ctx());
    expect(result.missing).toContain("scheduleRangeTruncated");
    expect(result.dataNotes).toEqual([expect.stringContaining("first 366 days")]);
    expect((result.shifts as unknown[]).length).toBeGreaterThan(0);
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
  it("keeps recorded attendance when labor capability is absent",async()=>{
    const r=await staffTools.get_labor.execute({period:"today"},ctx({
      getStaffAttendance:async()=>({available:true,value:{
        timecardCount:3,onClockCount:2,attendanceTracked:true},quality:q}),
    }));
    expect(r.attendance).toMatchObject({timecardCount:3,onClockCount:2});
    expect(r.laborDays).toBeNull();
    expect(r.missing).toContain("laborReaderUnavailable");
    expect(r.dataNotes).toEqual([expect.stringContaining("readers failed")]);
  });
  it("keeps recorded labor when attendance tool is absent",async()=>{
    const result=await staffTools.get_labor.execute({period:"today"},ctx({
      getLaborMetrics:async()=>({available:true,value:[{date:"2026-10-22",
        wagesCents:1500,staffTaxCents:100,loadedStaffCostCents:1600,wageStatus:"actual"}],quality:q}),
    }));
    expect(result.laborDays).toMatchObject([{date:"2026-10-22",loadedStaffCostCents:1600}]);
    expect(result.missing).toContain("attendanceReaderUnavailable");
    expect(result.attendance).toBeNull();
    expect(result.dataNotes).toEqual([expect.stringContaining("readers failed")]);
  });
  it("keeps labor days when attendance or optional payroll reads throw",async()=>{
    const result=await staffTools.get_labor.execute({period:"today"},ctx({
      getLaborMetrics:async()=>({available:true,value:[{date:"2026-10-22",
        wagesCents:1500,staffTaxCents:100,loadedStaffCostCents:1600,wageStatus:"actual"}],quality:q}),
      getStaffAttendance:async()=>{throw new Error("attendance offline");},
      getOwnerMonthlyPayrollExtras:async()=>{throw new Error("payroll offline");},
    }));
    expect(result.laborDays).toMatchObject([{date:"2026-10-22",loadedStaffCostCents:1600}]);
    expect(result.missing).toContain("staffAttendanceReadFailed");
    expect(result.missing).toContain("payrollExtrasReadFailed");
    expect(result.missing).not.toContain("ownerMonthlyPayrollExtrasNotSet");
    expect(result.ownerMonthlyPayrollStatus).toBe("unavailable");
    expect(result.dataNotes).toEqual([expect.stringContaining("readers failed")]);
  });
  it("reports known-only missing wages as unknown rather than a complete formula",async()=>{
    const r=await staffTools.get_labor.execute({period:"today"},ctx({
      getLaborMetrics:async()=>({available:true,value:[{date:"2026-10-22",
        wagesCents:1200,staffTaxCents:144,loadedStaffCostCents:1344,wageStatus:"missing"}],
        quality:q}),
      getStaffAttendance:async()=>({available:true,
        value:{timecardCount:1,onClockCount:0,attendanceTracked:true},quality:q}),
    }));
    expect(r.missing).toContain("laborWageUnknown:2026-10-22");
    expect(r.explain).toEqual([]);
    expect(r.laborDays).toEqual([expect.objectContaining({
      wageStatus:"missing",wagesCents:1200,
    })]);
  });

  it("rejects extraneous owner-supplied scope",async()=>{
    await expect(staffTools.get_staff.execute({businessId:"other"},ctx())).rejects.toThrow();
  });
});
