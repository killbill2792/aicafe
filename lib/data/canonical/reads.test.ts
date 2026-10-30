import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {readCanonicalView,readLaborEntriesMissingWage,readSalesDays,readStaff} from "./reads.server";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const range={dateFrom:"2026-10-01",dateTo:"2026-10-31"};
function db(rows:Record<string,unknown>[]=[],err:unknown=null){
 const calls:Array<[string,unknown]>=[];let table="";
 const query={
  select(_s:string){return query;},
  eq(k:string,v:unknown){calls.push([k,v]);return query;},
  gte(k:string,v:string){calls.push([">="+k,v]);return query;},
  lte(k:string,v:string){calls.push(["<="+k,v]);return query;},
  order(){return query;},
  limit(n:number){calls.push(["limit",n]);return Promise.resolve({data:rows,error:err});}
 };
 return {client:{from(t:string){table=t;return query;}} as never,calls,get table(){return table;}};
}
describe("canonical authenticated read path",()=>{
 it("always scopes daily sales by café and date",async()=>{
  const x=db([{business_id:business,source_ref:"rollup:1"}]);
  const result=await readSalesDays(x.client,business,range);
  expect(result.empty).toBe(false);
  expect(x.table).toBe("cv_sales_days");
  expect(x.calls).toContainEqual(["business_id",business]);
  expect(x.calls).toContainEqual([">=business_date",range.dateFrom]);
  expect(x.calls).toContainEqual(["<=business_date",range.dateTo]);
 });
 it("filters labor to shifts with no wage before the limit",async()=>{
  const x=db([{source_ref:"timecard:1",status:"needs_match"}]);
  const result=await readLaborEntriesMissingWage(x.client,business,range,20);
  expect(x.table).toBe("cv_labor_entries");
  expect(x.calls).toContainEqual(["status","needs_match"]);
  expect(x.calls).toContainEqual(["limit",21]);
  expect(result.rowCount).toBe(1);
 });
 it("does not hide undated staff facts behind a date filter",async()=>{
  const x=db([{source_ref:"staff:1"}]);await readStaff(x.client,business,range);
  expect(x.calls.some(([key])=>key===">=business_date")).toBe(false);
 });
 it("rejects invented views and invalid dates before a database read",async()=>{
  const x=db();
  const bad=await readCanonicalView(x.client,business,"private_secrets" as never,range);
  expect(bad.error).toBe("invalid_scope");
  expect(x.calls).toHaveLength(0);
  const badDate=await readSalesDays(x.client,business,{dateFrom:"2026-10-31",dateTo:"2026-10-01"});
  expect(badDate.error).toBe("invalid_range");
 });
 it("reports a truncated result, and never turns errors into zero",async()=>{
  const x=db(Array.from({length:201},(_,i)=>({source_ref:String(i)})));
  const res=await readSalesDays(x.client,business,range);
  expect(res.truncated).toBe(true);expect(res.rows).toHaveLength(200);
  const f=db([],{message:"private details"});
  const fail=await readSalesDays(f.client,business,range);
  expect(fail.error).toBe("source_read_failed");
  expect(fail.notes).toEqual(["source_read_failed"]);
 });
});

it("filters dated labor, shifts and inventory by café-local business dates",async()=>{
 for(const view of ["cv_labor_entries","cv_shifts","cv_inventory"] as const){
  const x=db([]);
  await readCanonicalView(x.client,business,view,range);
  expect(x.calls).toContainEqual([">=business_date",range.dateFrom]);
  expect(x.calls).toContainEqual(["<=business_date",range.dateTo]);
 }
});
