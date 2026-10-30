import {beforeEach,describe,expect,it,vi} from "vitest";
const writes=vi.hoisted(()=>({rows:[] as Array<{table:string;row:Record<string,unknown>}>}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:(table:string)=>{
 const q:Record<string,unknown>={};
 for(const m of ["select","eq"])q[m]=()=>q;
 q.single=async()=>({data:{timezone:"America/Los_Angeles"},error:null});
 q.upsert=async(row:Record<string,unknown>)=>{writes.rows.push({table,row});return {error:null};};
 q.insert=async(row:Record<string,unknown>)=>{writes.rows.push({table,row});return {error:null};};
 return q;
}})}));
import {eventReadinessCapability,eventReadinessEffect} from "./eventReadiness.server";
import {SupabaseLoopRepository,stableMessageId} from "./supabase.server";
import type {LoopProposal,OwnerLoopScope} from "./engine";

const date="2026-10-31";
const id="11111111-1111-4111-8111-111111111111";
const scope:OwnerLoopScope={businessId:"cafe",ownerUserId:"owner",threadId:"thread",locale:"en"};
const effect=eventReadinessEffect.parse({
 startDate:date,endDate:date,eventIds:[id],summary:"Prepare for parade",
 expectedBusyHours:[{start:"11:00",end:"15:00"}],
 actions:[{area:"staff",action:"Ask for backup",reason:"Parade crowd"}],
 facts:[{id,name:"Parade",kind:"parade",startDate:date,endDate:date,
   venue:"Square",areaLabel:"Downtown",sourceUrl:"https://example.org"}],
 factsHash:"a".repeat(64),
});
const proposal={id:"proposal-id",capabilityId:"alex.event_readiness.v1",threadId:scope.threadId} as LoopProposal;
const sample={businessDate:date,source:"toast_today_live+hourly_sales_rollup",
 observation:{coverage:"provisional",asOf:"2026-10-31T19:01:00.000Z",asOfLocal:"12:01",
  actualCents:5000,typicalCents:10000,changePercent:-50,baselineDays:5,notable:true}};

describe("notable event-day findings reuse Supervisor reports, thread and Operations inbox",()=>{
 beforeEach(()=>{writes.rows.length=0;});
 it("labels full-hour historical evidence and saves one day-scoped watching task",async()=>{
   const report=await eventReadinessCapability.report(scope,effect,[sample],false,
     {start:date,through:date});
   expect(report.status).toBe("in_progress");
   expect(report.midRunKey).toBe(date);
   expect(report.midRunText).toContain("12:59");
   expect(report.midRunText).toContain("12:01");
   expect(report.midRunText).toContain("partial");
   expect(report.delivery).toMatchObject({agentId:"alex",taskKind:"event_plan",
     entityType:"event_day",entityId:date,confidence:"low",
     payload:{businessDate:date,provisional:true,changePercent:-50,usualThroughHourEnd:"12:59"}});
   await new SupabaseLoopRepository().saveReport(scope,proposal,report,{midRun:true});
   expect(writes.rows.map(x=>x.table)).toEqual(["supervisor_reports","operating_tasks","ai_messages"]);
   const task=writes.rows.find(x=>x.table==="operating_tasks")!.row;
   const message=writes.rows.find(x=>x.table==="ai_messages")!.row;
   expect(task).toMatchObject({id:"supervisor:alex.event_readiness.v1:proposal-id:midrun:"+date,
     status:"watching",payload:{businessDate:date,threadId:"thread",proposalId:"proposal-id",
       midRun:true}});
   expect(message).toMatchObject({
     id:stableMessageId("supervisor-midrun:proposal-id:"+date),thread_id:"thread",
     structured_content:[{type:"text",text:report.midRunText}],
   });
 });
 it("keeps unnotable readings as saved reports without sending owner alerts",async()=>{
   const report=await eventReadinessCapability.report(scope,effect,
     [{...sample,observation:{...sample.observation,notable:false}}],false,
     {start:date,through:date});
   expect(report.midRunText).toBeUndefined();
   expect(report.delivery).toBeUndefined();
   await new SupabaseLoopRepository().saveReport(scope,proposal,report,{midRun:true});
   expect(writes.rows.map(x=>x.table)).toEqual(["supervisor_reports"]);
 });
 it("never sends PR 7 final-report delivery from the PR 6 live watch",async()=>{
   const report=await eventReadinessCapability.report(scope,effect,[sample],true,
     {start:date,through:date});
   expect(report.delivery).toBeUndefined();
   expect(report.midRunText).toBeUndefined();
 });
});
