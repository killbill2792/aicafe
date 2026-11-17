import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const action=vi.hoisted(()=>({week:vi.fn(async()=>({ok:false,error:"session_only"}))}));
vi.mock("@/lib/actions/schedule",()=>({
  getWeekSchedule:action.week,getTeam:vi.fn(),getShiftCost:vi.fn(),
}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({
  mondayOfLocalDate:vi.fn((d:string)=>d),
  staffReadScope:vi.fn(async()=>({ok:false,error:"unauthorized"})),
}));
import {staffTools} from "./staff";
import {scheduleReadTools} from "./scheduleReads";
import type {AgentToolContext} from "./index";

describe("Task 15A Codex P1 — staff evidence without a browser cookie",()=>{
  const scope=()=>({
    asOf:"2026-11-09",timezone:"America/Los_Angeles",
    locale:"en",currency:"USD",
    tools:{getProfitability:vi.fn(),getSalesTrend:vi.fn(),
      getMenuCatalog:vi.fn()},
    investigation:{
      read:vi.fn(),
      weekSchedule:vi.fn(async()=>({ok:false as const,error:"scoped_reader_marker"})),
    },
  } as unknown as AgentToolContext);
  it("uses the SQL-claimed café/owner schedule reader for multi-week staff check",async()=>{
    const ctx=scope();
    action.week.mockClear();
    const res=await staffTools.get_schedule.execute({
      from:"2026-11-09",to:"2026-11-15",
    },ctx);
    expect(ctx.investigation?.weekSchedule).toHaveBeenCalledWith("2026-11-09");
    expect(action.week).not.toHaveBeenCalled();
    expect(res.missing).toEqual(expect.arrayContaining([
      "scheduleReadFailed:2026-11-09:scoped_reader_marker",
    ]));
  });
  it("uses the same scoped reader for confirmed week shifts, never session-only action",async()=>{
    const ctx=scope();
    action.week.mockClear();
    const res=await scheduleReadTools.get_week_schedule.execute({
      week_start:"2026-11-09",
    },ctx);
    expect(ctx.investigation?.weekSchedule).toHaveBeenCalledWith("2026-11-09");
    expect(action.week).not.toHaveBeenCalled();
    expect(res).toMatchObject({source:"scheduled_shifts",
      missing:["scoped_reader_marker"]});
  });
  it("uses the scoped reader for staffing coverage gaps, never a browser session",async()=>{
    const ctx=scope();
    action.week.mockClear();
    const res=await scheduleReadTools.get_coverage_gaps.execute({
      week_start:"2026-11-09",
    },ctx);
    expect(ctx.investigation?.weekSchedule).toHaveBeenCalledWith("2026-11-09");
    expect(action.week).not.toHaveBeenCalled();
    expect(res).toMatchObject({source:"coverage_gaps",
      missing:["scoped_reader_marker"]});
  });
});
