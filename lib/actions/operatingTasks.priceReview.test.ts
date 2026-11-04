import {beforeEach,describe,expect,it,vi} from "vitest";
import type {OperatingTask} from "@/lib/operating/tasks";
import {settleInboxTasks} from "@/lib/operating/inboxLifecycle";
import {projectOperatingTasks} from "@/lib/viewmodels/operationsTeam";

type Row=Record<string,unknown>&{id:string;status:string};
const state=vi.hoisted(()=>({rows:new Map<string,Record<string,unknown>&{id:string;status:string}>(),upserts:0,
  conditionalUpdates:[] as {id:string;whereStatus:unknown;to:unknown}[],derived:[] as OperatingTask[]}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>"cafe"}));
const fromRow=(r:Row):OperatingTask=>({id:r.id,businessId:"cafe",agentId:"alex",kind:"price_review",entityType:"menu_item",
  entityId:String(r.entity_id),status:r.status as OperatingTask["status"],payload:r.payload as OperatingTask["payload"],
  confidence:"high",evidence:[],createdAt:String(r.created_at),...(r.resolved_at?{resolvedAt:String(r.resolved_at)}:{})});
// The real inbox lifecycle over the stored rows and today's computed reviews: what the Inbox shows.
vi.mock("@/lib/attention/getAttentionItems.server",()=>({readInbox:async()=>{
  const team=projectOperatingTasks(settleInboxTasks([...state.rows.values()].map(fromRow),state.derived,new Date(),
    new Date().toISOString().slice(0,10)));
  return {items:[],expiredAlerts:[],tasks:{needsYou:team.needsYou,watching:team.watching,handled:team.handled}};
}}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
  from:(table:string)=>{
    let id="";
    const q:Record<string,unknown>={};
    q.select=()=>q;
    q.eq=(column:string,value:string)=>{if(column==="id")id=value;return q;};
    q.maybeSingle=async()=>({data:table==="operating_tasks"?state.rows.get(id)??null:{id:"r"},error:null});
    q.single=async()=>({data:{id:"response-1"},error:null});
    q.insert=()=>q;
    q.delete=()=>q;
    q.upsert=async(row:Row,opts:{ignoreDuplicates?:boolean})=>{
      state.upserts++;
      if(!opts.ignoreDuplicates)throw new Error("must not overwrite");
      if(!state.rows.has(row.id))state.rows.set(row.id,row);
      return {error:null};
    };
    q.update=(patch:Row)=>{
      const where:Record<string,unknown>={};
      const apply=()=>{
        const current=state.rows.get(String(where.id));
        if(!current||("status" in where&&current.status!==where.status))return null;
        state.rows.set(current.id,{...current,...patch});
        return current.id;
      };
      const self={eq:(c:string,v:string)=>{where[c]=v;return self;},select:()=>self,
        maybeSingle:async()=>{const updated=apply();return {data:updated?{id:updated}:null,error:null};},
        then:(done:(v:unknown)=>void)=>{
          if(patch.status==="needs_owner")state.conditionalUpdates.push({id:String(where.id),whereStatus:where.status,to:patch.status});
          apply();done({error:null});
        }};
      return self;
    };
    return q;
  },
})}));

import {respondToPriceReview} from "./operatingTasks";

const now=Date.now();
const iso=(daysAgo:number)=>new Date(now-daysAgo*86_400_000).toISOString();
const review=(over:Partial<OperatingTask>={}):OperatingTask=>({id:"price:latte:500:560",businessId:"cafe",agentId:"alex",kind:"price_review",
  entityType:"menu_item",entityId:"latte",status:"needs_owner",payload:{itemName:"Latte",currentPriceCents:500,suggestedPriceCents:560},
  confidence:"high",evidence:[],createdAt:iso(0),...over});
const store=(t:OperatingTask)=>state.rows.set(t.id,{id:t.id,business_id:"cafe",agent_id:"alex",kind:"price_review",
  entity_type:"menu_item",entity_id:t.entityId,confidence:"high",evidence:[],status:t.status,payload:t.payload,
  created_at:t.createdAt,resolved_at:t.resolvedAt??null});
beforeEach(()=>{state.rows.clear();state.upserts=0;state.conditionalUpdates=[];state.derived=[review()];});

describe("price review decisions use what the Inbox shows",()=>{
  it("stores a computed review once on the owner's click, then records the decision",async()=>{
    expect(await respondToPriceReview({taskId:"price:latte:500:560",decision:"keep_price"})).toEqual({ok:true});
    expect(state.upserts).toBe(1);
    expect(state.rows.get("price:latte:500:560")).toMatchObject({status:"handled"});
  });

  for(const decision of ["keep_price","later_7"] as const){
    it(`accepts ${decision} on a review whose 7-day snooze has expired (stored row still watching)`,async()=>{
      store(review({status:"watching",createdAt:iso(10),payload:{itemName:"Latte",currentPriceCents:500,suggestedPriceCents:560,
        snoozeMode:"later_7",snoozeUntil:iso(1)}}));
      expect(await respondToPriceReview({taskId:"price:latte:500:560",decision})).toEqual({ok:true});
      expect(state.conditionalUpdates).toEqual([{id:"price:latte:500:560",whereStatus:"watching",to:"needs_owner"}]);
      expect(state.rows.get("price:latte:500:560")?.status).toBe(decision==="keep_price"?"handled":"watching");
      expect(state.upserts).toBe(0);
    });

    it(`accepts ${decision} on a review whose 30-day keep-price cooldown has ended (stored row handled)`,async()=>{
      store(review({status:"handled",createdAt:iso(40),resolvedAt:iso(31),payload:{itemName:"Latte",currentPriceCents:500,
        suggestedPriceCents:560,ownerChoice:"keep_price",awaitingPriceApplication:false,priceAppliedToPos:false}}));
      expect(await respondToPriceReview({taskId:"price:latte:500:560",decision})).toEqual({ok:true});
      expect(state.conditionalUpdates).toEqual([{id:"price:latte:500:560",whereStatus:"handled",to:"needs_owner"}]);
    });
  }

  it("still refuses a review inside its snooze, and an id the Inbox does not show",async()=>{
    store(review({status:"watching",payload:{itemName:"Latte",currentPriceCents:500,suggestedPriceCents:560,
      snoozeMode:"later_7",snoozeUntil:new Date(now+3*86_400_000).toISOString()}}));
    expect(await respondToPriceReview({taskId:"price:latte:500:560",decision:"keep_price"})).toEqual({ok:false,error:"task_not_available"});
    expect(await respondToPriceReview({taskId:"price:other:1:2",decision:"keep_price"})).toEqual({ok:false,error:"task_not_available"});
    expect(state.conditionalUpdates).toEqual([]);
    expect(state.upserts).toBe(0);
  });
});
