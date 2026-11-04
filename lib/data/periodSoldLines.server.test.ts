import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const cover=vi.hoisted(()=>({covered:true}));
vi.mock("./dailyFacts.server",()=>({readCoveredSalesDates:async()=>["2026-11-02"]}));
vi.mock("@/lib/ai/supervisorFacts.server",()=>({resolveItemSalesCoverage:()=>({covered:cover.covered})}));
import {readPeriodSoldLines} from "./periodItemSales.server";

const period={from:"2026-11-02",to:"2026-11-02"};
function db(lines:unknown[],quantities:unknown[]=[{menu_item_id:"latte",total_quantity:"4.0"}]){
  const filters:Array<[string,string,unknown]>=[];
  const chain=(table:string)=>{
    const q:Record<string,unknown>={};
    for(const m of ["select","order"])q[m]=()=>q;
    for(const m of ["eq","is","gte","lte"])q[m]=(k:string,v:unknown)=>{filters.push([m,k,v]);return q;};
    q.range=async()=>({data:lines,error:null});
    q.then=(r:(v:unknown)=>unknown)=>Promise.resolve({data:table==="pos_connections"?[{provider:"toast"}]:[],error:null}).then(r);
    return q;
  };
  return {client:{from:chain,rpc:vi.fn(async()=>({data:quantities,error:null}))} as unknown as SupabaseClient,filters};
}
describe("brief sold lines: unlinked lines counted by POS name",()=>{
  it("keeps linked RPC quantities and adds unlinked lines by name, same order filters as the RPC",async()=>{
    const d=db([{id:"1",name:"Jubani Coffee",category:"Traditional",quantity:"2"},
      {id:"2",name:"Jubani Coffee",category:"Traditional",quantity:1},{id:"3",name:"Water",category:null,quantity:0}]);
    expect(await readPeriodSoldLines(d.client,"cafe-a",period)).toEqual({period,available:true,
      linked:[{id:"latte",units:4}],unlinked:[{name:"Jubani Coffee",category:"Traditional",units:3}]});
    expect(d.filters).toEqual(expect.arrayContaining([["is","menu_item_id",null],["eq","voided",false],
      ["eq","orders.business_id","cafe-a"],["eq","orders.toast_excluded",false],["is","orders.superseded_by",null],
      ["gte","orders.business_date","2026-11-02"],["lte","orders.business_date","2026-11-02"]]));
  });
  it("an uncovered day or malformed line is 'not available', never a guess",async()=>{
    expect((await readPeriodSoldLines(db([{id:"1",name:"",category:null,quantity:1}]).client,"cafe-a",period)).available).toBe(false);
    cover.covered=false;
    expect(await readPeriodSoldLines(db([]).client,"cafe-a",period)).toEqual({period,available:false,linked:[],unlinked:[]});
    cover.covered=true;
  });
});
