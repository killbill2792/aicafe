import {describe,expect,it} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readStagedSalesGroups,readCsvFeeOrders,csvPromotedOrderId} from "./finalizeReads";

function fakeTable(
 name:string,
 fixture:Record<string,unknown>[],
 failAt?:number,
) {
 const requests:Array<{table:string,first:number,last:number,orders:string[],filters:Record<string,unknown>}>=[];
 const db={from:(table:string)=>{
   const orders:string[]=[];
   const filters:Record<string,unknown>={};
   const query={
     select:()=>query,
     eq:(key:string,value:unknown)=>{filters[key]=value;return query;},
     is:(key:string,value:unknown)=>{filters[key]=value;return query;},
     order:(key:string)=>{orders.push(key);return query;},
     range:async(first:number,last:number)=>{
       requests.push({table,first,last,orders:[...orders],filters:{...filters}});
       if(table!==name)throw new Error("Wrong table queried");
       if(failAt===first)return {data:null,error:new Error("simulated page failure")};
       return {data:fixture.slice(first,last+1),error:null};
     },
   };
   return query;
 }} as unknown as SupabaseClient;
 return {db,requests};
}
describe("CSV finalizer reads all evidence before claiming completion",()=>{
 it("matches SQL LEFT character truncation for emoji near the 120-character cutoff",()=>{
   const prefix="csv-2026-08-22-";
   const item="a".repeat(103)+"💛"+"b".repeat(40);
   const key=csvPromotedOrderId("2026-08-22",item,null);
   expect(Array.from(key)).toHaveLength(120);
   expect(key).toBe(prefix+"a".repeat(103)+"💛"+"b");
   expect(key.length).toBe(121);
   expect(key).not.toBe((prefix+item).slice(0,120));
 });
 it("distinguishes SQL NULL and empty-string CSV categories",()=>{
   expect(csvPromotedOrderId("2026-08-22","Tea",null)).toBe("csv-2026-08-22-Tea");
   expect(csvPromotedOrderId("2026-08-22","Tea","")).toBe("csv-2026-08-22-Tea|");
   expect(csvPromotedOrderId("2026-08-22","Tea","Hot")).toBe("csv-2026-08-22-Tea|Hot");
 });
 it("fetches all 1,205 staged groups with scoped, ordered pagination",async()=>{
   const rows=Array.from({length:1205},(_,i)=>({
     business_date:"2026-08-22",item_name:"Latte-"+i,
     category:"Category-"+i,menu_item_id:null,source_row_count:1,conflict_reason:null
   }));
   const {db,requests}=fakeTable("csv_sales_import_groups",rows);
   const result=await readStagedSalesGroups(db,"business","job");
   expect(result).toHaveLength(1205);
   expect(result[1204].category).toBe("Category-1204");
   expect(requests.map(({first,last})=>[first,last])).toEqual([[0,499],[500,999],[1000,1499]]);
   expect(requests.every(r=>r.orders.includes("id")&&r.filters.job_id==="job"&&r.filters.business_id==="business")).toBe(true);
 });
 it("rejects a missing page rather than silently finalizing incomplete groups",async()=>{
   const rows=Array.from({length:1205},()=>({business_date:"2026-08-22",item_name:"Tea",category:"Hot"}));
   const {db}=fakeTable("csv_sales_import_groups",rows,1000);
   await expect(readStagedSalesGroups(db,"business","job")).rejects.toThrow("Incomplete POS read");
 });
 it("does not truncate fee evidence for a 1,201-group CSV import",async()=>{
   const rows=Array.from({length:1201},()=>({processing_fee_cents:5,processing_fee_status:"actual"}));
   const {db,requests}=fakeTable("orders",rows);
   const result=await readCsvFeeOrders(db,"business","2026-08-22");
   expect(result.reduce((sum,order)=>sum+Number(order.processing_fee_cents),0)).toBe(6005);
   expect(result).toHaveLength(1201);
   expect(requests.every(r=>r.filters.processing_fee_provider==="csv"&&r.filters.toast_excluded===false&&
     r.filters.superseded_by===null&&r.orders.includes("id"))).toBe(true);
 });
});
