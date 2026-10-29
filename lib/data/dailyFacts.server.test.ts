import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {readDailyFactRows,readDailyFacts,readCoveredSalesDates} from "./dailyFacts.server";
import {supervisorHistoricalReaders} from "@/lib/ai/supervisorReads.server";

/** A café with more saved days than one PostgREST page (1,000 rows). */
const start=Date.UTC(2023,0,1);
const day=(i:number)=>new Date(start+i*86400000).toISOString().slice(0,10);
const rows=Array.from({length:1205},(_,i)=>({business_date:day(i),net_sales_cents:1000+i,orders_count:i%50,
 drinks_count:0,ingredients_cents:0,staff_wages_cents:null,staff_tax_cents:null,labor_wage_status:"missing",
 staff_tax_status:"estimated",staff_tax_source:"default",sales_data_status:i%10===0?"missing":"actual",
 card_fees_cents:0,card_fees_status:"missing",voids_cents:0}));
function fakeDb(){
 const pages:number[][]=[];
 const from=(table:string)=>{
  const q:Record<string,unknown>={select:()=>q,eq:()=>q,gte:()=>q,lte:()=>q,order:()=>q,in:()=>q,like:()=>q,
   range:async(a:number,b:number)=>{
    if(table!=="daily_rollups")return {data:null,error:{message:"not in this fixture"}};
    pages.push([a,b]);return {data:rows.slice(a,b+1),error:null};},
   limit:async()=>({data:null,error:{message:"not in this fixture"}})};
  return q;
 };
 return {db:{from,rpc:async()=>({data:null,error:{message:"not in this fixture"}})} as unknown as SupabaseClient,pages};
}
describe("shared daily totals reader",()=>{
 it("reads every page in date order",async()=>{
  const f=fakeDb();
  const read=await readDailyFactRows(f.db,"cafe",day(0),day(1204));
  expect(read).toHaveLength(1205);
  expect(read.at(-1)?.business_date).toBe(day(1204));
  expect(f.pages).toEqual([[0,999],[1000,1999]]);
 });
 it("keeps only complete sales days for coverage",async()=>{
  const dates=await readCoveredSalesDates(fakeDb().db,"cafe",day(0),day(1204));
  expect(dates).toHaveLength(1205-121);
  expect(dates).not.toContain(day(0));
 });
 it("the chat's sales trend returns exactly the days and cents the screens read",async()=>{
  const screen=(await readDailyFacts(fakeDb().db,"cafe",day(0),day(1204)))
   .filter(d=>d.salesDataStatus==="actual");
  const chat=await supervisorHistoricalReaders(fakeDb().db,"cafe").salesTrend("cafe",{from:day(0),to:day(1204)});
  expect(chat.available).toBe(true);
  if(!chat.available)return;
  expect(chat.value.map(d=>[d.date,d.netSalesCents,d.ordersCount]))
   .toEqual(screen.map(d=>[d.date,d.netSalesCents,d.ordersCount]));
 });
});
