import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const rosterClient=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("@/lib/pos/toast/client",async importOriginal=>{
 const source=await importOriginal<typeof import("@/lib/pos/toast/client")>();
 return {...source,createToastClient:()=>rosterClient};
});
vi.mock("@/lib/data/toastDayTrust.server",()=>({
 readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools,officialToastFields} from "./dataQuery";
import {runAgentTurn,type AgentProvider} from "../loop.server";
import {agentToolDefinitions,type AgentToolContext} from "./index";
import {toastOfficialFieldCatalog,canonicalDictionary} from "@/lib/data/canonical/dictionary";
import {createToastAdapter} from "@/lib/pos/toast/adapter";

const cafeA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cafeB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const range={date_from:"2026-10-01",date_to:"2026-10-31"};
const query={view:"cv_toast_records",columns:null,filters:[
 {column:"record_type",op:"=",value:"cashmgmt/v1/entries"}],
 group_by:["data.type"],metrics:[{fn:"sum",column:"data.amount"}],
 ...range,order_by:null,limit:20};

it("builds the complete registered one-Supervisor tool request before any paid provider call",async()=>{
 let seen=0;
 const fake:AgentProvider=async function*(params){
  seen++;
  const encoded=JSON.stringify(params);
  expect(encoded.length).toBeLessThan(3_000_000);
  const names=(params.tools as Array<{name:string}>).map(tool=>tool.name);
  expect(names).toContain("query_data");
  expect(names).toContain("describe_data");
  expect(names.length).toBeGreaterThan(2);
  yield {type:"response.output_text.delta",delta:"Registered tool request built."};
  yield {type:"response.completed",response:{status:"completed",output:[],
   usage:{input_tokens:1,output_tokens:1}}};
 };
 const ctx={asOf:"2026-11-09",timezone:"America/Los_Angeles",
  locale:"en",tools:{}} as unknown as AgentToolContext;
 await runAgentTurn({context:ctx,provider:fake,
  ownerText:"Verify the registered tool request can be constructed."});
 expect(seen).toBe(1);
});

it("uses the actual Toast roster adapter's retained full-name projection",async()=>{
 const guid="d1d1d1d1-1111-4111-8111-111111111111";
 rosterClient.request.mockResolvedValueOnce([{guid,firstName:"Nadia",
  lastName:"Rao",chosenName:null,deleted:false}]);
 const adapter=createToastAdapter({db:{} as never,businessId:cafeA,
  restaurantGuid:"e1e1e1e1-1111-4111-8111-111111111111"});
 const facts=await adapter.fetchEmployeeRosterFacts();
 expect(facts).toEqual([{employee_guid:guid,display_name:"Nadia Rao",deleted:false}]);
 expect(facts[0]).not.toHaveProperty("firstName");
 expect(facts[0]).not.toHaveProperty("lastName");
 expect(rosterClient.request).toHaveBeenCalledWith(
  "/labor/v1/employees","e1e1e1e1-1111-4111-8111-111111111111",
  expect.anything(),expect.anything());
});

describe("POS0e retained current-source dictionary and shared reader",()=>{
 it("preserves POS metric semantics in the canonical dictionary without scripted question routing",()=>{
  const query=agentToolDefinitions.find(tool=>tool.name==="query_data");
  const discovery=agentToolDefinitions.find(tool=>tool.name==="describe_data");
  expect(query?.description).toContain("source grain");
  expect(query?.description).toContain("model-selected");
  expect(discovery?.description).toContain("meaning");
  // The reusable semantic catalog, not a mandatory prompt sequence, defines
  // how different order/check/discount measurements can be counted.
  const record=canonicalDictionary.cv_toast_records;
  expect(record.meaning).toContain("count_distinct order_ref");
  expect(record.meaning).toContain("count_distinct check_ref");
  expect(record.meaning).toContain("count source_ref");
  expect(record.columns).toHaveProperty("counts_in_sales");
  expect(record.columns).toHaveProperty("order_ref");
  expect(record.columns).toHaveProperty("check_ref");
  expect(record.columns).toHaveProperty("data");
  expect(query?.description).not.toMatch(/ALWAYS use query_data|For ALL applied uses of ANY name|call query_data directly/);
 });
 it("describes the correct Toast menu-item GUID lookup without confusing evidence refs",async()=>{
  const described=await dataQueryTools.describe_data.execute({view:"cv_inventory"});
  const cols=described.views?.[0]?.columns??[];
  const menu=cols.find(c=>c.name==="menu_item_ref");
  const evidence=cols.find(c=>c.name==="source_ref");
  expect(menu?.meaning).toContain("menu-item GUID");
  expect(menu?.meaning).toContain("menu_item_ref");
  expect(evidence?.meaning).toContain("NOT the Toast menu-item GUID");

  const stockGuid="d1d1d1d1-1111-4111-8111-111111111111";
  const rpc=vi.fn(async()=>({data:{rows:[{quantity:4.5}],sourceCount:1,
   sourceMix:{toast:1},truncated:false},error:null}));
  const answer=await dataQueryTools.query_data.execute({
   view:"cv_inventory",columns:["quantity"],
   filters:[{column:"menu_item_ref",op:"=",value:stockGuid}],
   group_by:null,metrics:null,date_from:"2026-10-26",date_to:"2026-10-26",
   order_by:null,limit:10
  },{db:{rpc} as never,businessId:cafeA});
  expect(answer.rows).toEqual([{quantity:4.5}]);
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_business_id:cafeA,p_view:"cv_inventory",
   p_filters:[{column:"menu_item_ref",op:"=",value:stockGuid}]
  }));
 });
 it("guides a single exact stored-GUID query for employee and customer names",async()=>{
  const described=await dataQueryTools.describe_data.execute({view:"cv_toast_records"});
  const cols=described.views?.[0]?.columns??[];
  const employeeType=cols.find(col=>col.name==="record_type");
  const recordGuid=cols.find(col=>col.name==="record_ref");
  const data=cols.find(col=>col.name==="data");
  expect(employeeType?.meaning).toContain("record_type=employee");
  expect(recordGuid?.meaning).toContain("record_ref");
  expect(data?.meaning).toContain("data.display_name");
   expect(data?.meaning).toContain("data.firstName is not stored");
  expect(data?.meaning).toContain("data.customer.firstName");
  const cases=[
   {type:"employee",ref:"d1d1d1d1-1111-4111-8111-111111111111",field:"data.display_name"},
   {type:"order",ref:"d2d2d2d2-2222-4222-8222-222222222222",field:"data.customer.firstName"}
  ];
  for(const c of cases){
   const rpc=vi.fn(async()=>({data:{rows:[{[c.field]:"Example"}],
    sourceCount:1,sourceMix:{toast:1},truncated:false},error:null}));
   const result=await dataQueryTools.query_data.execute({
    view:"cv_toast_records",columns:[c.field],
    filters:[{column:"record_type",op:"=",value:c.type},
     {column:"record_ref",op:"=",value:c.ref}],
    group_by:null,metrics:null,date_from:"2026-10-01",date_to:"2026-10-31",
    order_by:null,limit:10
   },{db:{rpc} as never,businessId:cafeA});
   expect(result.rows).toEqual([{[c.field]:"Example"}]);
   expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",
    expect.objectContaining({p_business_id:cafeA,p_view:"cv_toast_records",
     p_columns:[c.field],
     p_filters:[{column:"record_type",op:"=",value:c.type},
      {column:"record_ref",op:"=",value:c.ref}]}));
  }
 });
 it("describes retained current cash and setup records, never old diagnostics",async()=>{
  const cash=await dataQueryTools.describe_data.execute({view:"cv_cash"});
  const dining=await dataQueryTools.describe_data.execute({view:"cv_dining_options"});
  const allToast=await dataQueryTools.describe_data.execute({view:"cv_toast_records"});
  expect(cash.views?.[0]?.meaning).toMatch(/Retained current Toast cash/i);
  expect(dining.views?.[0]?.meaning).toMatch(/Retained current Toast dining-option/i);
  expect(allToast.views?.[0]?.meaning).toContain("never diagnostic samples");
  expect(JSON.stringify([cash.views,dining.views,allToast.views])).not.toContain(
   "redacted Toast diagnostics");
 });
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
 it("blocks credential-bearing object paths but retains permitted customer and staff fields",async()=>{
  const rpc=vi.fn(async()=>({data:{rows:[],sourceCount:0,truncated:false},error:null}));
  for(const path of ["data.cardInfo","data.customer.paymentMethod.value","data.cardNumber"]){
   const res=await dataQueryTools.query_data.execute({...query,group_by:[path]},
    {db:{rpc} as never,businessId:cafeA});
   expect(res.error,path).toBe("column_not_allowed");
  }
  for(const path of ["data.customer.email","data.employee.firstName"]){
   const res=await dataQueryTools.query_data.execute({...query,group_by:[path]},
    {db:{rpc} as never,businessId:cafeA});
   expect(res.error,path).toBeUndefined();
  }
  expect(rpc).toHaveBeenCalledTimes(2);
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

describe("POS0EF customer evidence",()=>{
 it("distinguishes an absent customer prefix from unrelated observed fields",async()=>{
  const rpc=vi.fn(async()=>({data:[{field:"data.amount",type:"number",source:"retained_current"}],error:null}));
  const answer=await dataQueryTools.describe_data.execute({record_type:"check",
   view:null,field_prefix:"data.customer"},{db:{rpc} as never,businessId:cafeA});
  expect(answer.missing).toContain("source_not_observed");
  expect(answer.missing).toContain("schema_grants_unverified");
  expect(answer).toMatchObject({retainedFields:1,matchingRetainedFields:0});
  expect(answer.fields).toEqual(expect.arrayContaining([
   expect.objectContaining({field:"data.customer.guid",observed:false,grant:"not_verified"})]));
 });
 it("discovers derived references without inventing observed identities or child money",async()=>{
  const rpc=vi.fn(async()=>({data:[],error:null}));
  const ctx={db:{rpc} as never,businessId:cafeA};
  const check=await dataQueryTools.describe_data.execute({record_type:"check",field_prefix:"data.aiCafeCustomer."},ctx);
  expect(check.missing).toContain("source_not_observed");
  expect(check.fields).toEqual(expect.arrayContaining([
   expect.objectContaining({field:"data.aiCafeCustomer.identityRef",source:"canonical_derivation",observed:false}),
   expect.objectContaining({field:"data.aiCafeCustomer.netSalesCents",source:"canonical_derivation",observed:false})]));
  const item=await dataQueryTools.describe_data.execute({record_type:"item",field_prefix:"data.aiCafeCustomer."},ctx);
  expect(item.fields).toEqual(expect.arrayContaining([expect.objectContaining({field:"data.aiCafeCustomer.visitRef"})]));
  expect(item.fields).not.toEqual(expect.arrayContaining([expect.objectContaining({field:"data.aiCafeCustomer.netSalesCents"})]));
 });
 it("uses one existing scoped aggregate RPC and explains identity limits",async()=>{
  const rpc=vi.fn(async()=>({data:{rows:[{"count_distinct_data.aiCafeCustomer.visitRef":2}],
   sourceCount:5,sourceMix:{toast:5},truncated:false},error:null}));
  const result=await dataQueryTools.query_data.execute({...query,group_by:null,columns:null,
   filters:[{column:"record_type",op:"=",value:"check"},{column:"counts_in_sales",op:"=",value:true}],
   metrics:[{fn:"count_distinct",column:"data.aiCafeCustomer.visitRef"}]},
   {db:{rpc} as never,businessId:cafeA});
  expect(result.aggregate).toMatchObject({value:2});
  expect(result.scopeWarning).toContain("Null unresolved references are not new customers");
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",expect.objectContaining({
   p_business_id:cafeA,p_metrics:[{fn:"count_distinct",column:"data.aiCafeCustomer.visitRef"}]}));
 });
 it("keeps unfamiliar raw field paths available through existing query_data",async()=>{
  const rpc=vi.fn(async()=>({data:{rows:[{"data.optionalGuestPreference":null}],sourceCount:1,sourceMix:{toast:1},truncated:false},error:null}));
  const result=await dataQueryTools.query_data.execute({...query,group_by:null,metrics:null,
   columns:["data.optionalGuestPreference"],filters:[{column:"record_type",op:"=",value:"check"}]},
   {db:{rpc} as never,businessId:cafeA});
  expect(result.rows).toEqual([{"data.optionalGuestPreference":null}]);
  expect(result.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",expect.objectContaining({p_columns:["data.optionalGuestPreference"]}));
 });
});

it("uses the existing registered grammar for visit cohorts and exposes population caveats",async()=>{
 const rpc=vi.fn(async()=>({data:{rows:[{"avg_observed_return_7d":0.5,"count_observed_return_7d":20}],
  sourceCount:20,sourceMix:{toast:20},truncated:false},error:null}));
 const ctx={db:{rpc} as never,businessId:cafeA};
 const catalog=await dataQueryTools.describe_data.execute({view:"cv_customer_visits"},ctx);
 expect(catalog.views).toEqual(expect.arrayContaining([expect.objectContaining({name:"cv_customer_visits"})]));
 const result=await dataQueryTools.query_data.execute({...query,view:"cv_customer_visits",group_by:null,columns:null,
  filters:null,metrics:[{fn:"avg",column:"observed_return_7d"},{fn:"count",column:"observed_return_7d"}]},ctx);
 expect(result.rows).toEqual([{"avg_observed_return_7d":0.5,"count_observed_return_7d":20}]);
 expect(result.scopeWarning).toContain("not unique-human coverage");
 expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",expect.objectContaining({p_business_id:cafeA,p_view:"cv_customer_visits"}));
});

it("unattended canonical reads are aggregate-only, never personal records, groups or filter values",async()=>{
 const rpc=vi.fn(async()=>({data:{rows:[{"count_data.aiCafeCustomer.identityRef":2}],sourceCount:5,sourceMix:{toast:5}},error:null}));
 const base={...query,view:"cv_toast_records",group_by:null,columns:null,
  filters:[{column:"record_type",op:"=",value:"check"}],
  metrics:[{fn:"count",column:"data.aiCafeCustomer.identityRef"}]};
 const ctx={db:{rpc} as never,businessId:cafeA,aggregateOnly:true};
 const observed=await dataQueryTools.query_data.execute(base,ctx);
 expect(observed).toMatchObject({customerEvidence:true,aggregateOnly:true,view:"cv_toast_records",rows:[{"count_data.aiCafeCustomer.identityRef":2}]});
 for(const attempt of [
  {...base,metrics:null,columns:["data.customer.email"]},
  {...base,group_by:["data.aiCafeCustomer.identityRef"]},
  {...base,filters:[{column:"data.customer.email",op:"=",value:"example@invalid.test"}]}
 ]){
  expect((await dataQueryTools.query_data.execute(attempt,ctx)).error).toBe("unattended_aggregate_required");
 }
 expect(rpc).toHaveBeenCalledTimes(1);
 const owner=await dataQueryTools.query_data.execute({...base,metrics:null,columns:["data.customer.email"]},{db:{rpc} as never,businessId:cafeA});
 expect(owner.error).toBeUndefined();
 expect(rpc).toHaveBeenCalledTimes(2);
});

it("bounds the implicit projection for the wider customer visit view",async()=>{
 const rpc=vi.fn(async()=>({data:{rows:[],sourceCount:0,truncated:false},error:null}));
 await dataQueryTools.query_data.execute({...query,view:"cv_customer_visits",columns:null,group_by:null,metrics:null,filters:null},{db:{rpc} as never,businessId:cafeA});
 const args=(rpc.mock.calls[0] as unknown as [string,{p_columns:string[]}])[1];
 expect(args.p_columns.length).toBeLessThanOrEqual(20);
 expect(args.p_columns).toContain("identity_ref");
});

// Exercise every advertised customer canonical column through the same registered
// schema/dispatch, not a fixed list of convenient questions. Independent SQL
// fixture tests validate data semantics; this test validates request grammar.
it("keeps every published customer field discoverable and queryable in the registered tool",async()=>{
 const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:{rows:[],sourceCount:0,truncated:false},error:null}));
 const ctx={db:{rpc} as never,businessId:cafeA};
 for(const view of ["cv_customer_visits","cv_customer_products"] as const){
  const keys=Object.keys(canonicalDictionary[view].columns);
  expect(keys.length).toBeGreaterThan(20);
  const catalog=await dataQueryTools.describe_data.execute({view},ctx);
  expect(catalog.views).toEqual(expect.arrayContaining([expect.objectContaining({name:view,
   columns:expect.arrayContaining(keys.map(name=>expect.objectContaining({name})))})]));
  for(const field of keys){
   const result=await dataQueryTools.query_data.execute({...query,view,columns:null,filters:null,group_by:null,
    metrics:[{fn:"count",column:field}]},ctx);
   expect(result.error,view+"."+field).toBeUndefined();
   expect(rpc).toHaveBeenLastCalledWith("ai_query_view",expect.objectContaining({p_business_id:cafeA,p_view:view,
    p_metrics:[{fn:"count",column:field}]}));
  }
 }
 expect(rpc).toHaveBeenCalledTimes(Object.keys(canonicalDictionary.cv_customer_visits.columns).length+
  Object.keys(canonicalDictionary.cv_customer_products.columns).length);
});

it("allows unattended coverage counts but blocks numeric reductions of arbitrary personal raw fields",async()=>{
 const rpc=vi.fn(async()=>({data:{rows:[],sourceCount:0,truncated:false},error:null}));
 const ctx={db:{rpc} as never,businessId:cafeA,aggregateOnly:true};
 const base={...query,view:"cv_toast_records",columns:null,group_by:null,filters:null,order_by:null};
 for(const field of ["data.customer.phone","data.guest.externalCustomerNumber","data.customer.email","data.aiCafeCustomer.identityRef"]){
  for(const fn of ["min","max","sum","avg"]){
   expect((await dataQueryTools.query_data.execute({...base,metrics:[{fn,column:field}]},ctx)).error)
    .toBe("unattended_aggregate_required");
  }
 }
 expect(rpc).not.toHaveBeenCalled();
 for(const [fn,column] of [["count","data.customer.phone"],["count_distinct","data.aiCafeCustomer.identityRef"],
  ["sum","data.aiCafeCustomer.netSalesCents"],["avg","data.quantity"]]){
  expect((await dataQueryTools.query_data.execute({...base,metrics:[{fn,column}]},ctx)).error).toBeUndefined();
 }
 expect(rpc).toHaveBeenCalledTimes(4);
});

it("labels raw guest and loyalty paths as customer evidence without inventing derived identity",async()=>{
 const coverage={scope:"all_eligible_checks_in_period",eligibleChecks:5,linkedChecks:2,namedChecks:3,
  knownMoneyChecks:5,linkedKnownMoneyChecks:2,recordedNetCents:500,linkedRecordedNetCents:200,
  expectedLocationDays:1,completeLocationDays:1,complete:true};
 const rpc=vi.fn(async()=>({data:{rows:[{}],sourceCount:5,customerCoverage:coverage},error:null}));
 const ctx={db:{rpc} as never,businessId:cafeA};
 for(const column of ["data.customer.guid","data.guest.preferences.favoriteDrink","data.loyaltyAccount.guid","data.payer.name"]){
  const result=await dataQueryTools.query_data.execute({...query,view:"cv_toast_records",columns:null,group_by:null,filters:null,
   metrics:[{fn:"count",column}],order_by:null},ctx);
  expect(result).toMatchObject({customerEvidence:true,customerCoverage:coverage});
 }
});
