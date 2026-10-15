import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({client:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mocks.client}));
vi.mock("@/lib/data/getMenuItemsForEdit",()=>({getMenuItemsForEdit:vi.fn()}));
vi.mock("@/lib/scheduling/foundation.server",()=>({readSchedulingFoundation:vi.fn()}));
import {readP1TaskPage,readP1DecisionPage} from "./p1Additional.server";

const rows=Array.from({length:41},(_,i)=>({
  id:"task-"+String(i).padStart(3,"0"),business_id:"cafe-1",agent_id:"alex",
  kind:"price_review",status:"handled",created_at:"2026-10-01T12:00:00Z",
  resolved_at:null,payload:{privatePayroll:"DO_NOT_LEAK"},evidence:[{source:"secret"}],
}));
let result:{data:typeof rows|null;error:unknown};
const range=vi.fn(async()=>result);
const order=vi.fn(()=>({order,range}));
const eq=vi.fn(()=>({order}));
const select=vi.fn(()=>({eq}));
const from=vi.fn(()=>({select}));
beforeEach(()=>{
  vi.clearAllMocks();
  result={data:rows,error:null};
  mocks.client.mockResolvedValue({from});
});
describe("P1 bounded deterministic Team task pages",()=>{
  it("applies tenant filter and hard 41-row query budget before receiving data",async()=>{
    const page=await readP1TaskPage({businessId:"cafe-1"});
    expect(from).toHaveBeenCalledWith("operating_tasks");
    expect(select).toHaveBeenCalledWith("id,business_id,agent_id,kind,status,created_at,resolved_at");
    expect(eq).toHaveBeenCalledWith("business_id","cafe-1");
    expect(order).toHaveBeenCalledWith("created_at",{ascending:false});
    expect(order).toHaveBeenCalledWith("id",{ascending:false});
    expect(range).toHaveBeenCalledWith(0,40);
    expect(page).toMatchObject({available:true,value:{page:0,hasMore:true,nextPage:1}});
    expect(page.available&&page.value.items).toHaveLength(40);
    expect(JSON.stringify(page)).not.toContain("privatePayroll");
    expect(JSON.stringify(page)).not.toContain("DO_NOT_LEAK");
  });
  it("uses stable page offsets and accurately distinguishes end of history",async()=>{
    result={data:rows.slice(0,11),error:null};
    const page=await readP1TaskPage({businessId:"cafe-1"},2);
    expect(range).toHaveBeenCalledWith(80,120);
    expect(page).toMatchObject({available:true,value:{page:2,hasMore:false,nextPage:null}});
  });
  it("fails closed on cross-tenant rows and incomplete remote query",async()=>{
    result={data:[{...rows[0],business_id:"other-cafe"}],error:null};
    expect(await readP1TaskPage({businessId:"cafe-1"}))
      .toMatchObject({available:false,value:null});
    result={data:null,error:{code:"PGRST_ERROR"}};
    expect(await readP1TaskPage({businessId:"cafe-1"}))
      .toMatchObject({available:false,value:null});
  });
  it("reports terminal page limit truthfully when more history exists",async()=>{
    const tasks=await readP1TaskPage({businessId:"cafe-1"},250);
    expect(range).toHaveBeenCalledWith(10000,10040);
    expect(tasks).toMatchObject({available:true,value:{
      page:250,hasMore:true,nextPage:null,limitReached:true,
    }});
    const decisions=await readP1DecisionPage({businessId:"cafe-1"},250);
    expect(decisions).toMatchObject({available:true,value:{
      page:250,hasMore:true,nextPage:null,limitReached:true,
    }});
    expect(tasks.available && tasks.quality.missingInputs).toContain("task_inbox_page_only");
  });
  it("rejects invalid pages before accessing the database",async()=>{
    expect(await readP1TaskPage({businessId:"cafe-1"},-1)).toMatchObject({available:false});
    expect(await readP1TaskPage({businessId:"cafe-1"},999)).toMatchObject({available:false});
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("bounds decision history and strips all private decision provenance",async()=>{
    result={data:rows.map((row,i)=>({
      ...row,id:"decision-"+i,type:"PRICE_CHANGE",confidence:"high",
      recommendation:{password:"not-for-p1"},provenance:{workerWage:12345},
    })),error:null} as unknown as typeof result;
    const r=await readP1DecisionPage({businessId:"cafe-1"});
    expect(from).toHaveBeenCalledWith("cafe_decisions");
    expect(select).toHaveBeenCalledWith("id,business_id,type,status,confidence,created_at");
    expect(range).toHaveBeenCalledWith(0,40);
    expect(r).toMatchObject({available:true,value:{hasMore:true,nextPage:1}});
    expect(JSON.stringify(r)).not.toContain("workerWage");
    expect(JSON.stringify(r)).not.toContain("password");
  });

});
