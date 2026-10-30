import {describe,expect,it} from "vitest";
import {z} from "zod";
import {registerLoopCapability,loopRegistry,monitorLoop,effectHash,
 type LoopRepository,type LoopProposal,type LoopSample,type LoopReport,type OwnerLoopScope} from "./engine";

const scope:OwnerLoopScope={businessId:"cafe",ownerUserId:"owner",threadId:"event-thread",locale:"en"};
const effect={subject:"Parade"};
const makeProposal=():LoopProposal=>({
 id:"proposal",businessId:scope.businessId,ownerUserId:scope.ownerUserId,threadId:scope.threadId,
 capabilityId:"alex.live_event_fixture.v1",capabilityVersion:1,canonicalEffectPayload:effect,
 effectHash:effectHash(effect),baseline:{},monitorSpec:{durationDays:1,metricScope:"event"},
 status:"committed",revision:3,locale:"en",monitoringStartDate:"2026-10-30",
 createdAt:"2026-10-20T00:00:00Z",
});
function fixture(sample:LoopSample|null){
 const saves:Array<{report:LoopReport;midRun:boolean|undefined}>=[];
 const rows:LoopSample[]=[];
 let clears=0;
 const repo:LoopRepository={
   create:async()=>{throw Error("not used");},load:async()=>makeProposal(),
   transition:async()=>makeProposal(),
   addSample:async(_,__,s)=>{rows.splice(0,rows.length,s);},
   clearSample:async()=>{clears++;rows.splice(0);},
   samples:async()=>rows,
   saveReport:async(_,__,report,opts)=>{saves.push({report,midRun:opts?.midRun});},
 };
 const cap=registerLoopCapability({
   id:"alex.live_event_fixture.v1",version:1,
   inputSchema:z.strictObject({subject:z.string()}),
   effectSchema:z.strictObject({subject:z.string()}),
   dependencyScope:()=>({kind:"event"}),
   simulate:async()=>({effect,baseline:{},monitorSpec:{durationDays:1,metricScope:"event"}}),
   commit:async()=>({status:"verified",evidenceSource:"event"}),
   monitor:async()=>sample,
   report:async(_scope,_effect,samples,complete)=>({
     status:complete?"complete":"in_progress",recommendation:"adjust",source:"today_live",
     result:{covered:samples.length},midRunText:"Provisional event update",midRunKey:"2026-10-30",
   }),
 });
 return {repo,saves,rows,getClears:()=>clears,registry:loopRegistry(cap)};
}
describe("live monitoring uses the same Supervisor report lifecycle",()=>{
 it("does not prematurely finalize a one-day plan on its live day",async()=>{
   const sample={businessDate:"2026-10-30",source:"today_live",
     observation:{coverage:"provisional",actualCents:25000}};
   const f=fixture(sample);
   const report=await monitorLoop(scope,f.registry,f.repo,makeProposal(),
     "2026-10-30",true,true,true);
   expect(report).toMatchObject({status:"in_progress",
     result:{covered:1,status:"in_progress"},midRunKey:"2026-10-30"});
   expect(f.saves).toMatchObject([{midRun:true,report:{status:"in_progress"}}]);
 });
 it("does not clear an existing sample or post a report on a failed live read",async()=>{
   const f=fixture(null);
   const report=await monitorLoop(scope,f.registry,f.repo,makeProposal(),
     "2026-10-30",true,true,true);
   expect(report).toBeNull();
   expect(f.getClears()).toBe(0);
   expect(f.saves).toEqual([]);
 });
 it("refuses to mislabel finalized evidence as live",async()=>{
   const f=fixture({businessDate:"2026-10-30",source:"daily",
     observation:{coverage:"actual"}});
   expect(await monitorLoop(scope,f.registry,f.repo,makeProposal(),
     "2026-10-30",true,true,true)).toBeNull();
   expect(f.rows).toEqual([]);
 });
});
