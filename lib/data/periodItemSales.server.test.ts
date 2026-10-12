import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {readPeriodItemSales} from "./periodItemSales.server";
import type {SupabaseClient} from "@supabase/supabase-js";

const period={from:"2026-10-01",to:"2026-10-12"};
type Connection={provider:string;last_synced_at:string|null;backfill_completed_at:string|null};
const square:Connection={provider:"square",last_synced_at:"2026-10-12T19:00:00Z",
  backfill_completed_at:"2026-10-12T19:00:00Z"};
function db(connections:Connection[],quantities:unknown[]=[],failure=false,unlinkedCount=0){
  const eqs:Array<[string,unknown]>=[];
  const chain={
    select:()=>chain,
    eq:(key:string,value:unknown)=>{eqs.push([key,value]);return chain;},
    then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({
      data:connections,error:null,
    }).then(resolve),
  };
  const unlinked={
    select:()=>unlinked,is:()=>unlinked,eq:()=>unlinked,
    gte:()=>unlinked,lte:()=>unlinked,
    then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({count:unlinkedCount,error:null}).then(resolve),
  };
  const rpc=vi.fn(async(name:string,args:unknown)=>({
    data:quantities,error:failure?{message:"unavailable"}:null,
  }));
  const client=({from:(table:string)=>{
      expect(["pos_connections","order_lines"]).toContain(table);
      return table==="pos_connections"?chain:unlinked;
    },rpc} as unknown as SupabaseClient);
  return {client,rpc,eqs};
}
describe("Exact-period invoker-RLS item sales coverage, no migration",()=>{
  it("uses existing business-scoped RPC with requested period, preserving archived IDs",async()=>{
    const d=db([square],[{menu_item_id:"archived-product",total_quantity:"2.0"}]);
    const result=await readPeriodItemSales(d.client,"authorized-business",period);
    expect(result).toEqual({period,covered:true,soldItems:[{id:"archived-product",units:2}]});
    expect(d.rpc).toHaveBeenCalledWith("menu_item_quantities_sold",{
      p_business_id:"authorized-business",p_from:"2026-10-01",p_to:"2026-10-12",
    });
    expect(d.eqs).toContainEqual(["business_id","authorized-business"]);
    expect(d.eqs).toContainEqual(["status","active"]);
  });
  it("only uses this period; September sales cannot enter an October RPC",async()=>{
    const d=db([square],[{menu_item_id:"october-item",total_quantity:3}]);
    await readPeriodItemSales(d.client,"authorized-business",period);
    const call=d.rpc.mock.calls[0][1] as {p_from:string;p_to:string};
    expect(call.p_from).toBe("2026-10-01");
    expect(call.p_to).toBe("2026-10-12");
  });
  it.each(["csv","toast","demo","clover"])("does not infer %s item coverage",async provider=>{
    const d=db([{...square,provider}],[{menu_item_id:"item",total_quantity:2}]);
    const result=await readPeriodItemSales(d.client,"authorized-business",period);
    expect(result).toMatchObject({covered:false,soldItems:[]});
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it("unproven Square backfill remains unavailable",async()=>{
    const d=db([{...square,backfill_completed_at:null}]);
    expect((await readPeriodItemSales(d.client,"b",period)).covered).toBe(false);
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it("mixed linked and unlinked order lines never prove complete item costs",async()=>{
    const d=db([square],[{menu_item_id:"linked",total_quantity:2}],false,1);
    expect((await readPeriodItemSales(d.client,"b",period)).covered).toBe(false);
  });
  it("RPC errors, unlinked rows and truncated results never become proof",async()=>{
    for(const [rows,error] of [
      [[{menu_item_id:null,total_quantity:5}],false],
      [[{menu_item_id:"item",total_quantity:"not-a-number"}],false],
      [[{menu_item_id:"item",total_quantity:1}],true],
      [Array.from({length:1000},(_,i)=>({menu_item_id:"item"+i,total_quantity:1})),false],
    ] as const){
      const d=db([square],rows as unknown[],error);
      expect((await readPeriodItemSales(d.client,"b",period)).covered).toBe(false);
    }
  });
  it("successful complete zero item RPC is evidence of zero participation, not a missing cost",async()=>{
    const d=db([square],[]);
    const result=await readPeriodItemSales(d.client,"b",period);
    expect(result).toEqual({period,covered:true,soldItems:[]});
  });
});
