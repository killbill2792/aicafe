import {describe,expect,it} from "vitest";
import {cafeToday} from "@/lib/metrics/core/clock";
import {pendingEventDays} from "./eventsLookahead.server";
import {cityScanWindows} from "./eventsLookahead";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";

const event: CafeEvent={
  id:"11111111-1111-4111-8111-111111111111",
  name:"Community gathering",kind:"community",
  startDate:"2026-11-01",endDate:"2026-11-01",
  startTime:null,endTime:null,venue:null,venueAddress:null,areaLabel:null,
  sourceUrl:"https://events.example.test/gathering",
  status:"found",foundAt:"2026-10-31T00:00:00Z",
  lastCheckedAt:"2026-10-31T00:00:00Z",
};

describe("event cutover parity at café-local date boundaries",()=>{
  it("uses each café's local day rather than the cron's UTC date",()=>{
    const tick=new Date("2026-11-01T06:30:00Z");
    const pacificDay=cafeToday("America/Los_Angeles",tick);
    const aucklandDay=cafeToday("Pacific/Auckland",tick);
    expect(pacificDay).toBe("2026-10-31");
    expect(aucklandDay).toBe("2026-11-01");
    expect(pendingEventDays([event],[],pacificDay,pacificDay)).toEqual([]);
    expect(pendingEventDays([event],[],aucklandDay,aucklandDay)).toEqual([{
      date:"2026-11-01",events:[event],
      hash:expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
  });

  it("does not treat unsearched city research as a completed empty scan",()=>{
    const previous={
      locationHash:"city-location",scannedThroughDate:"2026-11-13",
      weeklyResearchedOn:null,
    };
    expect(cityScanWindows("2026-11-01",previous,"city-location","unsearched"))
      .toEqual([{from:"2026-11-01",to:"2026-11-14",reason:"initial"}]);
  });
});
