import {describe,expect,it} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {stableMessageId} from "@/lib/ai/supervisor/loop/supabase.server";
import {eventPlanFacts} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {recoverPlanDelivery} from "./eventsLookahead.server";

const day="2026-11-03",today="2026-10-30";
const businessId="cafe-one",ownerId="owner-one";
const event=(name:string):CafeEvent=>({
  id:"11111111-1111-4111-8111-111111111111",name,kind:"parade",
  startDate:day,endDate:day,startTime:"11:00",endTime:"13:00",
  venue:"Town square",venueAddress:"1 Main St",areaLabel:"Downtown",
  sourceUrl:"https://city.example/parade",status:"found",
  foundAt:"2026-10-29T00:00:00Z",lastCheckedAt:"2026-10-30T00:00:00Z",
});
const plan=(name:string,proposalId:string)=>({
  proposalId,threadId:"thread-one",startDate:day,status:"draft",
  factsHash:effectHash(eventPlanFacts([event(name)])),summary:"Prepare for the parade",
});
const taskId="event-plan:"+day;
type StoredTask={id:string;payload:Record<string,unknown>};

function database(initialTasks:StoredTask[]=[],existingMessages:string[]=[]){
  const tasks=new Map(initialTasks.map(t=>[t.id,t]));
  const messages=new Set(existingMessages);
  const taskWrites:Array<{row:Record<string,unknown>;options:Record<string,unknown>}>=[];
  const messageWrites:string[]=[];
  const db={
    from(table:string){
      if(table==="operating_tasks")return {
        select:(_columns:string)=>({
          eq:(_field:string,_value:string)=>({
            in:(_field:string,ids:string[])=>Promise.resolve({
              data:ids.flatMap(id=>tasks.has(id)?[tasks.get(id)!]:[]),error:null,
            }),
          }),
        }),
        upsert:async(row:Record<string,unknown>,options:Record<string,unknown>)=>{
          taskWrites.push({row,options});
          tasks.set(String(row.id),{id:String(row.id),payload:row.payload as Record<string,unknown>});
          return {error:null};
        },
      };
      if(table==="ai_messages")return {
        insert:async(row:Record<string,unknown>)=>{
          const id=String(row.id);
          if(messages.has(id))return {error:{code:"23505"}};
          messages.add(id);
          messageWrites.push(id);
          return {error:null};
        },
      };
      throw new Error("Unexpected table: "+table);
    },
  } as unknown as SupabaseClient;
  return {db,tasks,messages,taskWrites,messageWrites};
}

describe("event-day delivery recovery after an interrupted revision",()=>{
  it("repairs a missing message and day-keyed task once, with no duplicate on retry",async()=>{
    const store=database(),current=plan("Downtown parade","proposal-new");
    const args=[store.db,businessId,ownerId,today,[event("Downtown parade")],[current],1] as const;
    expect(await recoverPlanDelivery(...args)).toEqual({repaired:1,created:1});
    expect(store.messageWrites).toHaveLength(1);
    expect(store.tasks.get(taskId)?.payload.proposalId).toBe("proposal-new");
    expect(await recoverPlanDelivery(...args)).toEqual({repaired:0,created:0});
    expect(store.messageWrites).toHaveLength(1);
    expect(store.taskWrites).toHaveLength(1);
  });

  it("relinks an existing inbox item to revised facts even at the daily cap",async()=>{
    const previous=plan("Old parade time","proposal-old");
    const current=plan("Updated parade time","proposal-new");
    const oldMessageId=stableMessageId("event-plan-message:"+businessId+":"+ownerId+
      ":"+day+":"+previous.factsHash+":"+previous.proposalId);
    const store=database([{id:taskId,payload:{
      proposalId:previous.proposalId,threadId:previous.threadId,
      messageId:oldMessageId,plannedOn:"2026-10-29",
    }}],[oldMessageId]);
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Updated parade time")],[previous,current],0))
      .toEqual({repaired:1,created:0});
    const updated=store.tasks.get(taskId)?.payload;
    expect(updated).toMatchObject({
      proposalId:"proposal-new",threadId:"thread-one",
      plannedOn:"2026-10-29",needsApproval:true,
    });
    expect(updated?.messageId).not.toBe(oldMessageId);
    expect(store.messageWrites).toEqual([updated?.messageId]);
    expect(store.taskWrites[0].options).toEqual({onConflict:"business_id,id"});
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Updated parade time")],[previous,current],0))
      .toEqual({repaired:0,created:0});
    expect(store.taskWrites).toHaveLength(1);
  });

  it("completes a task update after the revised message already exists",async()=>{
    const current=plan("Updated parade time","proposal-new");
    const expectedId=stableMessageId("event-plan-message:"+businessId+":"+ownerId+
      ":"+day+":"+current.factsHash+":"+current.proposalId);
    const store=database([{id:taskId,payload:{
      proposalId:"proposal-old",threadId:"thread-one",
      messageId:"message-old",plannedOn:today,
    }}],[expectedId]);
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Updated parade time")],[current],0))
      .toEqual({repaired:1,created:0});
    expect(store.messageWrites).toEqual([]);
    expect(store.tasks.get(taskId)?.payload.messageId).toBe(expectedId);
  });

  it("uses only the newest draft when several proposals share a date and facts hash",async()=>{
    const newest=plan("Downtown parade","proposal-new");
    const older={...plan("Downtown parade","proposal-old"),threadId:"old-thread"};
    const oldMessageId=stableMessageId("event-plan-message:"+businessId+":"+ownerId+
      ":"+day+":"+older.factsHash+":"+older.proposalId);
    const newMessageId=stableMessageId("event-plan-message:"+businessId+":"+ownerId+
      ":"+day+":"+newest.factsHash+":"+newest.proposalId);
    expect(newMessageId).not.toBe(oldMessageId);
    const store=database([{id:taskId,payload:{
      proposalId:older.proposalId,threadId:older.threadId,
      messageId:oldMessageId,plannedOn:"2026-10-29",
    }}],[oldMessageId]);
    // The canonical owner-proposal reader returns newest-first.
    const plans=[newest,older];
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Downtown parade")],plans,0)).toEqual({repaired:1,created:0});
    expect(store.tasks.get(taskId)?.payload).toMatchObject({
      proposalId:"proposal-new",threadId:"thread-one",messageId:newMessageId,
    });
    expect(store.messageWrites).toEqual([newMessageId]);
    expect(store.taskWrites).toHaveLength(1);
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Downtown parade")],plans,0)).toEqual({repaired:0,created:0});
    expect(store.taskWrites).toHaveLength(1);
  });

  it("does not revive an older draft after a newer owner decision",async()=>{
    const latest={...plan("Downtown parade","proposal-decided"),status:"committed"};
    const old=plan("Downtown parade","proposal-old");
    const store=database([{id:taskId,payload:{
      proposalId:latest.proposalId,threadId:latest.threadId,
      messageId:"owner-approved-message",plannedOn:today,
    }}]);
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Downtown parade")],[latest,old],0))
      .toEqual({repaired:0,created:0});
    expect(store.taskWrites).toHaveLength(0);
    expect(store.messageWrites).toHaveLength(0);
  });

  it("does not create a new inbox day when no daily delivery capacity remains",async()=>{
    const store=database(),current=plan("Downtown parade","proposal-new");
    expect(await recoverPlanDelivery(store.db,businessId,ownerId,today,
      [event("Downtown parade")],[current],0))
      .toEqual({repaired:0,created:0});
    expect(store.taskWrites).toHaveLength(0);
    expect(store.messageWrites).toHaveLength(0);
  });
});
