import {describe,expect,it} from "vitest";
import {dueInstantForDate,dueScheduleOnDate,isScheduledOn,localDateAt} from "./calendar";
describe("café-local due-once routines",()=>{
  it("chooses the first repeated fall-back minute regardless of UTC retry",()=>{
    expect(dueInstantForDate("2026-11-01","01:30","America/Los_Angeles")
      .toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });
  it("moves a missing spring-forward minute to the first valid minute",()=>{
    expect(dueInstantForDate("2026-03-08","02:30","America/Los_Angeles")
      .toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });
  it("resolves independent locations without assuming the server timezone",()=>{
    expect(dueInstantForDate("2026-10-25","01:30","Europe/London")
      .toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(localDateAt(new Date("2026-11-01T02:00:00Z"),"Pacific/Auckland"))
      .toBe("2026-11-01");
  });
  it("selects weekly ISO weekdays and refuses invalid date",()=>{
    const weekly={title:"Recheck supplies",cadence:"weekly" as const,weekdays:[1,3],localTime:"09:00"};
    expect(isScheduledOn(weekly,"2026-11-09")).toBe(true);
    expect(isScheduledOn(weekly,"2026-11-10")).toBe(false);
    expect(isScheduledOn(weekly,"2026-02-30")).toBe(false);
    expect(dueScheduleOnDate(weekly,"UTC","2026-11-09",new Date("2026-11-09T08:59:00Z"))).toBeNull();
    expect(dueScheduleOnDate(weekly,"UTC","2026-11-09",new Date("2026-11-09T09:01:00Z")))
      ?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });
  it("rejects nonexistent timezones and invalid input",()=>{
    expect(()=>dueInstantForDate("2026-02-30","10:00","UTC")).toThrow();
    expect(()=>dueInstantForDate("2026-01-01","24:00","UTC")).toThrow();
    expect(()=>dueInstantForDate("2026-01-01","10:00","Bad/Timezone")).toThrow();
  });
});
