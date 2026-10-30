import {describe,expect,it} from "vitest";
import {eventListDays,eventStripDays} from "./SavedEventsCard";
import type {CafeEvent,SavedEventTimeline} from "@/lib/data/cafeEvents.server";

const event=(id:string,startDate:string,endDate=startDate):CafeEvent=>({
  id,name:id,kind:"community",startDate,endDate,startTime:null,endTime:null,
  venue:"Town center",venueAddress:null,areaLabel:null,sourceUrl:"https://events.example.org",
  status:"found",foundAt:"2026-10-29T10:00:00Z",lastCheckedAt:"2026-10-29T10:00:00Z",
});
const fixture:SavedEventTimeline&{today:string}={
  today:"2026-10-30",
  events:[
    event("past","2026-10-20"),
    event("today","2026-10-30"),
    event("festival","2026-10-31","2026-11-02"),
    event("later","2026-11-05"),
  ],
  plans:[{
    proposalId:"p",threadId:"t",status:"draft",revision:1,
    startDate:"2026-10-31",endDate:"2026-11-02",
    summary:"AI-written plan",actions:[],expectedBusyHours:[],
    factsHash:"hash",reportStatus:null,report:null,
  }],
};
describe("saved events Home calendar",()=>{
  it("always shows seven consecutive café-local dates, including empty days",()=>{
    expect(eventStripDays(fixture.today)).toEqual([
      "2026-10-30","2026-10-31","2026-11-01","2026-11-02",
      "2026-11-03","2026-11-04","2026-11-05",
    ]);
  });
  it("groups multi-day events once, keeps today separate, and shows the past 14 days",()=>{
    expect(eventListDays(fixture,"past",false)).toEqual(["2026-10-20"]);
    expect(eventListDays(fixture,"now",false)).toEqual(["2026-10-30"]);
    expect(eventListDays(fixture,"upcoming",false)).toEqual(["2026-10-31","2026-11-05"]);
  });
  it("only marks a day as affecting the café when an actual saved plan covers it",()=>{
    expect(eventListDays(fixture,"upcoming",true)).toEqual(["2026-10-31"]);
    expect(eventListDays(fixture,"now",true)).toEqual([]);
    expect(eventListDays({...fixture,plans:[]},"upcoming",true)).toEqual([]);
  });
  it("does not drop an event already underway at the edge of the date window",()=>{
    const cross={...fixture,events:[event("long","2026-10-24","2026-11-02")],plans:[]};
    expect(eventListDays(cross,"upcoming",false)).toEqual(["2026-10-31"]);
  });
});
