import {describe,expect,it} from "vitest";
import {briefSchedule,openingMinute} from "./briefSchedule";
import type {OpenHours} from "@/lib/business/openHours";

const zone="America/Los_Angeles";
// Tuesday Nov 3 2026 is PST (UTC-8). Local hh:mm -> Date.
const at=(hhmm:string,day="2026-11-03",offset="-08:00")=>new Date(`${day}T${hhmm}:00${offset}`);
const weekdays=(open:string):OpenHours=>({mon:[[open,"21:00"]],tue:[[open,"21:00"]],wed:[[open,"21:00"]],
  thu:[[open,"21:00"]],fri:[[open,"21:00"]],sat:[["07:30","21:00"]],sun:[]});

describe("per-café morning brief send time",()=>{
  it("a café opening at 6:30 gets its brief before 6:30 (latest send 06:00)",()=>{
    const hours=weekdays("06:30");
    const s=briefSchedule(at("05:00"),zone,hours);
    expect(s).toMatchObject({today:"2026-11-03",yesterday:"2026-11-02",hoursSource:"open_hours",
      latestSendLocal:"06:00",phase:"window"});
    expect(briefSchedule(at("03:59"),zone,hours).phase).toBe("early");
    expect(briefSchedule(at("04:00"),zone,hours).phase).toBe("window");
    expect(briefSchedule(at("05:45"),zone,hours).phase).toBe("fallback");
    expect(briefSchedule(at("06:00"),zone,hours).phase).toBe("late");
    expect(briefSchedule(at("06:30"),zone,hours).phase).toBe("missed");
    expect(briefSchedule(at("08:30"),zone,hours).phase).toBe("done");
    // The outbox deadline is the opening time itself.
    expect(s.sendBefore).toBe("2026-11-03T14:30:00.000Z");
  });
  it("a café opening at 9:00 gets its brief before 9:00, not at dawn",()=>{
    const hours=weekdays("09:00");
    expect(briefSchedule(at("05:29"),zone,hours).phase).toBe("early");
    expect(briefSchedule(at("05:30"),zone,hours).phase).toBe("window");
    expect(briefSchedule(at("08:15"),zone,hours).phase).toBe("fallback");
    expect(briefSchedule(at("08:29"),zone,hours).phase).toBe("fallback");
    expect(briefSchedule(at("08:30"),zone,hours)).toMatchObject({phase:"late",latestSendLocal:"08:30"});
    expect(briefSchedule(at("08:59"),zone,hours).phase).toBe("late");
    expect(briefSchedule(at("09:00"),zone,hours).phase).toBe("missed");
  });
  it("unknown hours use 06:00 café time and say so",()=>{
    for(const hours of [null,{mon:[["07:00","15:00"]]} as OpenHours]){
      const s=briefSchedule(at("05:50"),zone,hours);
      expect(s).toMatchObject({hoursSource:"default_unknown_hours",latestSendLocal:"06:00",phase:"fallback"});
    }
    expect(openingMinute(weekdays("06:30"),"2026-11-08")).toEqual({minute:390,source:"default_closed_today"});
    expect(openingMinute({tue:[["00:00","23:59"]]},"2026-11-03").source).toBe("default_overnight_hours");
  });
  it("uses that day's own opening time (Saturday 07:30 vs weekday 06:30)",()=>{
    const s=briefSchedule(at("06:40","2026-11-07"),zone,weekdays("06:30"));
    expect(s).toMatchObject({latestSendLocal:"07:00",phase:"window"});
  });
  it("five-minute cron ticks always hit the send-anyway window before the latest send time",()=>{
    for(const open of ["05:00","06:30","07:15","09:00","11:00"]){
      const hours=weekdays(open);
      const fallback=[...Array(24*12).keys()].map(i=>{
        const minutes=i*5;
        const hh=String(Math.floor(minutes/60)).padStart(2,"0"),mm=String(minutes%60).padStart(2,"0");
        return briefSchedule(at(`${hh}:${mm}`),zone,hours).phase;
      }).filter(p=>p==="fallback").length;
      expect(fallback).toBeGreaterThanOrEqual(3);
    }
  });
  it("keeps the café-local day and opening instant across DST changes",()=>{
    // Nov 1 2026: clocks fall back; 05:50 PST = 13:50 UTC.
    const s=briefSchedule(new Date("2026-11-01T13:50:00Z"),zone,{sun:[["07:00","15:00"]]});
    expect(s).toMatchObject({today:"2026-11-01",latestSendLocal:"06:30",phase:"window"});
    expect(s.sendBefore).toBe("2026-11-01T15:00:00.000Z");
    // Mar 14 2027 (spring forward): 05:50 PDT = 12:50 UTC.
    const spring=briefSchedule(new Date("2027-03-14T12:50:00Z"),zone,null);
    expect(spring).toMatchObject({today:"2027-03-14",phase:"fallback"});
    expect(spring.sendBefore).toBe("2027-03-14T13:30:00.000Z");
  });
  it("rejects an invalid timezone instead of guessing",()=>{
    expect(()=>briefSchedule(new Date(),"No/Such_Zone",null)).toThrow();
  });
});
