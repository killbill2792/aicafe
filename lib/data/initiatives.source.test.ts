import {beforeEach,describe,expect,it,vi} from "vitest";
import {computeMetric} from "@/lib/calc/metrics/catalog";
import {readMetricDay} from "./initiatives.server";
const itemA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state=vi.hoisted(()=>({
  covered:true,unlinkedCount:0,
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
    from:(table:string)=>{
      let head=false;
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
        if(table==="menu_item_cost_fallbacks")return [
          {menu_item_id:itemA,cost_cents:10},{menu_item_id:itemB,cost_cents:10},
        ];
        return [];
      };
      const result=()=>({data:head?null:get(),count:head?state.unlinkedCount:null,error:null});
      const q={
        select:(_columns:string,opts?:{head?:boolean})=>{head=opts?.head===true;return q;},
        eq:()=>q,is:()=>q,gte:()=>q,lte:()=>q,order:()=>q,in:()=>q,
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
  state.canonical.length=0;state.lines.length=0;
  for(let i=0;i<1200;i++)state.lines.push({
    id:String(i).padStart(8,"0"),order_id:"order-1",menu_item_id:i<1000?itemA:itemB,
    quantity:1,net_sales_cents:1,modifiers:[],
  });
  state.canonical.push({id:itemA,units:1000},{id:itemB,units:200});
});
describe("M1 canonical item evidence reader",()=>{
  it("collects every detailed line across the production 1000-row response cap",async()=>{
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],
    });
    expect(computeMetric("item_units",{itemId:itemA},day).value).toBe(1000);
    expect(computeMetric("item_units",{itemId:itemB},day).value).toBe(200);
    expect(day.itemRevenueVerified).toBe(true);
  });
  it("invalidates previously verified item participation when SQL quantities disagree",async()=>{
    state.lines.splice(1000);
    const day=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],
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
      items:true,hours:false,ingredientIds:[],
    });
    expect(day.itemCoverageInvalidated).toBe(true);
    state.unlinkedCount=0;
    const unavailable=await readMetricDay("business","2026-10-05",{
      items:true,hours:false,ingredientIds:[],
    });
    expect(unavailable.itemCoverageInvalidated).toBe(false);
  });
});
