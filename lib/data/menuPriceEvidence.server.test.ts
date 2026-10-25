import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({createServerSupabaseClient:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mocks.createServerSupabaseClient}));
import {readMenuPriceEvidence} from "./menuPriceEvidence.server";

type RecordCall={table:string;method:string;args:unknown[]};
function database(pages:number,shortLastPage:boolean){
 const calls:RecordCall[]=[];
 const makeQuery=(table:string)=>{
  const q:Record<string,unknown>={};
  const chain=new Proxy(q,{get(_target,method:string){
   if(method==="then")return undefined;
   return (...args:unknown[])=>{
    calls.push({table,method,args});
    if(method==="maybeSingle")return Promise.resolve({data:{business_date:"2026-10-24"},error:null});
    if(method==="range"){
      const page=Math.floor((args[0] as number)/1000);
      return Promise.resolve({data:page<pages-1||!shortLastPage?
        Array.from({length:1000},(_,i)=>({menu_item_id:"latte",net_sales_cents:500,quantity:1,id:String(page*1000+i)})):
        [{menu_item_id:"latte",net_sales_cents:500,quantity:1,id:"last"}],error:null});
    }
    return chain;
   };
  }});
  return chain;
 };
 // menu tables resolve when awaited. Keep order_lines chainable through range().
 const from=(table:string)=>{
  if(table==="order_lines")return makeQuery(table);
  const data=table==="menu_price_history"?[]:table==="menu_items"?[{id:"latte",catalog_source:"csv"}]:[];
  const q:Record<string,unknown>={};
  const proxy=new Proxy(q,{get(_target,method:string){
    if(method==="then")return (resolve:(result:unknown)=>unknown)=>resolve({data,error:null});
    return (...args:unknown[])=>{
      calls.push({table,method,args});
      if(method==="maybeSingle")return Promise.resolve({data:{business_date:"2026-10-24"},error:null});
      return proxy;
    };
  }});
  return proxy;
 };
 return {calls,from};
}
beforeEach(()=>{vi.clearAllMocks();});
describe("realized menu price query contract",()=>{
 it("constrains every paged order-line read to active orders for the selected cafe",async()=>{
  const db=database(1,true);mocks.createServerSupabaseClient.mockResolvedValue(db);
  const result=await readMenuPriceEvidence("cafe-one",[{id:"latte",priceCents:500}],"2026-10-24");
  const order=db.calls.filter(call=>call.table==="order_lines");
  expect(order).toEqual(expect.arrayContaining([
   expect.objectContaining({method:"eq",args:["orders.business_id","cafe-one"]}),
   expect.objectContaining({method:"eq",args:["orders.toast_excluded",false]}),
   expect.objectContaining({method:"is",args:["orders.superseded_by",null]}),
   expect.objectContaining({method:"eq",args:["voided",false]}),
   expect.objectContaining({method:"gte",args:["orders.business_date","2026-09-25"]}),
   expect.objectContaining({method:"lte",args:["orders.business_date","2026-10-24"]}),
  ]));
  expect(result.latte).toMatchObject({priceEvidenceStatus:"actual",priceCheck:"ok",realizedAvgCents:500});
 });
 it("does not treat MAX_PAGES of full results as a complete observed average",async()=>{
  const db=database(10,false);mocks.createServerSupabaseClient.mockResolvedValue(db);
  const result=await readMenuPriceEvidence("cafe-one",[{id:"latte",priceCents:500}],"2026-10-24");
  const ranges=db.calls.filter(call=>call.table==="order_lines"&&call.method==="range");
  expect(ranges).toHaveLength(10);
  expect(ranges[0].args).toEqual([0,999]);
  expect(ranges[9].args).toEqual([9000,9999]);
  expect(result.latte).toMatchObject({priceEvidenceStatus:"partial",priceCheck:"unknown",realizedAvgCents:null});
 });
});
