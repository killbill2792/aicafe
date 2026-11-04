import {beforeEach,describe,expect,it,vi} from "vitest";
import type {OperatingTask} from "@/lib/operating/tasks";

const state=vi.hoisted(()=>({rows:new Map<string,Record<string,unknown>>(),upserts:0,derived:[] as OperatingTask[]}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>"cafe"}));
vi.mock("@/lib/data/getSnapshot",()=>({getSnapshot:async()=>({})}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:async()=>[]}));
vi.mock("@/lib/viewmodels/operationsTeam",()=>({buildOperationsTeamViewModel:()=>({needsYou:state.derived,handled:[],watching:[]})}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
  from:(table:string)=>{
    let id="";
    const q:Record<string,unknown>={};
    q.select=()=>q;
    q.eq=(column:string,value:string)=>{if(column==="id")id=value;return q;};
    q.in=()=>q;
    q.maybeSingle=async()=>table==="operating_tasks"?{data:state.rows.get(id)??null,error:null}:{data:{id:"r"},error:null};
    q.single=async()=>({data:{id:"response-1"},error:null});
    q.insert=()=>q;
    q.delete=()=>q;
    q.upsert=async(row:Record<string,unknown>,opts:{ignoreDuplicates?:boolean})=>{
      state.upserts++;
      if(!opts.ignoreDuplicates)throw new Error("must not overwrite");
      if(!state.rows.has(String(row.id)))state.rows.set(String(row.id),row);
      return {error:null};
    };
    q.update=(patch:Record<string,unknown>)=>{
      const self={eq:(c:string,v:string)=>{if(c==="id")id=v;return self;},
        select:()=>self,maybeSingle:async()=>{state.rows.set(id,{...state.rows.get(id),...patch});return {data:{id},error:null};}};
      return self;
    };
    return q;
  },
})}));

import {respondToPriceReview} from "./operatingTasks";

const review:OperatingTask={id:"price:latte:500:560",businessId:"cafe",agentId:"alex",kind:"price_review",entityType:"menu_item",
  entityId:"latte",status:"needs_owner",payload:{itemName:"Latte",currentPriceCents:500,suggestedPriceCents:560},
  confidence:"high",evidence:[],createdAt:"2026-11-04T10:00:00Z"};
beforeEach(()=>{state.rows.clear();state.upserts=0;state.derived=[review];});

describe("price review decision on an item the inbox computed on read",()=>{
  it("stores the item once on the owner's click, then records the decision",async()=>{
    expect(await respondToPriceReview({taskId:review.id,decision:"keep_price"})).toEqual({ok:true});
    expect(state.upserts).toBe(1);
    expect(state.rows.get(review.id)).toMatchObject({id:review.id,business_id:"cafe",status:"handled"});
  });
  it("refuses an id the inbox does not show and writes nothing",async()=>{
    expect(await respondToPriceReview({taskId:"price:other:1:2",decision:"keep_price"})).toEqual({ok:false,error:"task_not_available"});
    expect(state.upserts).toBe(0);
  });
});
