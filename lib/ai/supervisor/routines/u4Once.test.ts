import {describe,expect,it} from "vitest";
import {routineScheduleSchema} from "./contracts";
import {dueInstantForDate,dueScheduleOnDate,isScheduledOn} from "./calendar";
describe("owner verified one-time U4 schedule",()=>{
  const schedule={title:"Investigate real sales",cadence:"once" as const,
    weekdays:[],localTime:"16:03",onceLocalDate:"2026-11-21"};
  it("does not turn one due objective into a daily or weekly run",()=>{
    const stored=routineScheduleSchema.parse(schedule);
    expect(isScheduledOn(stored,"2026-11-21")).toBe(true);
    expect(isScheduledOn(stored,"2026-11-22")).toBe(false);
    expect(dueScheduleOnDate(stored,"America/Los_Angeles",
      "2026-11-21",new Date("2026-11-22T04:00:00Z"))?.toISOString())
      .toBe("2026-11-22T00:03:00.000Z");
    expect(dueScheduleOnDate(stored,"America/Los_Angeles",
      "2026-11-21",new Date("2026-11-22T00:02:00Z"))).toBeNull();
  });
  it("refuses ambiguous once dates, weekdays and duplicate recurring dates",()=>{
    expect(()=>routineScheduleSchema.parse({...schedule,weekdays:[1]})).toThrow();
    expect(()=>routineScheduleSchema.parse({...schedule,onceLocalDate:null})).toThrow();
    expect(()=>routineScheduleSchema.parse({...schedule,onceLocalDate:"2026-02-30"})).toThrow();
    expect(()=>routineScheduleSchema.parse({...schedule,cadence:"daily",onceLocalDate:"2026-11-21"})).toThrow();
  });
  it("uses first fall-back wall minute, then first spring-forward eligible instant",()=>{
    expect(dueInstantForDate("2026-11-01","01:30","America/Los_Angeles").toISOString())
      .toBe("2026-11-01T08:30:00.000Z");
    expect(dueInstantForDate("2026-03-08","02:30","America/Los_Angeles").toISOString())
      .toBe("2026-03-08T10:00:00.000Z");
  });
});

describe("one-time owner saved acknowledgment contract",()=>{
  it("accepts the exact verified date, clock, timezone and revision",async()=>{
    const {routineCardSchema}=await import("@/lib/ai/conversations/contracts");
    const card={type:"routine_card" as const,routineId:"de2c829e-8a90-4cf4-80ba-4f38e6d668eb",
      title:"Check real sales",cadence:"once" as const,
      onceLocalDate:"2026-12-03",weekdays:[],localTime:"09:30",
      timezone:"America/Los_Angeles",status:"active" as const,revision:1};
    expect(routineCardSchema.parse(card)).toMatchObject(card);
    expect(routineCardSchema.safeParse({...card,onceLocalDate:null}).success).toBe(false);
    expect(routineCardSchema.safeParse({...card,cadence:"daily"}).success).toBe(false);
  });
});
