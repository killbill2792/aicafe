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
