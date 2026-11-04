import {describe,it,expect,vi} from "vitest";
vi.mock("@/lib/actions/schedule",()=>({getWeekSchedule:vi.fn(),getTeam:vi.fn(),getShiftCost:vi.fn()}));
vi.mock("@/lib/actions/teamRules",()=>({getTeamRules:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({
 staffReadScope:vi.fn(),mondayOfLocalDate:vi.fn((date:string)=>date)
}));
import {getWeekSchedule} from "@/lib/actions/schedule";
import {reconcileStaffCalendar} from "@/lib/calc/scheduling/calendarEntries";
import {projectVisibleStaffWeek} from "@/lib/calc/scheduling/schedulePresentation";
import {scheduleReadTools} from "./scheduleReads";
import {staffTools} from "./staff";
import type {AgentToolContext} from "./index";
const week="2026-11-09";
const approved={id:"approved-1",employeeId:"amy",employeeName:"Amy",date:week,
 start:"09:00",end:"17:00",paidMinutes:480,costCents:16000,estimated:false,
 minutes:480,unknown:false,breakMinutes:0,wageCents:2000,source:"olivia",status:"draft"};
const calendarEntries=reconcileStaffCalendar([
 {id:"ai-supervisor:approved-1",date:week,employeeId:"amy",employeeName:"Amy",
  start:"09:00",end:"17:00",source:"ai_draft"},
 {id:"toast:planned",date:week,employeeId:"amy",employeeName:"Amy",locationId:"main",
  start:"10:00",end:"18:00",source:"toast_planned"},
 {id:"ai-revision:only",date:"2026-11-10",employeeId:"amy",employeeName:"Amy",
  start:"07:00",end:"11:00",source:"ai_draft"}
] as const);
const data={dates:Array.from({length:7},(_,i)=>
 new Date(Date.parse(week+"T12:00:00Z")+i*86400000).toISOString().slice(0,10)),
 weekStart:week,team:[{id:"amy",name:"Amy"}],shifts:[approved],posShifts:[],
 calendarEntries,posScheduleError:null,adjacentShifts:[],openHours:null,
 rules:{coverage_enabled:false,min_headcount:0},timezone:"America/Los_Angeles"};
describe("Staff and Supervisor use exactly one Toast-first shift list",()=>{
 it("shows only Toast on a replaced day and includes unsaved Olivia revisions in chat",async()=>{
  vi.mocked(getWeekSchedule).mockResolvedValue({ok:true,data} as never);
  const fromStaff=projectVisibleStaffWeek(data);
  const fromChat=await scheduleReadTools.get_week_schedule.execute({week_start:week},
   {asOf:week,locale:"en",timezone:"America/Los_Angeles"} as AgentToolContext);
  expect(fromChat.shifts).toEqual(fromStaff.visible);
  const rangeChat=await staffTools.get_schedule.execute({from:week,to:"2026-11-15"},
   {asOf:week,locale:"en",timezone:"America/Los_Angeles"} as AgentToolContext);
  expect(rangeChat.shifts).toEqual(fromStaff.visible);
  expect((fromChat.shifts as {id:string}[]).map(x=>x.id))
   .toEqual(["toast:planned","ai-revision:only"]);
  expect(fromChat.paidMinutes).toBeNull();
  expect(fromChat.knownWagesCents).toBeNull();
  expect(fromStaff.laborShifts).toEqual([]);
 });
});