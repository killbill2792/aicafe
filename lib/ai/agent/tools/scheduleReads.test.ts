import {describe,it,expect,vi} from "vitest";
vi.mock("@/lib/actions/schedule",()=>({
 getTeam:vi.fn(),getShiftCost:vi.fn(),getWeekSchedule:vi.fn(),getCoverageGaps:vi.fn()
}));
vi.mock("@/lib/actions/teamRules",()=>({getTeamRules:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({
 staffReadScope:vi.fn(),mondayOfLocalDate:vi.fn(()=> "2026-10-19")
}));
import {getTeam,getShiftCost,getWeekSchedule} from "@/lib/actions/schedule";
import {scheduleReadTools,localizedToastScheduleReadError} from "./scheduleReads";
import {aggregateCosts} from "@/lib/calc/scheduling/shiftCost";
import {newResolveState} from "../resolve";
import type {AgentToolContext} from "./index";
const id="11111111-1111-4111-8111-111111111111";
describe("Toast and app schedule union",()=>{
 it("localizes Toast read error reasons in EN, ES and AR",()=>{
   expect(localizedToastScheduleReadError("revoked","en")).toContain("permission denied");
   expect(localizedToastScheduleReadError("revoked","es")).toContain("permiso denegado");
   expect(localizedToastScheduleReadError("revoked","ar")).toContain("تم رفض");
   expect(localizedToastScheduleReadError("timeout","es")).toContain("se agotó");
 });
 it("Team screen and chat totals agree on exactly the same week fixture",async()=>{
  const appShifts=[{id:"scheduled-1",date:"2026-10-24",employeeId:"employee",
    employeeName:"Ava",start:"09:00",end:"13:00",paidMinutes:240,
    costCents:8000,estimated:false,unknown:false}];
  const screenFixture={ok:true as const,data:{
    team:[{id:"employee",name:"Ava",role:"Barista",wageCents:2000}],
    shifts:appShifts,posShifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
    total:aggregateCosts(appShifts),
    dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }};
  vi.mocked(getWeekSchedule).mockResolvedValue(screenFixture as never);
  const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as AgentToolContext;
  const screen=await getWeekSchedule({weekStart:"2026-10-19"});
  const chatWeek=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},ctx);
  const chatTeam=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:null},ctx);
  expect(screen.ok).toBe(true);
  if(screen.ok){
    expect(chatWeek.paidMinutes).toBe(screen.data.total.paidMinutes);
    expect(chatWeek.knownWagesCents).toBe(screen.data.total.knownCostCents);
    expect(chatTeam.weeklyPaidMinutes).toBe(screen.data.total.paidMinutes);
    expect(chatTeam.knownWagesCents).toBe(screen.data.total.knownCostCents);
  }
  expect(chatWeek.shifts).toMatchObject([{id:"scheduled-1",source:"app"}]);
 });
 it("Toast-only shifts are listed for Saturday",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
    team:[],shifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
    posShifts:[{id:"toast-1",employeeId:null,employeeName:"Casey",
      start:"2026-10-24T16:00:00Z",end:"2026-10-24T20:00:00Z",
      locationId:"location",source:"toast",paid:false}],
    dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    adjacentShifts:[],openHours:{saturday:[["08:00","16:00"]]},rules:{coverage_enabled:true,min_headcount:1}
  }} as never);
  const result=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},
   {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect(result.scheduleSet).toBe(true);
  expect(result.paidMinutes).toBeNull();
  expect(result.shifts).toMatchObject([{date:"2026-10-24",employeeName:"Casey",
    start:"09:00",source:"toast",paidMinutes:null,costCents:null}]);
  expect(result.missing).not.toContain("scheduleNotSet");
  expect(result.gaps).toEqual([]);
  expect(result.missing).toContain("toastScheduleCoverageUnverified");
  expect(result.missing).toContain("toastPlannedLaborUnknown");
  expect(result.knownWagesCents).toBeNull();
  expect(result.paidMinutes).toBeNull();
  const team=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:null},
    {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect(team.weeklyPaidMinutes).toBeNull();
  expect(team.knownWagesCents).toBeNull();
  expect(team.missingWageCount).toBeNull();
  expect(team.missing).toContain("toastPlannedLaborUnknown");
  expect(team.dataNotes).toEqual([expect.stringContaining("app-only totals exclude")]);
 });
 it("reads a named Toast-only worker without an app identity",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
    team:[],shifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
    posShifts:[{id:"toast-1",employeeId:null,employeeName:"Jordan",
      start:"2026-10-24T16:00:00Z",end:"2026-10-24T20:00:00Z",
      locationId:"location",source:"toast",paid:false}],
    dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",
    resolveState:newResolveState("When is Jordan working Saturday?")} as unknown as AgentToolContext;
  const result=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:"Jordan"},ctx);
  expect(result.shifts).toMatchObject([{id:"toast-1",employeeName:"Jordan",source:"toast"}]);
  expect(result.missing).toContain("toastWorkerNotLinked");
  expect(result.weeklyPaidMinutes).toBeNull();
  const wrong=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:"Jordan"},
    {...ctx,resolveState:newResolveState("When is Casey working?")});
  expect(wrong.shifts).toBeUndefined();
 });
 it("returns selected employee's known labor using the Team cost engine",async()=>{
   vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
     team:[{id:"e1",name:"Jordan",role:"Barista",wageCents:1800},
       {id:"e2",name:"Casey",role:"Barista",wageCents:2000}],
     shifts:[{id:"app-1",date:"2026-10-24",employeeId:"e1",employeeName:"Jordan",
       start:"09:00",end:"13:00",paidMinutes:240,costCents:7200,estimated:false},
       {id:"app-2",date:"2026-10-24",employeeId:"e2",employeeName:"Casey",
       start:"08:00",end:"12:00",paidMinutes:240,costCents:8000,estimated:false}],
     posShifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
     dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
     adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
   }} as never);
   const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",
     resolveState:newResolveState("How many hours and wages did Jordan have?")} as unknown as AgentToolContext;
   const result=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:"Jordan"},ctx);
   expect(result.weeklyPaidMinutes).toBe(240);
   expect(result.knownWagesCents).toBe(7200);
   expect(result.missingWageCount).toBe(0);
   expect(result.shifts).toMatchObject([{id:"app-1"}]);
   expect(result.missing).not.toContain("toastPlannedLaborUnknown");
 });
 it("does not attribute unlinked Toast shifts by matching employee names",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
    team:[{id:"app-jordan",name:"Jordan",role:"Barista",wageCents:1800}],
    shifts:[{id:"app-shift",employeeId:"app-jordan",employeeName:"Jordan",
      date:"2026-10-24",start:"09:00",end:"12:00",paidMinutes:180,costCents:5400,estimated:false}],
    posShifts:[{id:"toast-other",employeeId:null,employeeName:"Jordan",
      start:"2026-10-24T19:00:00Z",end:"2026-10-24T22:00:00Z",
      locationId:"loc",source:"toast",paid:false}],
    timezone:"America/Los_Angeles",posScheduleError:null,
    dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",
    resolveState:newResolveState("When is Jordan working?")} as unknown as AgentToolContext;
  const result=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:"Jordan"},ctx);
  expect((result.shifts as {id:string}[]).map(s=>s.id)).toEqual(["app-shift","toast-other"]);
  expect(result.shifts).toMatchObject([{employeeId:"app-jordan",source:"app"},
    {employeeId:null,source:"toast"}]);
  expect(result.missing).toContain("toastWorkerNotLinked");
 });
 it("preserves two unlinked Toast employees with the same name and start time",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
    team:[],shifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
    posShifts:["toast-1","toast-2"].map(id=>({id,employeeId:null,employeeName:"Jordan",
      start:"2026-10-24T16:00:00Z",end:"2026-10-24T20:00:00Z",
      locationId:"location",source:"toast",paid:false})),
    dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const result=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},
    {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect((result.shifts as {id:string}[]).map(s=>s.id)).toEqual(["toast-1","toast-2"]);
 });
 it("retains Toast shifts with the same ID in different café locations",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
   team:[],shifts:[],posScheduleError:null,timezone:"America/Los_Angeles",
   posShifts:["first","second"].map(locationId=>({id:"shared-id",employeeId:null,
     employeeName:"Jordan",start:"2026-10-24T16:00:00Z",end:"2026-10-24T20:00:00Z",
     locationId,source:"toast",paid:false})),
   dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
   adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const result=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},
    {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect((result.shifts as {locationId:string}[]).map(s=>s.locationId)).toEqual(["first","second"]);
 });
 it("retains a Toast shift when linked app shift has a different end time",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
   team:[{id:"e",name:"Casey"}],shifts:[{id:"app-1",date:"2026-10-24",employeeId:"e",
     employeeName:"Casey",start:"09:00",end:"13:00",paidMinutes:240,costCents:7200,estimated:false}],
   posShifts:[{id:"toast-1",employeeId:"e",employeeName:"Casey",
     start:"2026-10-24T16:00:00Z",end:"2026-10-24T19:00:00Z",
     locationId:"location",source:"toast",paid:false}],
   timezone:"America/Los_Angeles",posScheduleError:null,
   dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
   adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const result=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},
    {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect((result.shifts as {source:string}[]).map(s=>s.source)).toEqual(["app","toast"]);
  expect(result.missing).toContain("toastPlannedLaborUnknown");
 });
 it("keeps a separately labeled app-only subtotal when Toast plans add unknown labor",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
   team:[{id:"employee-a",name:"Ava",role:"Barista",wageCents:2000}],
   shifts:[{id:"app-1",employeeId:"employee-a",employeeName:"Ava",date:"2026-10-24",
    start:"09:00",end:"13:00",paidMinutes:240,costCents:8000,estimated:false}],
   posShifts:[{id:"toast-1",employeeId:null,employeeName:"Alex",
    start:"2026-10-24T18:00:00Z",end:"2026-10-24T22:00:00Z",
    locationId:"location",source:"toast",paid:false}],posScheduleError:null,
   timezone:"America/Los_Angeles",
   dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
   adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const ctx={asOf:"2026-10-24",locale:"es",timezone:"America/Los_Angeles"} as unknown as AgentToolContext;
  const team=await scheduleReadTools.get_team.execute({week_start:"2026-10-19",name:null},ctx);
  const weekResult=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},ctx);
  for(const result of [team,weekResult]){
    expect(result.missing).toContain("toastPlannedLaborUnknown");
    expect(result.knownWagesCents).toBeNull();
    expect(result.appOnlyKnownWagesCents).toBe(8000);
    expect(result.appOnlyPaidMinutes).toBe(240);
    expect(result.dataNotes).toEqual(expect.arrayContaining([expect.stringContaining("Los turnos")]));
  }
  expect(team.weeklyPaidMinutes).toBeNull();
  expect(weekResult.paidMinutes).toBeNull();
 });
 it("merges matching employee and start without duplicating app shifts",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data:{
   team:[{id:"e",name:"Casey"}],shifts:[{id:"app-1",date:"2026-10-24",employeeId:"e",
    employeeName:"Casey",start:"09:00",end:"13:00",paidMinutes:240,costCents:7200,estimated:false}],
   posShifts:[{id:"toast-1",employeeId:"e",employeeName:"Casey",
    start:"2026-10-24T16:00:00Z",end:"2026-10-24T20:00:00Z",
    locationId:"location",source:"toast",paid:false}],
   timezone:"America/Los_Angeles",posScheduleError:null,
   dates:["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
   adjacentShifts:[],openHours:null,rules:{coverage_enabled:false,min_headcount:0}
  }} as never);
  const result=await scheduleReadTools.get_week_schedule.execute({week_start:"2026-10-19"},
    {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles"} as unknown as AgentToolContext);
  expect(result.shifts).toMatchObject([{id:"app-1",source:"app"}]);
 });
});
describe("overnight shift explanations",()=>{
 it("preserves known overnight wages and explicit breaks without crashing",async()=>{
  vi.mocked(getTeam).mockResolvedValue({ok:true,data:{
    team:[{id,name:"Maria",role:"Barista",wageCents:1800}],shifts:[],totals:{}
  }} as never);
  vi.mocked(getShiftCost).mockResolvedValue({ok:true,data:{
    employeeId:id,paidMinutes:210,costCents:6300,estimated:false,unknown:false
  }} as never);
  const ctx={asOf:"2026-10-24",locale:"en",resolveState:newResolveState("How much is Maria's overnight shift?")} as AgentToolContext;
  const result=await scheduleReadTools.get_shift_cost.execute({
    employee_id:id,date:"2026-10-24",start:"22:00",end:"02:00",break_minutes:30
  },ctx);
  expect(result).toMatchObject({costCents:6300,paidMinutes:210,missing:[]});
  expect(result.explain).toMatchObject([{formula:"prorate",result:{kind:"money",cents:6300}}]);
 });
 it("does not return another employee's wages when an ID mismatches the owner",async()=>{
  vi.mocked(getTeam).mockResolvedValue({ok:true,data:{
    team:[{id,name:"Maria",role:"Barista",wageCents:1800}],shifts:[],totals:{}
  }} as never);
  vi.mocked(getShiftCost).mockClear();
  const ctx={asOf:"2026-10-24",locale:"en",
    resolveState:newResolveState("What will Alex's shift cost?")} as AgentToolContext;
  const result=await scheduleReadTools.get_shift_cost.execute({
    employee_id:id,date:"2026-10-24",start:"10:00",end:"14:00",break_minutes:0
  },ctx);
  expect(result.missing).toContain("targetNotConfirmed");
  expect(getShiftCost).not.toHaveBeenCalled();
 });
});
