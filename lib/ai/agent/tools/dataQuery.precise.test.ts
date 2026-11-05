import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
 readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools} from "./dataQuery";
const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const question={
 view:"cv_toast_records",columns:null,
 filters:[
  {column:"record_type",op:"in",value:["item_discount","check_discount"]},
  {column:"counts_in_sales",op:"=",value:true},
  {column:"data.name",op:"ilike",value:"%student%"}
 ],
 group_by:null,
 metrics:[
  {fn:"count",column:"source_ref"},
  {fn:"count_distinct",column:"order_ref"},
  {fn:"count_distinct",column:"check_ref"}
 ],
 date_from:"2026-11-02",date_to:"2026-11-02",order_by:null,limit:20
} as const;
describe("one universal query for applied discount uses and distinct orders",()=>{
 it("sends the exact approved aggregation to the café-scoped database",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{count_source_ref:4,count_distinct_order_ref:2,count_distinct_check_ref:3}],
   sourceCount:4,sourceMix:{toast:4},hasIncomplete:true,
   currentDayIncomplete:true,truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute(question,{db:{rpc} as never,businessId});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",{
   p_business_id:businessId,p_view:"cv_toast_records",p_columns:null,
   p_filters:[...question.filters],p_group_by:[],p_metrics:[...question.metrics],
   p_date_from:question.date_from,p_date_to:question.date_to,
   p_order_by:null,p_limit:20
  });
  expect(result.rows).toEqual([{
   count_source_ref:4,count_distinct_order_ref:2,count_distinct_check_ref:3
  }]);
  expect(result.empty).toBe(false);
  expect(result.missing).toEqual(expect.arrayContaining(["incompleteEvidence","currentDayIncomplete"]));
 });
 it("keeps a zero-row active-day result incomplete, never a verified final zero",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{count_source_ref:0,count_distinct_order_ref:0}],
   sourceCount:0,sourceMix:{},hasIncomplete:false,currentDayIncomplete:true,truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute(question,{db:{rpc} as never,businessId});
  expect(result.empty).toBe(true);
  expect(result.missing).toEqual(expect.arrayContaining(["empty","currentDayIncomplete"]));
 });
 it("a byte-limited database result is truncated, not wrongly called empty",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[],sourceCount:8,truncated:true,currentDayIncomplete:true,hasIncomplete:true
  },error:null}));
  const result=await dataQueryTools.query_data.execute(question,{db:{rpc} as never,businessId});
  expect(result.empty).toBe(false);
  expect(result.missing).toContain("result_truncated");
  expect(result.missing).not.toContain("empty");
 });
 it("rejects unapproved distinct fields without making a database request",async()=>{
  const rpc=vi.fn();
  const result=await dataQueryTools.query_data.execute({
   ...question,metrics:[{fn:"count_distinct",column:"order_ref);drop table businesses;--"}]
  },{db:{rpc} as never,businessId});
  expect(result.error).toBe("column_not_allowed");
  expect(rpc).not.toHaveBeenCalled();
 });
 it("describes just one canonical view's fields, or a compact view index",async()=>{
  const single=await dataQueryTools.describe_data.execute({record_type:null,view:"cv_toast_records"});
  const focused=single as unknown as {views:Array<{name:string;columns:Array<{name:string}>}>};
  expect(focused.views).toHaveLength(1);
  expect(focused.views[0].name).toBe("cv_toast_records");
  expect(focused.views[0].columns).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"order_ref"}),
   expect.objectContaining({name:"check_ref"}),
   expect.objectContaining({name:"counts_in_sales"})
  ]));
  const index=await dataQueryTools.describe_data.execute({record_type:null,view:null});
  expect(index.views?.length).toBeGreaterThan(1);
  expect(index.views?.every(v=>!("columns" in v))).toBe(true);
  const invalid=await dataQueryTools.describe_data.execute({
   record_type:"item_discount",view:"cv_toast_records"
  });
  expect(invalid.missing).toContain("invalid_query");
 });
 it("caps sampled field discovery so records cannot flood the model context",async()=>{
  const huge=Array.from({length:90},(_,i)=>({
   field:"data.sample_"+i,type:"string",example:"X".repeat(100)
  }));
  const rpc=vi.fn(async()=>({data:huge,error:null}));
  const result=await dataQueryTools.describe_data.execute({record_type:"item_discount",view:null},
   {db:{rpc} as never,businessId});
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result.fields).length).toBeLessThanOrEqual(6000);
  expect(result.missing).toContain("result_truncated");
 });
});
const unplannedQueries=[
 {ownerQuestion:"How many recorded guests per day, compared with orders?",
  filters:[{column:"record_type",op:"=",value:"order"},{column:"counts_in_sales",op:"=",value:true}],
  group_by:["business_date"],
  metrics:[{fn:"sum",column:"data.numberOfGuests"},{fn:"count",column:"source_ref"}]},
 {ownerQuestion:"Which item selections had quantity at least two?",
  filters:[{column:"record_type",op:"=",value:"item"},{column:"data.quantity",op:">=",value:2}],
  group_by:["business_date","data.displayName"],
  metrics:[{fn:"count",column:"source_ref"},{fn:"sum",column:"data.quantity"}]},
 {ownerQuestion:"What item names are missing in Toast?",
  filters:[{column:"record_type",op:"=",value:"item"},{column:"data.displayName",op:"is_null",value:null}],
  group_by:["business_date"],metrics:[{fn:"count",column:"source_ref"}]},
 {ownerQuestion:"What are the average quantities of named items?",
  filters:[{column:"record_type",op:"=",value:"item"},{column:"data.displayName",op:"is_not_null",value:null}],
  group_by:["data.displayName"],
  metrics:[{fn:"avg",column:"data.quantity"},{fn:"min",column:"data.quantity"},{fn:"max",column:"data.quantity"}]},
 {ownerQuestion:"How many different orders used each discount per day?",
  filters:[{column:"record_type",op:"in",value:["item_discount","check_discount"]},
   {column:"counts_in_sales",op:"=",value:true}],
  group_by:["business_date","data.name"],
  metrics:[{fn:"count",column:"source_ref"},{fn:"count_distinct",column:"order_ref"}]},
 {ownerQuestion:"Which order sources recorded orders on the two dates?",
  filters:[{column:"record_type",op:"=",value:"order"},
   {column:"data.source",op:"in",value:["Online","In Store"]}],
  group_by:["business_date","data.source"],
  metrics:[{fn:"count_distinct",column:"record_ref"}]}
] as const;
describe("unplanned questions use the same safe read-only tool, not feature-specific tool paths",()=>{
 it.each(unplannedQueries)("$ownerQuestion",async({filters,group_by,metrics})=>{
  const rpc=vi.fn(async()=>({data:{rows:[{}],sourceCount:1,truncated:false,
   sourceMix:{toast:1},hasIncomplete:false,currentDayIncomplete:false},error:null}));
  const actual=await dataQueryTools.query_data.execute({
   ...question,filters,group_by,metrics
  },{db:{rpc} as never,businessId});
  expect(actual.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_business_id:businessId,p_view:"cv_toast_records",
   p_filters:filters,p_group_by:group_by,p_metrics:metrics
  }));
 });
 it("null filters require an actual null, never a fake zero or a string",async()=>{
  const rpc=vi.fn();
  const result=await dataQueryTools.query_data.execute({
   ...question,filters:[{column:"data.displayName",op:"is_null",value:0}]
  },{db:{rpc} as never,businessId});
  expect(result.error).toBe("invalid_filter");
  expect(rpc).not.toHaveBeenCalled();
 });
});
describe("no arbitrary field-path or catalog discovery ceiling",()=>{
 it("accepts a long valid nested Toast path that the database accepts",async()=>{
  const field="data."+("nestedField".repeat(8))+"."+("leaf".repeat(8));
  const rpc=vi.fn(async()=>({data:{
   rows:[{[field]:"example"}],sourceCount:1,sourceMix:{toast:1},truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute({
   ...question,columns:null,group_by:[field],metrics:[{fn:"count",column:"source_ref"}]
  },{db:{rpc} as never,businessId});
  expect(result.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_group_by:[field]}));
 });
 it("finds later fields by prefix instead of silently losing them to the output cap",async()=>{
  const fields=Array.from({length:120},(_,i)=>({
   field:"data.path_"+String(i).padStart(3,"0"),
   type:"string",example:"value".repeat(40)
  }));
  const rpc=vi.fn(async()=>({data:fields,error:null}));
  const result=await dataQueryTools.describe_data.execute({
   record_type:"item",view:null,field_prefix:"data.path_11"
  },{db:{rpc} as never,businessId});
  expect(result.fields).toEqual(fields.slice(110,120));
  expect(result.truncated).toBe(false);
  expect(result.missing).not.toContain("result_truncated");
 });
 it("never mistakes a view-only field prefix for a global source query",async()=>{
  const result=await dataQueryTools.describe_data.execute({
   record_type:null,view:"cv_toast_records",field_prefix:"data."
  });
  expect(result.missing).toContain("invalid_query");
 });
});
