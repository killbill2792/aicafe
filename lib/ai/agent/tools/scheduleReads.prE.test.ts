import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWeekSchedule } from "@/lib/actions/schedule";
import { shiftCost } from "@/lib/calc/scheduling/shiftCost";
import { scheduleReadTools } from "./scheduleReads";
import type { AgentToolContext } from "./index";

vi.mock("@/lib/actions/schedule",()=>({
  getWeekSchedule:vi.fn(),getTeam:vi.fn(),getShiftCost:vi.fn(),
}));
vi.mock("@/lib/actions/teamRules",()=>({getTeamRules:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({
  staffReadScope:vi.fn(async()=>({ok:true,today:"2026-10-24"})),
  mondayOfLocalDate:vi.fn((date:string)=>date),
}));

const week="2026-10-19",days=Array.from({length:7},(_,i)=>
  new Date(Date.parse(week+"T12:00:00Z")+i*86400000).toISOString().slice(0,10));
const ctx={locale:"en",asOf:"2026-10-24",timezone:"America/Los_Angeles",tools:{}} as unknown as AgentToolContext;
const active={id:"active",name:"Alex",role:"Barista",wageCents:2000,minWeeklyMinutes:0,maxWeeklyMinutes:2400};
const fakeShift=(id:string,employeeId:string,start:string)=>({
  ...shiftCost({employeeId,date:week,start,end:"17:00",breakMinutes:0,wageCents:2000}),
  id,status:"draft",source:"owner",breakSource:"manual",employeeName:employeeId,
});
function schedule(activeShifts:ReturnType<typeof fakeShift>[],team:typeof active[]=[active]){
  return {ok:true as const,data:{dates:days,team,shifts:activeShifts,adjacentShifts:[],
    openHours:null,rules:{coverage_enabled:true,min_headcount:1},
  }};
}

describe("confirmed weekly schedule is the only chat schedule",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("does not invent gaps or zero paid hours when no confirmed shifts exist",async()=>{
    vi.mocked(getWeekSchedule).mockResolvedValue(schedule([]) as never);
    const scheduleRead=await scheduleReadTools.get_week_schedule.execute({week_start:week},ctx);
    expect(scheduleRead.scheduleSet).toBe(false);
    expect(scheduleRead.href).toBe("/staff?tab=schedule");
    expect(scheduleRead.missing).toContain("scheduleNotSet");
    expect(scheduleRead.shifts).toEqual([]);
    expect(scheduleRead.paidMinutes).toBeNull();
    expect(scheduleRead.gaps).toEqual([]);
    expect(JSON.stringify(scheduleRead)).not.toContain("Dawn");
  });
  it("lists every active teammate with the dates they already work, so a replacement can be proposed",async()=>{
    const sam={...active,id:"sam",name:"Sam"};
    vi.mocked(getWeekSchedule).mockResolvedValue(schedule([fakeShift("a","active","08:00")],[active,sam]) as never);
    const read=await scheduleReadTools.get_week_schedule.execute({week_start:week},ctx);
    const mates=read.teammates as {employeeId:string;shiftDates:string[];scheduledMinutes:number|null}[];
    expect(mates.map(m=>m.employeeId)).toEqual(["active","sam"]);
    expect(mates[0].shiftDates).toEqual([week]);
    expect(mates[1]).toMatchObject({shiftDates:[],scheduledMinutes:0});
    expect(read.availabilityChecked).toBe(false);
  });
  it("retains former staff historical shifts and matches Team screen wage totals",async()=>{
    const activeShift=fakeShift("current","active","08:00");
    const removedShift=fakeShift("removed","former","07:00");
    vi.mocked(getWeekSchedule).mockResolvedValue(schedule([activeShift,removedShift]) as never);
    const confirmed=await scheduleReadTools.get_week_schedule.execute({week_start:week},ctx);
    expect((confirmed.shifts as {employeeId:string}[]).map(s=>s.employeeId)).toEqual(["former","active"]);
    expect(activeShift.costCents).not.toBeNull();
    expect(removedShift.costCents).not.toBeNull();
    const actualKnownCosts=activeShift.costCents!+removedShift.costCents!;
    expect(confirmed.knownWagesCents).toBe(actualKnownCosts);
  });
});
