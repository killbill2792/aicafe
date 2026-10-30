import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {CafeEvent,SavedEventTimeline} from "@/lib/data/cafeEvents.server";
import {verifyUpcomingEventChanges} from "./eventVerification.server";

vi.mock("@/lib/ai/agent/loop.server",()=>({
  runAgentTurn:vi.fn(async()=>({text:"The organizer cancelled the parade. Review the saved plan and any orders; no change has been made."})),
}));
vi.mock("@/lib/ai/agent/persist.server",()=>({
  agentReplyPayload:()=>({reply:{blocks:[{type:"text",text:"Organizer cancelled the parade."}]},metadata:{}}),
}));
const event: CafeEvent={
  id:"00000000-0000-4000-8000-000000000011",name:"Parade",
  kind:"parade",startDate:"2026-11-06",endDate:"2026-11-06",startTime:null,endTime:null,
  venue:"Main Street",venueAddress:null,areaLabel:null,
  sourceUrl:"https://city.example/events/parade",status:"found",
  foundAt:"2026-10-20T00:00:00Z",lastCheckedAt:"2026-10-30T00:00:00Z",
};
const plan={proposalId:"proposal-id",threadId:"thread-id",status:"committed",revision:1,
  startDate:"2026-11-06",endDate:"2026-11-06",summary:"Plan owner approved",
  actions:[{area:"staff",action:"Consider a second barista"}],
  expectedBusyHours:[],factsHash:"original",reportStatus:null,report:null};
function fakeDb(){
  const writes:Array<{table:string;patch:Record<string,unknown>;filters:Array<[string,string]>}>=[];
  let taskExists=false;
  const db={
    from:(table:string)=>{
      const filters:Array<[string,string]>=[];
      const query={
        eq(key:string,value:string){filters.push([key,value]);return this;},
        order(){return this;},limit(){return this;},select(){return this;},
        maybeSingle:async()=>({data:table==="operating_tasks"?taskExists?{id:"existing"}:null:
          table==="supervisor_proposals"?{locale:"en"}:{id:event.id},error:null}),
        then(resolve:(v:{error:null})=>unknown){
          writes.push({table,patch:{},filters:[...filters]});
          return Promise.resolve(resolve({error:null}));
        },
      };
      return {
        select:()=>query,
        update:(patch:Record<string,unknown>)=>({
          ...query,
          eq(key:string,value:string){filters.push([key,value]);return this;},
          select(){return this;},
          async maybeSingle(){
            writes.push({table,patch,filters:[...filters]});
            return {data:{id:event.id},error:null};
          },
          then(resolve:(v:{error:null})=>unknown){
            writes.push({table,patch,filters:[...filters]});
            return Promise.resolve(resolve({error:null}));
          },
        }),
        insert:async(patch:Record<string,unknown>)=>{
          writes.push({table,patch,filters:[]});return {error:null};
        },
        upsert:async(patch:Record<string,unknown>)=>{
          writes.push({table,patch,filters:[]});
          if(table==="operating_tasks")taskExists=true;
          return {error:null};
        },
      };
    },
  };
  return {db:db as unknown as SupabaseClient,writes};
}
const timeline=(events:CafeEvent[]=[event]):SavedEventTimeline=>({events,plans:[plan]});
describe("persisted change alerts through the existing inbox and chat",()=>{
 it("cancellation five days early saves status, source, chat and one owner task without touching approvals",async()=>{
   const {db,writes}=fakeDb();
   const count=await verifyUpcomingEventChanges(db,"cafe-one","owner-one","America/Los_Angeles",
     "2026-11-01",timeline(),new Date("2026-11-01T12:00:00Z"),
     async()=>({evidence:{verdict:"cancelled",
       sourceUrl:"https://city.example/events/parade",
       statement:"Parade cancelled by the city.",newDate:null,newVenue:null},
       citedUrls:["https://city.example/events/parade"]}));
   expect(count).toBe(1);
   expect(writes.find(w=>w.table==="cafe_events"&&w.patch.status==="cancelled")?.patch)
     .toMatchObject({last_verified_at:"2026-11-01T12:00:00.000Z"});
   expect(writes.filter(w=>w.table==="operating_tasks")).toHaveLength(1);
   expect(writes.filter(w=>w.table==="ai_messages")).toHaveLength(1);
   expect(writes.filter(w=>w.table==="supervisor_proposals")).toHaveLength(0);
   expect(writes.every(w=>["cafe_events","ai_messages","operating_tasks"].includes(w.table)))
     .toBe(true);
   expect(writes.filter(w=>w.table==="cafe_events").every(w=>
     w.filters.some(([k,v])=>k==="business_id"&&v==="cafe-one"))).toBe(true);
 });
 it("failed or conflicting verification records failure without erasing saved status",async()=>{
   const {db,writes}=fakeDb();
   const count=await verifyUpcomingEventChanges(db,"cafe-one","owner-one","UTC",
     "2026-11-01",timeline(),new Date("2026-11-01T12:00:00Z"),async()=>null);
   expect(count).toBe(0);
   expect(writes).toHaveLength(1);
   expect(writes[0].patch).toMatchObject({verification_failed_at:"2026-11-01T12:00:00.000Z"});
   expect(writes[0].patch).not.toHaveProperty("status");
   expect(writes[0].patch).not.toHaveProperty("last_verified_at");
 });
 it("retains cancellation history when a cited reinstatement restores an event",async()=>{
   const {db,writes}=fakeDb();
   const previous={
     id:event.id,previousStatus:"found",status:"cancelled",verdict:"cancelled",
     sourceUrl:event.sourceUrl!,statement:"Cancelled",newDate:null,newVenue:null,
     verifiedAt:"2026-10-30T12:00:00Z",
   };
   const original={...event,status:"cancelled" as const,
     verificationDetails:{change:previous,pendingNotice:false,history:[previous]}};
   const changed=await verifyUpcomingEventChanges(db,"cafe-one","owner-one","UTC",
     "2026-11-01",timeline([original]),new Date("2026-11-01T12:00:00Z"),
     async()=>({evidence:{verdict:"reinstated",
       sourceUrl:event.sourceUrl,statement:"City says parade resumes.",
       newDate:null,newVenue:null},citedUrls:[event.sourceUrl!]}));
   expect(changed).toBe(1);
   const changes=writes.filter(w=>w.table==="cafe_events");
   expect(changes[0].patch.status).toBe("found");
   const details=changes[0].patch.verification_details as {history:Array<{verdict:string}>};
   expect(details.history.map(h=>h.verdict)).toEqual(["cancelled","reinstated"]);
   expect(writes.filter(w=>w.table==="operating_tasks")).toHaveLength(1);
 });
 it("does not replay an already-delivered notice or recheck immediately",async()=>{
   const {db,writes}=fakeDb();
   const old={...event,status:"cancelled" as const,
     lastAttemptedAt:"2026-11-01T12:00:00Z",
     verificationDetails:{change:{
       id:event.id,previousStatus:"found",status:"cancelled",verdict:"cancelled",
       sourceUrl:event.sourceUrl!,statement:"Cancelled",newDate:null,newVenue:null,
       verifiedAt:"2026-11-01T12:00:00Z"},pendingNotice:false}};
   expect(await verifyUpcomingEventChanges(db,"cafe-one","owner-one","UTC",
     "2026-11-01",timeline([old]),new Date("2026-11-01T13:00:00Z"),
     async()=>{throw new Error("should not recheck");})).toBe(0);
   expect(writes).toEqual([]);
 });
});
