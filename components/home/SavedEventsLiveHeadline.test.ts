import {describe,it,expect} from "vitest";
import {liveEventHeadline} from "./SavedEventsCard";
import type {SavedEventTimeline} from "@/lib/data/cafeEvents.server";

type Plan=SavedEventTimeline["plans"][number];
const translate=(key:string,values?:Record<string,string|number>)=>
  key+":"+String(values?.change??"")+":"+String(values?.time??"");
const plan=(report:unknown,status="in_progress")=>({
 proposalId:"p",threadId:"t",status:"committed",revision:3,
 startDate:"2026-10-30",endDate:"2026-10-30",summary:"Parade",
 actions:[],expectedBusyHours:[],factsHash:"abc",reportStatus:status,report,
}) satisfies Plan;

describe("Home event headline uses the shared saved in-progress report",()=>{
 it("shows a provisional comparison in the current day's locale",()=>{
   expect(liveEventHeadline(plan({liveWatch:{
     businessDate:"2026-10-30",coverage:"provisional",changePercent:-31,asOfLocal:"12:45",
   }}),"2026-10-30",translate)).toBe("liveBehind:31:12:45");
 });
 it("does not show stale, terminal, or unverified live comparisons",()=>{
   const report={liveWatch:{businessDate:"2026-10-29",coverage:"provisional",
     changePercent:40,asOfLocal:"12:00"}};
   expect(liveEventHeadline(plan(report),"2026-10-30",translate)).toBeNull();
   expect(liveEventHeadline(plan({...report,liveWatch:{...report.liveWatch,
     businessDate:"2026-10-30"}},"complete"),"2026-10-30",translate)).toBeNull();
   expect(liveEventHeadline(plan({liveWatch:{businessDate:"2026-10-30",
     coverage:"actual",changePercent:40,asOfLocal:"12:00"}}),"2026-10-30",translate)).toBeNull();
 });
});
