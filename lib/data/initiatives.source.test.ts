import {beforeEach,describe,expect,it,vi} from "vitest";
import {computeMetric} from "@/lib/calc/metrics/catalog";
import {readMetricDay} from "./initiatives.server";
const itemA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state=vi.hoisted(()=>({
  covered:true,unlinkedCount:0,
  sqlNetCents:1200,sqlOrderCount:1,sqlSyntheticCount:0,
  priceRows:[] as Array<{id:string;ingredient_id:string;effective_from:string;recorded_at:string;cost_per_base_unit_micros:number}>,
  ingredientIds:[] as string[],
  canonical:[] as Array<{id:string;units:number}>,
  lines:[] as Array<{id:string;order_id:string;menu_item_id:string|null;
    quantity:number;net_sales_cents:number;modifiers:unknown[]}>,
}));
vi.mock("./periodItemSales.server",()=>({
  readPeriodItemSales:async()=>({
    covered:state.covered,soldItems:state.canonical,
    period:{from:"2026-10-05",to:"2026-10-05"},
  }),
}));
vi.mock("@/lib/supabase/admin",()=>({
  createAdminSupabaseClient:()=>({
    rpc:()=>({single:async()=>({data:{order_count:state.sqlOrderCount,
      net_sales_cents:state.sqlNetCents,synthetic_count:state.sqlSyntheticCount},error:null})}),
    from:(table:string)=>{
      let head=false;
      let queryKind:"all"|"csv"|"missing"="all";
      const get=()=>{
        if(table==="daily_rollups")return [{
          business_date:"2026-10-05",net_sales_cents:1200,orders_count:1,
          drinks_count:1200,ingredients_cents:0,staff_wages_cents:0,
          staff_tax_cents:0,staff_tax_status:"estimated",
          sales_data_status:"actual",card_fees_cents:0,voids_cents:0,
        }];
        if(table==="orders")return [{id:"order-1",pos_order_id:"square:order-1",
          net_sales_cents:1200}];
        if(table==="order_lines")return state.lines;
        if(table==="menu_items")return [{id:itemA},{id:itemB}];
        if(table==="ingredients")return state.ingredientIds.map(id=>({id}));
        if(table==="ingredient_prices")return state.priceRows;
        if(table==="menu_item_cost_fallbacks")return [
          {menu_item_id:itemA,cost_cents:10},{menu_item_id:itemB,cost_cents:10},
        ];
        return [];
      };
      const result=()=>({data:head?null:get(),count:head?(table==="orders"?queryKind==="all"?get().length:0:state.unlinkedCount):null,error:null});
      const q:Record<string,unknown>={
        select:(_columns:string,opts?:{head?:boolean})=>{head=opts?.head===true;return q;},
        eq:()=>q,is:(column:string)=>{if(column==="pos_order_id")queryKind="missing";return q;},
        like:()=>{queryKind="csv";return q;},gte:()=>q,lte:()=>q,order:()=>q,in:()=>q,
        limit:(n:number)=>Promise.resolve({...result(),data:get().slice(0,n)}),
        range:(from:number,to:number)=>Promise.resolve({...result(),
          data:get().slice(from,to+1)}),
        maybeSingle:()=>Promise.resolve({data:get()[0]??null,error:null}),
        then:(ok:(value:ReturnType<typeof result>)=>unknown,
          fail?:(err:unknown)=>unknown)=>Promise.resolve(result()).then(ok,fail),
      };
      return q;
    },
  }),
}));
beforeEach(()=>{
  state.covered=true;state.unlinkedCount=0;
  state.sqlNetCents=1200;state.sqlOrderCount=1;state.sqlSyntheticCount=0;
  state.canonical.length=0;state.lines.length=0;
  state.priceRows.length=0;state.ingredientIds.length=0;
  for(let i=0;i<1200;i++)state.lines.push({
    id:String(i).padStart(8,"0"),order_id:"order-1",menu_item_id:i<1000?itemA:itemB,
    quantity:1,net_sales_cents:1,modifiers:[],
  });
  state.canonical.push({id:itemA,units:1000},{id:itemB,units:200});
});
describe("M1 canonical item evidence reader",()=>{
  it("collects every detailed line across the production 1000-row response cap",async()=>{
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],itemIds:[itemA,itemB],
    });
    expect(computeMetric("item_units",{itemId:itemA},day).value).toBe(1000);
    expect(computeMetric("item_units",{itemId:itemB},day).value).toBe(200);
    expect(day.itemRevenueVerified).toBe(true);
  });
  it("invalidates previously verified item participation when SQL quantities disagree",async()=>{
    state.lines.splice(1000);
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],itemIds:[itemA,itemB],
    });
    expect(day.items).toBeUndefined();
    expect(day.itemCoverageInvalidated).toBe(true);
    const result=computeMetric("item_units",{itemId:itemB},day);
    expect(result.value).toBeNull();
    expect(result.invalidatesPrevious).toBe(true);
  });
  it("distinguishes a confirmed unlinked line from transient coverage loss",async()=>{
    state.covered=false;state.unlinkedCount=1;
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],itemIds:[itemA,itemB],
    });
    expect(day.itemCoverageInvalidated).toBe(true);
    state.unlinkedCount=0;
    const unavailable=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],itemIds:[itemA,itemB],
    });
    expect(unavailable.itemCoverageInvalidated).toBe(false);
  });
  it("uses Pantry's latest same-day recorded price, not an arbitrary first row",async()=>{
    const ingredientId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    state.ingredientIds.push(ingredientId);
    state.priceRows.push({
      id:"11111111-1111-4111-8111-111111111111",
      ingredient_id:ingredientId,effective_from:"2026-10-05",
      recorded_at:"2026-10-05T12:00:00.100001Z",cost_per_base_unit_micros:100000,
    },{
      id:"22222222-2222-4222-8222-222222222222",
      ingredient_id:ingredientId,effective_from:"2026-10-05",
      recorded_at:"2026-10-05T12:00:00.100002Z",cost_per_base_unit_micros:150000,
    });
    const day=await readMetricDay("business","2026-10-05",{
      items:false,hours:false,ingredientIds:[ingredientId],
    });
    expect(computeMetric("ingredient_unit_cost",{ingredientId},day).value).toBe(150000);
  });
  it("rejects truncated rollup sales despite an actual status",async()=>{
    state.sqlNetCents=1500;state.sqlOrderCount=1200;
    const day=await readMetricDay("business","2026-10-05",{
      items:false,hours:false,ingredientIds:[],
    });
    expect(day.salesTotalCoverageVerified).toBe(false);
    expect(computeMetric("net_sales",{},day).coverage).toBe(0);
    expect(computeMetric("orders",{},day).value).toBeNull();
  });
  it("retains proven aggregate-only sales without inventing ticket counts",async()=>{
    state.sqlSyntheticCount=1;
    const day=await readMetricDay("business","2026-10-05",{
      items:false,hours:false,ingredientIds:[],
    });
    expect(computeMetric("net_sales",{},day).value).toBe(1200);
    expect(computeMetric("avg_ticket",{},day).value).toBeNull();
  });
  it("does not treat a foreign or deleted item id as covered zero",async()=>{
    const missingId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],itemIds:[missingId],
    });
    const result=computeMetric("item_units",{itemId:missingId},day);
    expect(result.value).toBeNull();
    expect(result.invalidatesPrevious).toBe(true);
  });
});
