import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readMenuComboCostComponents} from "./comboCosts.server";

const ids=Array.from({length:120},(_,i)=>"combo:"+String(i).padStart(3,"0"));
const rows=ids.flatMap(id=>Array.from({length:11},(_,j)=>({
 combo_item_id:id,component_item_id:"component:"+String(j).padStart(3,"0"),
 quantity:2,buy_in_cost_cents:4
})));
const fakeDb=(errorCode?:string)=>{
 const scope:string[]=[];let batch:string[]=[];let range={start:0,end:999};
 const db={from:vi.fn((name:string)=>{
  expect(name).toBe("menu_combo_components");
  const q={
   select:()=>q,
   eq:(key:string,val:string)=>{if(key==="business_id")scope.push(val);return q;},
   in:(_key:string,values:string[])=>{batch=values;return q;},
   order:()=>q,
   range:(start:number,end:number)=>{range={start,end};return q;},
   then:(resolve:(v:unknown)=>unknown)=>{
    const matching=rows.filter(row=>batch.includes(row.combo_item_id));
    const result=errorCode?{data:null,count:null,error:{code:errorCode}}:
      {data:matching.slice(range.start,range.end+1),count:matching.length,error:null};
    return Promise.resolve(result).then(resolve);
   }
  };return q;
 })};
 return {db:db as unknown as SupabaseClient,scope};
};

describe("complete menu combo composition",()=>{
 it("reads all rows beyond the 1000-row transport cap without losing any ingredient",async()=>{
  const {db,scope}=fakeDb();
  const result=await readMenuComboCostComponents(db,"cafe-a",ids);
  expect(result).toHaveLength(1320);
  expect(result[1319]).toMatchObject({comboItemId:"combo:119",
    componentItemId:"component:010",quantity:2,buyInCostCents:4});
  expect(scope.every(id=>id==="cafe-a")).toBe(true);
  expect(scope.length).toBe(3);
 });
 it("allows only the documented additive absent-schema fallback",async()=>{
  expect(await readMenuComboCostComponents(fakeDb("42P01").db,"cafe-a",ids))
    .toEqual([]);
  await expect(readMenuComboCostComponents(fakeDb("57014").db,"cafe-a",ids))
    .rejects.toThrow("Could not load the full scoped menu combo composition");
 });
});
