import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/timecardsForInterval.server",()=>({readTimecardsForInterval:async()=>[]}));
vi.mock("@/lib/data/posFactReaders.server",()=>({posFactReaders:()=>({peakHours:async()=>({available:false,value:null,quality:{missingInputs:["hours"],estimatedInputs:[],staleInputs:[]}})})}));
vi.mock("@/lib/data/todayLive.server",()=>({readSavedTodayLive:async()=>null,TODAY_LIVE_FRESH_MS:900000}));
const inputs=vi.hoisted(()=>({customer:vi.fn(async(_raw:unknown)=>({rows:[{count_source_ref:0,"count_data.aiCafeCustomer.identityRef":0,"count_data.aiCafeCustomer.displayName":0}],missing:[] as string[],truncated:false,error:undefined})),sales:vi.fn(),wages:vi.fn(),expenses:vi.fn(),costs:vi.fn(),products:vi.fn(),stock:vi.fn(),usage:vi.fn(),quotes:vi.fn(),snapshot:vi.fn(),menu:vi.fn()}));
vi.mock("@/lib/ai/agent/tools/dataQuery",()=>({dataQueryTools:{query_data:{execute:inputs.customer}}}));
vi.mock("@/lib/ai/supervisorReads.server",()=>({supervisorHistoricalReaders:()=>({salesTrend:inputs.sales})}));
vi.mock("@/lib/ai/supervisorFacts.server",()=>({supervisorFactReaders:()=>({recordedExpenses:inputs.expenses,productSales:inputs.products})}));
vi.mock("@/lib/data/agentReadSources.server",()=>({agentSourceReaders:()=>({ingredientCosts:inputs.costs})}));
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFacts:inputs.wages}));
vi.mock("@/lib/data/getMenuItemsForEdit",()=>({getMenuItemsForEdit:inputs.menu}));
vi.mock("@/lib/data/canonical/reads.server",()=>({readCanonicalView:inputs.stock}));
vi.mock("@/lib/data/usageVariance.server",()=>({readUsageVariance:inputs.usage}));
vi.mock("@/lib/data/supplierPurchasing.server",()=>({readSupplierPurchasingEvidence:inputs.quotes}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:inputs.snapshot}));
vi.mock("@/lib/operating/cafeState",()=>({cafeStateFromSnapshot:()=>({profitability:{available:false,value:null,quality:{missingInputs:["historical"],estimatedInputs:[],staleInputs:[]}}})}));
import {compareBusinessFacts,compareCheckedRefunds,refreshBusinessAnomalies,readCustomerTrendComparison} from "./businessAnomalies.server";
describe("canonical observation boundaries",()=>{
 it("distinguishes certified zero refunds, missing coverage and positive recovery",()=>{
  const check=(a:number|null,b:number|null)=>compareCheckedRefunds(a,b,"2026-11-12","2026-11-18");
  expect(check(3000,0)?.active).toBe(true);expect(check(0,0)?.active).toBe(false);
  expect(check(0,3000)?.active).toBe(false);expect(check(3000,null)).toBeNull();expect(check(null,3000)).toBeNull();
 });
 const compare=(current:number|null,previous:number|null)=>compareBusinessFacts("sales_decline","cafe",current,previous,"cents","2026-11-11","2026-11-17","2026-11-17","down");
 it("detects material decline, never turns missing into zero",()=>{
  expect(compare(800,1000)?.active).toBe(true);
  expect(compare(810,1000)?.active).toBe(false);
  expect(compare(1200,1000)?.active).toBe(false);
  expect(compare(null,1000)).toBeNull();
  expect(compare(0,null)).toBeNull();
  expect(compare(100,0)).toBeNull();
  expect(compare(0,1000)?.active).toBe(true);
 });
});

it("scheduled source reads create material incidents, retain unknown history and reconcile verified recovery",async()=>{
 const q={missingInputs:[],estimatedInputs:[],staleInputs:[]};
 const rows=(from:string,cents:number)=>Array.from({length:7},(_,i)=>({date:new Date(Date.parse(from+"T12:00:00Z")+i*86400000).toISOString().slice(0,10),netSalesCents:cents,wagesCents:100,laborWageStatus:"actual"}));
 let current=600,unknown=false;
 inputs.sales.mockImplementation(async(_id:string,period:{from:string;to:string})=>({available:true,value:rows(period.from,period.from==="2026-11-12"?current:1000),quality:unknown?{...q,missingInputs:["salesCoverage"]}:q}));
 inputs.wages.mockImplementation(async(_db:unknown,_id:string,from:string)=>rows(from,1000));
 inputs.expenses.mockResolvedValue({available:false,value:null,quality:q});
 inputs.costs.mockResolvedValue({value:{items:[]},quality:q});
 inputs.products.mockResolvedValue({available:false,value:null,quality:q});
 inputs.menu.mockResolvedValue({items:[]});
 inputs.stock.mockResolvedValue({rows:[],error:null,truncated:false});
 inputs.usage.mockResolvedValue({rows:[],provenance:{coverage:"incomplete"}});
 inputs.quotes.mockResolvedValue({quotes:[],ingredients:[],currency:"USD",truncated:false});
 inputs.snapshot.mockResolvedValue({});
 const incidents=new Map<string,boolean>();
 const rpc=vi.fn(async(_name:string,args:{p_key:string;p_active:boolean})=>{
  const created=args.p_active&&incidents.get(args.p_key)!==true;
  incidents.set(args.p_key,args.p_active);return {data:created,error:null};
 });
 const run=()=>refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"));
 await run();expect(incidents.get("sales_decline:cafe")).toBe(true);
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"sales_decline:cafe",p_active:true,p_payload:expect.objectContaining({current:4200,previous:7000})}));
 unknown=true;rpc.mockClear();await run();
 expect(incidents.get("sales_decline:cafe")).toBe(true);
 expect(rpc.mock.calls.some(([,args])=>args.p_key==="sales_decline:cafe")).toBe(false);
 expect(incidents.get("data_gap:sales_coverage")).toBe(true);
 unknown=false;current=1000;await run();
 expect(incidents.get("sales_decline:cafe")).toBe(false);
 expect(incidents.get("data_gap:sales_coverage")).toBe(false);
});

it("a failed reader persists an explicit gap without blocking independently verified sales",async()=>{
 inputs.sales.mockImplementation(async(_id:string,period:{from:string;to:string})=>({available:true,value:Array.from({length:7},()=>({netSalesCents:period.from==="2026-11-12"?600:1000})),quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]}}));
 inputs.expenses.mockRejectedValueOnce(Error("source_read_failed"));
 const rpc=vi.fn(async()=>({data:true,error:null}));
 await expect(refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"))).rejects.toThrow("business_anomaly_refresh_incomplete");
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"data_gap:reader_unavailable:expenses",p_active:true}));
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"sales_decline:cafe",p_active:true}));
});

it("uses observed old recipe quantities and never resolves their incident on missing history",async()=>{
 const q={missingInputs:[],estimatedInputs:[],staleInputs:[]};
 inputs.sales.mockResolvedValue({available:false,value:null,quality:q});
 inputs.expenses.mockResolvedValue({available:false,value:null,quality:q});
 inputs.costs.mockResolvedValue({value:{items:[{id:"ing",baseUnit:"g",costPerBaseUnitMicros:1000000}]},quality:q});
 inputs.products.mockResolvedValue({available:false,value:null,quality:q});
 inputs.menu.mockResolvedValue({items:[{id:"product",active:true,costSource:"recipe",priceCents:500,recipe:[{ingredientId:"ing",quantity:150}]}]});
 inputs.wages.mockResolvedValue([]);
 let history:Array<{product_id:string;ingredient_id:string;quantity:number;price_micros:number}>|null=[{product_id:"product",ingredient_id:"ing",quantity:100,price_micros:1000000}];
 const rpc=vi.fn(async(name:string,_args:unknown)=>({data:name==="supervisor_prior_recipe_evidence"?history:true,error:null}));
 const run=()=>refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"));
 await run();expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"product_cost:product",p_active:true,p_payload:expect.objectContaining({current:150,previous:100,unit:"cents_per_observed_recipe"})}));
 history=null;rpc.mockClear();await run();expect(rpc).not.toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"product_cost:product",p_active:false}));
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"data_gap:product_recipe_history",p_active:true}));
 history=[{product_id:"product",ingredient_id:"ing",quantity:150,price_micros:1000000}];rpc.mockClear();await run();
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"product_cost:product",p_active:false}));
});

it("the scheduled anomaly pass reconciles only comparable customer evidence and retains trends through low coverage",async()=>{
 const q={missingInputs:[],estimatedInputs:[],staleInputs:[]};
 inputs.sales.mockResolvedValue({available:false,value:null,quality:q});
 inputs.expenses.mockResolvedValue({available:false,value:null,quality:q});
 inputs.costs.mockResolvedValue({value:{items:[]},quality:q});
 inputs.products.mockResolvedValue({available:false,value:null,quality:q});
 inputs.menu.mockResolvedValue({items:[]});inputs.wages.mockResolvedValue([]);
 inputs.stock.mockResolvedValue({rows:[],error:null,truncated:false});
 inputs.usage.mockResolvedValue({rows:[],provenance:{coverage:"incomplete"}});
 inputs.quotes.mockResolvedValue({quotes:[],ingredients:[],currency:"USD",truncated:false});
 inputs.snapshot.mockResolvedValue({});
 let low=false,changed=true,emptySource=false,emptyComplete=false,optionalFailure=false;
 const implementation=async(raw:unknown)=>{
  const p=raw as {view:string;date_from:string;group_by?:string[];metrics:Array<{column:string}>};
  const recent=p.date_from==="2026-11-12"||p.date_from==="2026-08-21";
  if(emptySource)return {rows:[{count_source_ref:0,"count_data.aiCafeCustomer.identityRef":0,
   "count_data.aiCafeCustomer.displayName":0}],missing:["empty"],truncated:false,error:undefined,
   customerCoverage:{complete:emptyComplete,eligibleChecks:0,linkedChecks:0,expectedLocationDays:7}};
  if(optionalFailure&&p.metrics.some(m=>m.column==="historical_recipe_contribution_cents"))
   return {rows:[],missing:["source_read_failed"],error:"source_read_failed",truncated:false};
  if(p.view==="cv_customer_products"){
   if(!p.group_by?.length)return {rows:[{count_source_ref:100,count_quantity:100,sum_quantity:recent&&changed?250:150}],missing:[],truncated:false,error:undefined,customerCoverage:{complete:true}};
   if(p.group_by?.[0]==="product_ref"&&p.group_by.length===1){
    const ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"];
    const a=recent&&changed?80:40;
    return {rows:ids.map((product_ref,i)=>({product_ref,sum_quantity:i===0?a:100-a,count_quantity:20,count_source_ref:20})),
     missing:[],truncated:false,error:undefined,customerCoverage:{complete:true}};
   }
   if(p.group_by?.[0]==="modifier_ref"){
    const modifier_ref="33333333-3333-4333-8333-333333333333",other="44444444-4444-4444-8444-444444444444",a=recent&&changed?80:40;
    return {rows:[modifier_ref,other].map((id,i)=>({modifier_ref:id,sum_quantity:i===0?a:100-a,count_quantity:20,count_source_ref:20})),missing:[],truncated:false,error:undefined,customerCoverage:{complete:true}};
   }
   if(p.group_by?.length===2&&p.group_by[1]==="paired_product_ref"){
    const product_ref="11111111-1111-4111-8111-111111111111",a=recent&&changed?80:40;
    return {rows:["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"].map((paired_product_ref,i)=>({product_ref,paired_product_ref,sum_pair_occurrence:i===0?a:100-a,count_pair_occurrence:20,count_source_ref:20})),missing:[],truncated:false,error:undefined,customerCoverage:{complete:true}};
   }
   return {rows:[],missing:["empty"],truncated:false,error:undefined,customerCoverage:{complete:true}};
  }
  if(p.metrics.some(m=>m.column==="data.quantity"))return {rows:[{count_source_ref:100,"count_data.quantity":100,"sum_data.quantity":recent&&changed?250:150}],missing:[],truncated:false,error:undefined,customerCoverage:{complete:true}};
  const row:Record<string,number> =p.view==="cv_toast_records"?
   {count_source_ref:100,"count_data.aiCafeCustomer.identityRef":low&&recent?5:90,"count_data.aiCafeCustomer.displayName":80,
    "count_data.aiCafeCustomer.netSalesCents":100,"sum_data.aiCafeCustomer.netSalesCents":recent&&changed?60000:100000}:
   p.metrics.some(m=>m.column==="historical_recipe_contribution_cents")?
    {count_historical_recipe_contribution_cents:80,avg_historical_recipe_contribution_cents:recent&&changed?200:400}:
   p.metrics.some(m=>m.column==="observed_lapse_flag"||m.column==="observed_reappearance_flag")?
    Object.fromEntries(p.metrics.map((m,i)=>[(i===0?"count_":"sum_")+m.column,i===0?40:recent&&changed?20:8])):
   p.metrics.some(m=>m.column.startsWith("observed_return_"))?
    Object.fromEntries(p.metrics.map(m=>[`${m.column&&m===p.metrics[0]?"count":"sum"}_${m.column}`,m===p.metrics[0]?40:24])):

    {count_source_ref:80,count_distinct_identity_ref:60,sum_first_observed_visit:recent&&changed?40:60,
     sum_returning_visit:recent&&changed?40:20,count_net_sales_cents:80,avg_net_sales_cents:900,
     count_period_account_revenue_share_squared:60,sum_period_account_revenue_share_squared:recent&&changed?.3:.15};
  return {rows:[row],missing:[],truncated:false,error:undefined,customerCoverage:{complete:true,eligibleChecks:100,linkedChecks:90}};
 };
 inputs.customer.mockImplementation(implementation as never);
 const incidents=new Map<string,boolean>();
 const rpc=vi.fn(async(name:string,args:{p_key:string;p_active:boolean})=>{
  if(name==="supervisor_reconcile_business_anomaly")incidents.set(args.p_key,args.p_active);
  return {data:name==="supervisor_prior_recipe_evidence"?[]:true,error:null};
 });
 const run=()=>refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"));
 try{
  await run();expect(incidents.get("customer_trend:returning_visit_share")).toBe(true);
  const reread=()=>readCustomerTrendComparison({rpc} as never,"cafe","returning_visit_share",{from:"2026-11-12",to:"2026-11-18"});
  expect(await reread()).toMatchObject({key:"returning_visit_share",current:.5,previous:.25,active:true});
  expect(await readCustomerTrendComparison({rpc} as never,"cafe","returning_visit_share",{from:"2026-11-13",to:"2026-11-18"})).toBeNull();
  expect(incidents.get("customer_trend:linked_revenue_concentration")).toBe(true);
  expect(incidents.get("customer_trend:average_recipe_contribution")).toBe(true);
  expect(incidents.get("customer_trend:observed_long_gap_share")).toBe(true);
  expect(incidents.get("customer_trend:observed_reappearance_share")).toBe(true);
  expect(incidents.get("customer_trend:returning_product_mix:11111111-1111-4111-8111-111111111111")).toBe(true);
  const modifier="returning_modifier_mix:33333333-3333-4333-8333-333333333333";
  const basket="returning_basket_mix:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
  expect(incidents.get("customer_trend:"+modifier)).toBe(true);
  expect(incidents.get("customer_trend:"+basket)).toBe(true);
  for(const subject of [modifier,basket])expect(await readCustomerTrendComparison({rpc} as never,"cafe",subject,{from:"2026-11-12",to:"2026-11-18"})).toMatchObject({key:subject,current:.8,previous:.4,active:true});
  for(const horizon of [7,30,60,90])expect(incidents.get(`customer_trend:observed_return_${horizon}d`)).toBe(false);
  optionalFailure=true;rpc.mockClear();
  await expect(run()).rejects.toThrow("business_anomaly_refresh_incomplete");
  expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"customer_trend:returning_visit_share",p_active:true}));
  expect(rpc.mock.calls.some(([,p])=>p.p_key==="customer_trend:average_recipe_contribution")).toBe(false);
  expect(incidents.get("data_gap:reader_unavailable:customer_intelligence")).toBe(true);
  expect(incidents.get("customer_trend:average_recipe_contribution")).toBe(true);
  optionalFailure=false;low=true;rpc.mockClear();await run();
  expect(incidents.get("data_gap:customer_identity_coverage")).toBe(true);
  expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"customer_trend:anonymous_check_spend",p_active:true}));
  expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"customer_trend:anonymous_items_per_check",p_active:true}));
  expect(incidents.get("customer_trend:returning_visit_share")).toBe(true);
  expect(rpc.mock.calls.some(([,p])=>p.p_key==="customer_trend:returning_visit_share")).toBe(false);
  expect(await reread()).toBeNull();
  low=false;emptySource=true;rpc.mockClear();await run();
  expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"data_gap:customer_identity_coverage",p_active:true}));
  expect(rpc.mock.calls.some(([,p])=>p.p_key==="customer_trend:returning_visit_share")).toBe(false);
  emptyComplete=true;rpc.mockClear();await run();
  expect(rpc.mock.calls.some(([,p])=>p.p_key==="data_gap:customer_identity_coverage")).toBe(false);
  expect(incidents.get("data_gap:customer_identity_coverage")).toBe(true);
  emptySource=false;changed=false;await run();
  expect(await reread()).toMatchObject({active:false,current:.25,previous:.25});
  expect(incidents.get("data_gap:customer_identity_coverage")).toBe(false);
  expect(incidents.get("customer_trend:returning_visit_share")).toBe(false);
  expect(incidents.get("customer_trend:linked_revenue_concentration")).toBe(false);
  expect(incidents.get("customer_trend:average_recipe_contribution")).toBe(false);
  expect(incidents.get("customer_trend:observed_long_gap_share")).toBe(false);
  expect(incidents.get("customer_trend:observed_reappearance_share")).toBe(false);
  expect(incidents.get("customer_trend:returning_product_mix:11111111-1111-4111-8111-111111111111")).toBe(false);
  expect(incidents.get("customer_trend:"+modifier)).toBe(false);
  expect(incidents.get("customer_trend:"+basket)).toBe(false);
 }finally{
  inputs.customer.mockImplementation(async()=>({rows:[{count_source_ref:0,"count_data.aiCafeCustomer.identityRef":0,"count_data.aiCafeCustomer.displayName":0}],missing:[],truncated:false,error:undefined}));
 }
});
