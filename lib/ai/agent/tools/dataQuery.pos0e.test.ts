import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
 readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools,officialToastFields} from "./dataQuery";
import {toastOfficialFieldCatalog} from "@/lib/data/canonical/dictionary";

const cafeA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cafeB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const range={date_from:"2026-10-01",date_to:"2026-10-31"};
const query={view:"cv_toast_records",columns:null,filters:[
 {column:"record_type",op:"=",value:"cashmgmt/v1/entries"}],
 group_by:["data.type"],metrics:[{fn:"sum",column:"data.amount"}],
 ...range,order_by:null,limit:20};

describe("POS0e retained current-source dictionary and shared reader",()=>{
 it("pins the 12 official Standard GET schema families without claiming café access",()=>{
  expect(Object.keys(toastOfficialFieldCatalog)).toHaveLength(12);
  expect(toastOfficialFieldCatalog.orders.fields.length).toBeGreaterThan(400);
  expect(toastOfficialFieldCatalog.orders.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(toastOfficialFieldCatalog.orders.sha256).toMatch(/^[0-9a-f]{64}$/);
  const cases=[
   ["order","data.guid","data.checks.0.amount"],
   ["check","data.amount","data.selections.0.displayName"],
   ["item","data.displayName","data.appliedDiscounts.0.discountAmount"],
   ["payment","data.amount","data.checks.0.payments.0.amount"],
   ["item_discount","data.discountAmount","data.checks.0.selections.0.appliedDiscounts.0.discountAmount"],
   ["check_discount","data.discountAmount","data.checks.0.appliedDiscounts.0.discountAmount"],
   ["service_charge","data.chargeAmount","data.checks.0.appliedServiceCharges.0.chargeAmount"]
  ];
  for(const [recordType,exposed,impossible] of cases){
   const fields=officialToastFields(recordType).map(v=>v.field);
   expect(fields,recordType+" exposes its actual split-record field").toContain(exposed);
   expect(fields,recordType+" cannot query a removed parent/child JSON").not.toContain(impossible);
  }
  // Staged employee projections have typed DB field names; official labor
  // response paths are not the same object and must not be falsely advertised.
  expect(officialToastFields("employee")).toEqual([]);
  expect(officialToastFields("time_entry")).toEqual([]);
  expect(officialToastFields("modifier")).toEqual([]);
  expect(officialToastFields("cashmgmt/v1/entries").length).toBeGreaterThan(5);
  expect(officialToastFields("nonexistent-api/facts")).toEqual([]);
 });
 it("describes never-observed permitted paths as unverified, not invented field values",async()=>{
  const rpc=vi.fn(async()=>({data:[],error:null}));
  const result=await dataQueryTools.describe_data.execute({
   record_type:"item",view:null,field_prefix:"data.displayName"
  },{db:{rpc} as never,businessId:cafeA});
  expect(rpc).toHaveBeenCalledWith("ai_toast_fields",{
   p_business_id:cafeA,p_record_type:"item"
  });
  expect(result.missing).toContain("source_not_observed");
  expect(result.missing).toContain("schema_grants_unverified");
  expect(result.fields).toEqual(expect.arrayContaining([
   expect.objectContaining({field:"data.displayName",
    grant:"not_verified",observed:false})
  ]));
  expect(JSON.stringify(result.fields)).not.toContain("customer@example.com");
 });
 it("merges retained current fields without replacing observed types or optional nulls",async()=>{
  const retained=[{field:"data.employee.guid",type:"string",source:"retained_current"},
   {field:"data.details.optional",type:"string",source:"retained_current"}];
  const rpc=vi.fn(async()=>({data:retained,error:null}));
  const response=await dataQueryTools.describe_data.execute({
   record_type:"cashmgmt/v1/entries",field_prefix:"data.details"
  },{db:{rpc} as never,businessId:cafeA});
  expect(response.fields).toEqual([retained[1]]);
  expect(response.truncated).toBe(false);
  expect(response.retainedFields).toBe(2);
 });
 it("always binds café identity, explicit days, bounded columns and SQL aggregation",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{"data.type":"CASH_IN","sum_data.amount":12.5}],
   sourceCount:1,sourceMix:{toast:1},truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute(query,{
   db:{rpc} as never,businessId:cafeA});
  expect(result.rows).toEqual([{"data.type":"CASH_IN","sum_data.amount":12.5}]);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",expect.objectContaining({
   p_business_id:cafeA,p_view:"cv_toast_records",
   p_date_from:"2026-10-01",p_date_to:"2026-10-31",p_limit:20
  }));
  const impossible=await dataQueryTools.query_data.execute({...query,
   business_id:cafeB},{db:{rpc} as never,businessId:cafeA});
  expect(impossible.error).toBe("invalid_query");
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("fails closed on authorization failures, invalid scopes and unsafe deep fields",async()=>{
  const rpc=vi.fn(async()=>({data:null,error:{message:"permission denied"}}));
  const denied=await dataQueryTools.query_data.execute(query,{
   db:{rpc} as never,businessId:cafeA});
  expect(denied.error).toBe("source_read_failed");
  expect(JSON.stringify(denied)).not.toContain("permission denied");
  const bad=await dataQueryTools.query_data.execute(query,{
   db:{rpc} as never,businessId:"not-a-cafe"});
  expect(bad.error).toBe("invalid_scope");
  const wrong=await dataQueryTools.query_data.execute({...query,
   group_by:["data."+Array(17).fill("inside").join(".")]},
   {db:{rpc} as never,businessId:cafeA});
  expect(wrong.error).toBe("column_not_allowed");
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("keeps whole Toast JSON out of tool replies and denies credential paths",async()=>{
  const rpc=vi.fn(async()=>({data:{rows:[],sourceCount:0,truncated:false},error:null}));
  const ctx={db:{rpc} as never,businessId:cafeA};
  const plain={...query,columns:null,group_by:null,metrics:null};
  await dataQueryTools.query_data.execute(plain,ctx);
  const fields=(rpc.mock.calls[0] as unknown as [string,Record<string,unknown>])[1].p_columns;
  expect(fields).not.toContain("data");
  expect(fields).toContain("record_ref");
  const before=rpc.mock.calls.length;
  for(const forbidden of ["data.cardNumber","data.customer.accessToken",
   "data.checks.0.payments.0.cvv","data.networkTransactionIdentifier"]){
   const out=await dataQueryTools.query_data.execute({...plain,columns:[forbidden]},ctx);
   expect(out.error,forbidden).toBe("column_not_allowed");
  }
  expect(rpc.mock.calls).toHaveLength(before);
  const observed=[{field:"data.customer.firstName",type:"string"},
   {field:"data.cardNumber",type:"string"},{field:"data.employee.apiKey",type:"string"}];
  const fieldsRpc=vi.fn(async()=>({data:observed,error:null}));
  const discovery=await dataQueryTools.describe_data.execute({record_type:"order",
   field_prefix:"data."},{db:{rpc:fieldsRpc} as never,businessId:cafeA});
  expect(discovery.fields).toEqual(expect.arrayContaining([
   expect.objectContaining({field:"data.customer.firstName"})
  ]));
  expect(JSON.stringify(discovery.fields)).not.toMatch(/data\.cardNumber|data\.employee\.apiKey/);
  expect(discovery.retainedFields).toBe(1);
 });
 it("does not treat provider null, no rows, or a partial result as known zero",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{"data.type":"CASH_IN","sum_data.amount":null}],
   sourceCount:1,hasIncomplete:true,sourceMix:{toast:1},truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute(query,{
   db:{rpc} as never,businessId:cafeA});
  expect(result.empty).toBe(false);
  expect(result.missing).toContain("incompleteEvidence");
  expect(result.rows).toEqual([{"data.type":"CASH_IN","sum_data.amount":null}]);
 });
});
