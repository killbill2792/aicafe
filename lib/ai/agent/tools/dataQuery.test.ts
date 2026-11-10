import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
 readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools,fitRows} from "./dataQuery";
import {readToastDayTrust} from "@/lib/data/toastDayTrust.server";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function input(view="cv_sales_days"){return {view,columns:["business_date"],
 filters:null,group_by:["business_date"],metrics:[{fn:"sum",column:"net_sales_cents"}],
 date_from:"2026-10-01",date_to:"2026-10-10",order_by:null,limit:100};}
function testDb(rows:unknown[]=[],error:unknown=null){
 const rpc=vi.fn(async(_name:string,_params:unknown)=>({data:{rows,sourceMix:{app:1},
  truncated:false,rowCount:rows.length},error}));
 return {db:{rpc} as never,rpc};
}
it("does not issue an RPC for unknown views, columns or SQL injection fields",async()=>{
 const f=testDb(),ctx={db:f.db,businessId:b};
 expect((await dataQueryTools.query_data.execute(input("private_tables"),ctx)).error).toBe("invalid_query");
 expect((await dataQueryTools.query_data.execute({...input(),columns:["password"]},ctx)).error)
  .toBe("column_not_allowed");
 expect((await dataQueryTools.query_data.execute({...input(),raw_sql:"drop table businesses"},ctx)).error)
  .toBe("invalid_query");
 expect(f.rpc).not.toHaveBeenCalled();
});
it("always supplies the authenticated café identity and grouped metrics",async()=>{
 const f=testDb([{business_date:"2026-10-01",sum_net_sales_cents:1250}]);
 const result=await dataQueryTools.query_data.execute(input(),{db:f.db,businessId:b});
 expect(result.empty).toBe(false);
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_business_id:b,p_view:"cv_sales_days",p_group_by:["business_date"],
  p_metrics:[{fn:"sum",column:"net_sales_cents"}],p_limit:100
 }));
 expect(result.rows).toEqual([{business_date:"2026-10-01",sum_net_sales_cents:1250}]);
});
it("distinguishes safe invalid SQL query shapes from real outages",async()=>{
 const ctxBase={businessId:b};
 const rejected=vi.fn(async()=>({data:null,error:{
  code:"42703",message:"column wrong -- customer@example.test"}}));
 const queryError=await dataQueryTools.query_data.execute(input(),{
  ...ctxBase,db:{rpc:rejected} as never});
 expect(queryError).toMatchObject({error:"invalid_query",empty:true,rows:[]});
 expect(JSON.stringify(queryError)).not.toContain("customer@example.test");
 const thrown=Object.assign(new Error("secret query text"),{code:"22P02"});
 const typed=vi.fn(async()=>{throw thrown;});
 const malformed=await dataQueryTools.query_data.execute(input(),{
  ...ctxBase,db:{rpc:typed} as never});
 expect(malformed.error).toBe("invalid_query");
 expect(JSON.stringify(malformed)).not.toContain("secret query text");
 for(const fixedMessage of ["invalid aggregate","columns require group by",
  "invalid order by","invalid filter column"]){
  const rejectedRpc=vi.fn(async()=>({data:null,error:{
   code:"P0001",message:fixedMessage}}));
  const result=await dataQueryTools.query_data.execute(input(),{
   ...ctxBase,db:{rpc:rejectedRpc} as never});
  expect(result.error,fixedMessage).toBe("invalid_query");
 }
 for(const code of ["42501","PGRST202","P0001",undefined]){
  const outage=vi.fn(async()=>({data:null,error:{code,message:"private detail"}}));
  const result=await dataQueryTools.query_data.execute(input(),{
   ...ctxBase,db:{rpc:outage} as never});
  expect(result.error).toBe("source_read_failed");
  expect(JSON.stringify(result)).not.toContain("private detail");
 }
});
it("rejects aggregate and sort shapes that the existing SQL RPC cannot execute",async()=>{
 const f=testDb(),ctx={db:f.db,businessId:b};
 const invalid=[
  {...input(),group_by:null,columns:["net_sales_cents"]},
  {...input(),group_by:["business_date"],columns:["net_sales_cents"]},
  {...input(),order_by:{column:"discount_amount_cents",direction:"desc"}}
 ];
 for(const args of invalid){
  const result=await dataQueryTools.query_data.execute(args,ctx);
  expect(result.error).toBe("invalid_query");
 }
 expect(f.rpc).not.toHaveBeenCalled();
 // Do not reject the already-supported grouped metric alias and precise
 // plain-read projections; existing database aggregator handles them.
 const alias=await dataQueryTools.query_data.execute({
  ...input(),order_by:{column:"sum_net_sales_cents",direction:"desc"}},ctx);
 expect(alias.error).toBeUndefined();
 const plain=await dataQueryTools.query_data.execute({
  ...input(),columns:["business_date","net_sales_cents"],group_by:null,metrics:null},ctx);
 expect(plain.error).toBeUndefined();
 // Omitted plain-read columns expand to canonical allowlisted columns, so
 // sorting by one of those keys must remain valid.
 const sorted=await dataQueryTools.query_data.execute({
  ...input(),columns:null,group_by:null,metrics:null,
  order_by:{column:"business_date",direction:"desc"}},ctx);
 expect(sorted.error).toBeUndefined();
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_columns:expect.arrayContaining(["business_date","net_sales_cents"]),
  p_order_by:{column:"business_date",direction:"desc"}
 }));
 expect(f.rpc).toHaveBeenCalledTimes(3);
});
it("empty and failed queries are explicit, not invented zero totals",async()=>{
 const f=testDb();
 const result=await dataQueryTools.query_data.execute(input(),{db:f.db,businessId:b});
 expect(result.empty).toBe(true);
 const bad=testDb([],{message:"sensitive"});
 const failed=await dataQueryTools.query_data.execute(input(),{db:bad.db,businessId:b});
 expect(failed.error).toBe("source_read_failed");
 expect(JSON.stringify(failed)).not.toContain("sensitive");
});
it("reads retained history without arbitrary caps and still enforces range and row bounds",async()=>{
 const f=testDb(),ctx={db:f.db,businessId:b};
 expect((await dataQueryTools.query_data.execute({...input(),date_from:"2030-10-11"},ctx)).error)
  .toBe("invalid_date_range");
 expect((await dataQueryTools.query_data.execute({...input(),date_to:"2030-10-11"},ctx)).error)
  .toBeUndefined();
 expect((await dataQueryTools.query_data.execute({...input(),limit:101},ctx)).error)
  .toBe("invalid_query");
 expect(f.rpc).toHaveBeenCalledTimes(1);
});

it("does not certify open or estimated facts as complete",async()=>{
 const rpc=vi.fn(async()=>({data:{
   rows:[{status:"open",business_date:"2026-10-03",amount_cents:null}],
   sourceCount:1,hasIncomplete:true,truncated:false,sourceMix:{toast:1}
 },error:null}));
 const x=await dataQueryTools.query_data.execute(input(),{
   db:{rpc} as never,businessId:b});
 expect(x.empty).toBe(false);
 expect(x.missing).toContain("incompleteEvidence");
});
it("an aggregate null over no matching facts reports empty",async()=>{
 const rpc=vi.fn(async()=>({data:{
   rows:[{sum_net_sales_cents:null}],sourceCount:0,hasIncomplete:false,
   truncated:false,sourceMix:{}
 },error:null}));
 const x=await dataQueryTools.query_data.execute(input(),{
   db:{rpc} as never,businessId:b});
 expect(x.empty).toBe(true);
 expect(x.missing).toContain("empty");
});
it("defaults to a compact 50-row result when the model gives no limit",async()=>{
 const f=testDb([{business_date:"2026-10-01",sum_net_sales_cents:1}]);
 await dataQueryTools.query_data.execute({...input(),limit:null},{db:f.db,businessId:b});
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_limit:50}));
});
it("does not call current Toast cash and stock diagnostic snapshots, and reports unverified freshness",async()=>{
 const rpc=vi.fn(async()=>({data:{rows:[{entry_type:"deposit",sum_amount_cents:5000}],
  sourceCount:1,sourceMix:{toast:1},truncated:false},error:null}));
 const ctx={db:{rpc} as never,businessId:b};
 const cash=await dataQueryTools.query_data.execute({...input("cv_cash"),columns:["entry_type"],group_by:["entry_type"],
  metrics:[{fn:"sum",column:"amount_cents"}]},ctx);
 expect(cash.missing).toContain("source_freshness_unverified");
 expect(cash.missing).not.toContain("snapshotOnly");
 expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_view:"cv_cash",p_business_id:b}));
 const sales=await dataQueryTools.query_data.execute(input(),ctx);
 expect(sales.missing).not.toContain("source_freshness_unverified");
});
it("reads named Toast fields through the database, never whole records",async()=>{
 const f=testDb([{"data.server.guid":"s1","sum_data.price":12.5}]);
 const result=await dataQueryTools.query_data.execute({view:"cv_toast_records",columns:null,
  filters:[{column:"record_type",op:"=",value:"item"},{column:"counts_in_sales",op:"=",value:true}],
  group_by:["data.server.guid"],metrics:[{fn:"sum",column:"data.price"}],
  date_from:"2026-10-01",date_to:"2026-10-10",order_by:null,limit:null},{db:f.db,businessId:b});
 expect(result.rows).toEqual([{"data.server.guid":"s1","sum_data.price":12.5}]);
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_view:"cv_toast_records",p_group_by:["data.server.guid"]}));
 // Plain rows of Toast records also use the database function, not select *.
 const plain=testDb([{record_type:"order"}]);
 await dataQueryTools.query_data.execute({view:"cv_toast_records",columns:["record_type","data.table.name"],
  filters:null,group_by:null,metrics:null,date_from:"2026-10-01",date_to:"2026-10-01",order_by:null,limit:null},
  {db:plain.db,businessId:b});
 expect(plain.rpc).toHaveBeenCalledTimes(1);
});
it("accepts only plain field names inside data",async()=>{
 const f=testDb();
 for(const column of ["data","data.","data.a;drop","data.a b","data."+Array(17).fill("deep").join("."),"meta.x"])
  expect((await dataQueryTools.query_data.execute({...input("cv_toast_records"),columns:null,
   group_by:[column],metrics:null},{db:f.db,businessId:b})).error,column).toBe("column_not_allowed");
});
it("lists the field names of a Toast record type for this café only",async()=>{
 const rpc=vi.fn(async()=>({data:[{field:"data.price",type:"number",example:"5.5"}],error:null}));
 const result=await dataQueryTools.describe_data.execute({record_type:"item"},{db:{rpc} as never,businessId:b});
 expect(rpc).toHaveBeenCalledWith("ai_toast_fields",{p_business_id:b,p_record_type:"item"});
 expect(result).toMatchObject({record_type:"item"});
 expect(result.fields).toEqual(expect.arrayContaining([expect.objectContaining({field:"data.price"})]));
 const all=await dataQueryTools.describe_data.execute({record_type:null});
 expect(all.views?.some(v=>v.name==="cv_toast_records")).toBe(true);
});
it("keeps results compact by dropping whole rows and saying so",()=>{
 const rows=Array.from({length:100},(_,i)=>({i,text:"x".repeat(200)}));
 const fit=fitRows(rows);
 expect(fit.cut).toBe(true);
 expect(JSON.stringify(fit.rows).length).toBeLessThanOrEqual(6000);
 expect(fitRows(rows.slice(0,3))).toEqual({rows:rows.slice(0,3),cut:false});
});

it("propagates the existing screen coverage gaps and source names",async()=>{
 vi.mocked(readToastDayTrust).mockResolvedValueOnce({
  blocked:new Set(),quality:["toastImportIncompleteDays:1:2026-10-03:0"],
  notes:["toastDaysNeedLook:1:2026-10-03:0"]
 });
 const f=testDb([{business_date:"2026-10-03",sum_net_sales_cents:1234}]);
 const value=await dataQueryTools.query_data.execute(input(),{db:f.db,businessId:b});
 expect(value.sourceMix).toEqual({app:1});
 expect(value.missing).toContain("toastImportIncompleteDays:1:2026-10-03:0");
 expect(value).toHaveProperty("notes",expect.arrayContaining(["toastDaysNeedLook:1:2026-10-03:0"]));
 expect(readToastDayTrust).toHaveBeenCalledWith(f.db,b,"2026-10-01","2026-10-10");
});
it("keeps current-day incompleteness on ungrouped sales rows",async()=>{
 const rpc=vi.fn(async()=>({data:{
  rows:[{business_date:"2026-10-03",net_sales_cents:1250}],
  sourceCount:1,sourceMix:{app:1},hasIncomplete:false,currentDayIncomplete:true,truncated:false
 },error:null}));
 const value=await dataQueryTools.query_data.execute({
  ...input(),columns:["business_date","net_sales_cents"],group_by:null,metrics:null
 },{db:{rpc} as never,businessId:b});
 expect(value.missing).toContain("currentDayIncomplete");
 expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_view:"cv_sales_days"}));
});

it("sends Toast integer-cent projections to the same authenticated aggregate RPC",async()=>{
 const f=testDb([{business_date:"2026-10-03",sum_discount_amount_cents:128}]);
 const args={view:"cv_toast_records",columns:null,
  filters:[{column:"record_type",op:"in",value:["check_discount","item_discount"]},
   {column:"counts_in_sales",op:"=",value:true}],
  group_by:["business_date"],metrics:[{fn:"sum",column:"discount_amount_cents"}],
  date_from:"2026-10-03",date_to:"2026-10-03",order_by:null,limit:20};
 const value=await dataQueryTools.query_data.execute(args,{db:f.db,businessId:b});
 expect(value.rows).toEqual([{business_date:"2026-10-03",sum_discount_amount_cents:128}]);
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_business_id:b,p_view:"cv_toast_records",
  p_metrics:[{fn:"sum",column:"discount_amount_cents"}]
 }));
});

it("keeps the complete allowed screen fields for an unaggregated query without columns",async()=>{
 const f=testDb([{business_date:"2026-10-03",net_sales_cents:1250,orders_count:3}]);
 const result=await dataQueryTools.query_data.execute({
  ...input(),columns:null,group_by:null,metrics:null
 },{db:f.db,businessId:b});
 expect(result.rows).toEqual([{business_date:"2026-10-03",net_sales_cents:1250,orders_count:3}]);
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_business_id:b,p_view:"cv_sales_days",
  p_columns:expect.arrayContaining(["business_date","net_sales_cents","orders_count","data"])
 }));
});
it("the Toast plain-read projection includes the newly validated cent columns",async()=>{
 const f=testDb([{record_type:"item",price_cents:787,discount_amount_cents:null}]);
 await dataQueryTools.query_data.execute({
  view:"cv_toast_records",columns:null,group_by:null,metrics:null,filters:null,
  date_from:"2026-10-03",date_to:"2026-10-03",order_by:null,limit:20
 },{db:f.db,businessId:b});
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_view:"cv_toast_records",
  p_columns:expect.arrayContaining(["record_type","price_cents","discount_amount_cents"])
 }));
});
