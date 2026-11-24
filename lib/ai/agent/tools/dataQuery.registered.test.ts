import {describe,it,expect,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";
import {dataQueryTools} from "./dataQuery";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {businessCostSummaryFromSnapshot} from "@/lib/operating/businessCosts";
import {breakEvenSnapshotInputs} from "@/lib/viewmodels/breakEvenViewModel";
import {type Economics} from "@/lib/calc/supervisorEconomics";

const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const caller=()=> {
 const rpc=vi.fn(async(_name:string,input:Record<string,unknown>)=>({
  data:{rows:[{source:"toast",business_date:"2026-10-20",guest_count:2}],
   sourceCount:1,sourceMix:{toast:1},truncated:false,hasIncomplete:false},error:null
 }));
 const context={
  asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",
  tools:{} as AgentToolContext["tools"],
  canonicalData:async()=>({db:{rpc} as never,businessId})
 } satisfies AgentToolContext;
 return {rpc,context};
};
describe("canonical data available to authenticated chat, not only standalone tools",()=>{
 it("registers both functions for the model and returns the dictionary",async()=>{
  expect(agentToolDefinitions.some(t=>t.name==="describe_data")).toBe(true);
  expect(agentToolDefinitions.some(t=>t.name==="query_data")).toBe(true);
  const result=await executeAgentTool("describe_data",{},caller().context);
  expect(result.source).toBe("canonical_dictionary");
  expect(result.views).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"cv_orders"}),
   expect.objectContaining({name:"cv_cash"}),
   expect.objectContaining({name:"cv_inventory"}),
   expect.objectContaining({name:"cv_kitchen"})
  ]));
 });
 it("describes the authoritative stock receipt state on the same dictionary path",async()=>{
  const result=await executeAgentTool("describe_data",{record_type:null,view:"cv_inventory",field_prefix:null},caller().context);
  expect(result.views).toEqual([expect.objectContaining({
   name:"cv_inventory",meaning:expect.stringContaining("evidence_state")
  })]);
 });
 it("labels pre-migration or stale stock rows incomplete without assuming their quantity is live",async()=>{
  const {context}=caller();
  const query={view:"cv_inventory",columns:["stock_status","quantity","data"],
   filters:null,group_by:null,metrics:null,date_from:"2026-10-20",date_to:"2026-10-20",
   order_by:null,limit:50};
  const result=await executeAgentTool("query_data",query,context);
  expect(result.missing).toContain("inventoryStockPartial");
 });
 it("cannot leak pre-receipt stock from sparse columns or unscoped aggregates",async()=>{
  const rpc=vi.fn(async()=>({error:null,data:{rows:[{source:"toast",
   menu_item_ref:"item",quantity:7,stock_status:"QUANTITY",
   data:{evidence_state:"source_unverified",source_as_of:"2026-10-20T11:00:00Z"}}],
   sourceCount:1,sourceMix:{toast:1},truncated:false}}));
  const context=await caller().context.canonicalData();
  const db={rpc} as never;
  const base={view:"cv_inventory",columns:["menu_item_ref","quantity"],filters:null,
   group_by:null,metrics:null,date_from:"2026-10-20",date_to:"2026-10-20",
   order_by:null,limit:5};
  const plain=await dataQueryTools.query_data.execute(base,{...context,db});
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_columns:expect.arrayContaining(["source","data","quantity"])}));
  expect(plain.rows[0]).toMatchObject({quantity:null,stock_status:null});
  expect(plain.missing).toContain("inventoryStockPartial");
  const unsafe=await dataQueryTools.query_data.execute({...base,columns:null,
   metrics:[{fn:"sum",column:"quantity"}]}, {...context,db});
  expect(unsafe.missing).toContain("inventory_quantity_requires_current_evidence");
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("refuses mixed-unit or unscoped stock math even with a valid freshness label",async()=>{
  const rpc=vi.fn(async()=>({error:null,data:{rows:[{sum_quantity:7}],
   sourceCount:1,sourceMix:{toast:1},truncated:false}}));
  const context={...(await caller().context.canonicalData()),db:{rpc} as never};
  const base={view:"cv_inventory",columns:null,filters:[{
    column:"data.evidence_state",op:"=",value:"observed_current"}],
   group_by:null,metrics:[{fn:"sum",column:"quantity"}],
   date_from:"2026-10-20",date_to:"2026-10-20",order_by:null,limit:5};
  const ambiguous=await dataQueryTools.query_data.execute(base,context);
  expect(ambiguous.missing).toContain("inventory_quantity_requires_current_evidence");
  const byQty=await dataQueryTools.query_data.execute({...base,
   metrics:[{fn:"count",column:"source_ref"}],group_by:["quantity"]},context);
  expect(byQty.missing).toContain("inventory_quantity_requires_current_evidence");
  const incorrectOwnerUnits=await dataQueryTools.query_data.execute({...base,
   filters:[{column:"data.evidence_state",op:"=",value:"dated_owner_count"}],
   metrics:[{fn:"sum",column:"data.quantity_base"}]},context);
  expect(incorrectOwnerUnits.missing).toContain("inventory_quantity_requires_current_evidence");
  expect(rpc).not.toHaveBeenCalled();
  const specific=await dataQueryTools.query_data.execute({...base,filters:[
   ...base.filters,{column:"menu_item_ref",op:"=",value:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]},context);
  expect(specific.error).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_filters:expect.arrayContaining([expect.objectContaining({column:"menu_item_ref"})])
  }));
 });
 it("routes a scoped chat query through the same safe query RPC",async()=>{
  const {rpc,context}=caller();
  const input={view:"cv_orders",columns:["business_date"],filters:null,
   group_by:["business_date"],metrics:[{fn:"count",column:"guest_count"}],date_from:"2026-10-20",date_to:"2026-10-20",
   order_by:null,limit:25};
  const result=await executeAgentTool("query_data",input,context);
  // Extra RPCs read Toast day coverage, but only one query executes the model's aggregation.
  expect(rpc.mock.calls.filter(([name])=>name==="ai_query_view")).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_business_id:businessId,p_view:"cv_orders",p_date_from:"2026-10-20",p_limit:25
  }));
  expect(result).toMatchObject({source:"canonical_data",empty:false});
  expect(result.rows).toHaveLength(1);
 });
 it("never sends a query when the authenticated scope is missing",async()=>{
  const {rpc,context}=caller();
  delete (context as Partial<AgentToolContext>).canonicalData;
  const result=await executeAgentTool("query_data",{
   view:"cv_orders",columns:null,filters:null,group_by:null,metrics:null,
   date_from:"2026-10-20",date_to:"2026-10-20",order_by:null,limit:null
  },context);
  expect(result.missing).toContain("canonical_reader_unavailable");
  expect(rpc).not.toHaveBeenCalled();
 });
 it("query helpers do not accept an arbitrary SQL table or owner-selected business",async()=>{
  const {rpc,context}=caller();
  const result=await dataQueryTools.query_data.execute({
   view:"public.memberships",columns:null,filters:null,group_by:null,metrics:null,
   date_from:"2026-10-20",date_to:"2026-10-20",order_by:null,limit:1
  },await context.canonicalData());
  expect(result.error).toBe("invalid_query");
  expect(rpc).not.toHaveBeenCalled();
 });
});

describe("optional official shared metric selection in registered query_data",()=>{
 it("retains exact shared expense and recurring-bill calculations without model-facing reporting functions",async()=>{
  const {context}=caller();
  const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
  const categoryRows=Array.from({length:21},(_,i)=>({categoryCode:"custom_"+i,label:"Cost "+i,amountCents:100+i,isEstimate:true,isMissing:false}));
  const ctx:AgentToolContext={...context,tools:{...context.tools,
   getRecordedExpenses:async()=>({available:true,value:{totalCents:12000} as never,quality:q}),
   getExpenseSummary:async()=>({available:true,value:categoryRows as never,quality:q}),
   getMonthlyBills:async()=>({available:true,value:{totalCents:15000} as never,quality:{...q,estimatedInputs:["configured_cost"]}})}};
  for(const name of ["get_expenses","get_bills"])expect(agentToolDefinitions.some(t=>t.name===name)).toBe(false);
  const period={from:"2026-10-01",to:"2026-10-20"};
  const expenses=await executeAgentTool("query_data",{official_metric:{id:"expenses",period_mode:null,period}},ctx);
  expect(expenses).toEqual({...await executeAgentTool("get_expenses",{period,category:null},ctx),metric_id:"expenses",metric_basis:"official_shared_definition"});
  expect(expenses.categories).toHaveLength(21);
  expect(expenses.recordedActualTotalCents).toBe(12000);
  const recurring=await executeAgentTool("query_data",{official_metric:{id:"recurring_bills",period_mode:null}},ctx);
  expect(recurring).toEqual({...await executeAgentTool("get_bills",{},ctx),metric_id:"recurring_bills",metric_basis:"official_shared_definition"});
  expect(recurring.estimated).toBe(true);
 });

 it("returns the same break-even calculation, period and quality as the shared screen basis",async()=>{
  const snapshot=getFixtureSnapshot();
  const basis=breakEvenSnapshotInputs(snapshot);
  const {context,rpc}=caller();
  const ctx:AgentToolContext={...context,asOf:snapshot.todayDateStr,
   readEconomics:async()=>({canonicalBreakEven:basis,
    economics:{openDaysBasis:"opening_hours"} as unknown as Economics,
    items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null})};
  const result=await executeAgentTool("query_data",{official_metric:{id:"break_even",period_mode:"month"}},ctx);
  const existing=await executeAgentTool("get_break_even",{period:"month"},ctx);
  expect(result).toEqual({...existing,metric_id:"break_even",metric_basis:"official_shared_definition"});
  expect(result.monthlyBreakEvenCents).toBe(basis.shared.salesPerMonthCents);
  expect(rpc).not.toHaveBeenCalled();
 });
 it("retires the redundant model-facing break-even tool but preserves every shared period and override",async()=>{
  expect(agentToolDefinitions.some(t=>t.name==="get_break_even")).toBe(false);
  const snapshot=getFixtureSnapshot();
  const {context}=caller();
  const ctx:AgentToolContext={...context,asOf:snapshot.todayDateStr,
   readEconomics:async()=>({canonicalBreakEven:breakEvenSnapshotInputs(snapshot),
    canonicalSnapshot:snapshot,
    economics:{openDaysBasis:"opening_hours"} as unknown as Economics,
    items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null})};
  for(const period of ["today","month_to_date","month"] as const){
   for(const overrides of [null,{ownerIngredientPackagingPercent:22,ownerProcessingFeePercent:3,
      ownerOpenDaysPerMonth:24,ownerNetSalesCents:123456,ownerSalesDays:4}]){
    const old=await executeAgentTool("get_break_even",{period,...overrides},ctx);
    const unified=await executeAgentTool("query_data",{official_metric:{id:"break_even",
     period_mode:period,break_even_overrides:overrides}},ctx);
    expect(unified).toEqual({...old,metric_id:"break_even",metric_basis:"official_shared_definition"});
   }
  }
 });
 it("retires the redundant model-facing profit declaration without losing period or shared-screen parity",async()=>{
  expect(agentToolDefinitions.some(t=>t.name==="get_profit")).toBe(false);
  const {context}=caller();
  const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
  const ctx:AgentToolContext={...context,tools:{
   ...context.tools,getProfitability:async()=>({available:true,value:{netSalesCents:20000,
    totalCostsCents:10000,ownerProfitCents:10000,operatingMargin:.5,
    coveredSalesDays:20,expectedSalesDays:20},quality})}};
  for(const period of ["month","last_month","last_week",{from:"2023-01-01",to:"2026-10-20"}] as const){
   const old=await executeAgentTool("get_profit",{period},ctx);
   const unified=await executeAgentTool("query_data",{official_metric:{id:"profit",
    period_mode:null,profit_period:period}},ctx);
   expect(unified).toEqual({...old,metric_id:"profit",metric_basis:"official_shared_definition"});
  }
  expect((await executeAgentTool("query_data",{official_metric:{id:"profit",period_mode:null,
   profit_period:"month"},date_from:"2026-10-01",date_to:"2026-10-20"},ctx)).error)
   .toBe("invalid_date_range");
 });
 it("retires the cost summary report while preserving the official period, coverage and unknown components",async()=>{
  const snapshot=getFixtureSnapshot();
  const {context}=caller();
  const period={from:snapshot.monthKey+"-01",to:snapshot.todayDateStr};
  const observed=businessCostSummaryFromSnapshot(snapshot,period);
  const partial={...observed,completeness:"partial" as const,
   observed:{...observed.observed,loadedStaff:false},missingInputs:["staffCostsUnobserved"]};
  const ctx:AgentToolContext={...context,asOf:snapshot.todayDateStr,tools:{...context.tools,getBusinessCostSummary:async()=>partial}};
  expect(agentToolDefinitions.some(t=>t.name==="get_cost_summary")).toBe(false);
  const old=await executeAgentTool("get_cost_summary",{period},ctx);
  const unified=await executeAgentTool("query_data",{official_metric:{id:"business_costs",period_mode:null,period}},ctx);
  expect(unified).toEqual({...old,metric_id:"business_costs",metric_basis:"official_shared_definition"});
  expect(unified.components).toMatchObject({loadedStaffCents:null});
  expect(unified.missing).toContain("staffCostsUnobserved");
  const missing=await executeAgentTool("query_data",{official_metric:{id:"business_costs",period_mode:null,period}},context);
  expect(missing.missing).toContain("costSummaryReaderUnavailable");
 });
 it("rejects ambiguous mixed selectors and missing scope before accessing a metric",async()=>{
  const {context}=caller();
  const readEconomics=vi.fn(async()=>{throw Error("must not be called");});
  const ctx={...context,readEconomics};
  const args={official_metric:{id:"break_even",period_mode:"month"}};
  expect((await executeAgentTool("query_data",{...args,sql:"select 1"},ctx)).missing).toContain("invalid_query");
  expect((await executeAgentTool("query_data",{...args,date_from:"2026-10-01"},ctx)).missing).toContain("invalid_date_range");
  expect((await executeAgentTool("query_data",args,{...ctx,canonicalData:undefined})).missing).toContain("canonical_reader_unavailable");
  expect(readEconomics).not.toHaveBeenCalled();
 });
});
