import {describe,it,expect} from "vitest";
import {presentResponse} from "./presentation";
import {schemas,agentToolDefinitions,executeAgentTool} from "./index";
import {presentationSourceNames} from "@/lib/ai/conversations/presentation";
import {planSupplierOrder} from "@/lib/purchasing/planOrder";
import {projectInventoryEvidence} from "@/lib/calc/inventoryEvidence";
import type {AgentToolContext,AgentToolResult} from "./index";
const sales:AgentToolResult={source:"daily_rollups",period:{from:"2026-11-01",to:"2026-11-03"},missing:[],
 days:[{date:"2026-11-02",netSalesCents:1200},{date:"2026-11-03",netSalesCents:0}]};
const request={layout:"stack",panels:[{source:"daily_rollups",field:"daily_sales",kind:"line"}],suggestions:[]};
const ctx=(r:AgentToolResult=sales):Pick<AgentToolContext,"currency"|"asOf"|"turnResults"|"presentationResults">=>({currency:"USD",asOf:"2026-11-04",turnResults:()=>[{name:"get_sales",result:r}]});
describe("bound optional presentation",()=>{
 it("uses exact current values, including zero and actual covered dates",()=>{
  expect(presentResponse(request,ctx())).toMatchObject({accepted:true,presentation:{version:1,panels:[{
   currency:"USD",from:"2026-11-02",to:"2026-11-03",points:[{label:"2026-11-02",value:1200},{label:"2026-11-03",value:0}]}]}});
 });
 it("rejects model-provided values and arbitrary action fields",()=>{
  expect(presentResponse({...request,panels:[{...request.panels[0],value:100000}]},ctx()).accepted).toBe(false);
  expect(presentResponse({...request,action:"approve"},ctx()).accepted).toBe(false);
 });
 it("rejects missing, provisional, wrong-source and foreign/unavailable evidence",()=>{
  for(const r of [{...sales,missing:["sales"]},{...sales,provisional:true},{...sales,source:"other"}])
   expect(presentResponse(request,ctx(r)).accepted).toBe(false);
  expect(presentResponse(request,{...ctx(),turnResults:()=>[]}).accepted).toBe(false);
 });
 it("does not invent a currency",()=>expect(presentResponse(request,{...ctx(),currency:null}).accepted).toBe(false));
});

describe("Task16E canonical query and period binding",()=>{
 const result:AgentToolResult={source:"canonical_data",period:{from:"2026-11-01",to:"2026-11-03"},missing:[],
  rows:[{business_date:"2026-11-01",sum_net_sales_cents:1200},{business_date:"2026-11-02",sum_net_sales_cents:2400}]};
 const args={view:"cv_sales_days",date_from:"2026-11-01",date_to:"2026-11-03",
  group_by:["business_date"],metrics:[{fn:"sum",column:"net_sales_cents"}]};
 const request={layout:"stack",panels:[{source:"canonical_data",field:"sum_net_sales_cents",kind:"line"}],suggestions:[]};
 const canonicalCtx=(r=result,a=args)=>({...ctx(),turnResults:()=>[],
   presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(a),result:r}]});
 it("projects a previously authorized aggregate without an extra data read",()=>{
   expect(presentResponse(request,canonicalCtx())).toMatchObject({accepted:true,presentation:{panels:[{
    unit:"cents",source:"canonical_data",points:[{label:"2026-11-01",value:1200},{label:"2026-11-02",value:2400}]}]}});
 });
 it("rejects unsafe source, unknown unit, incompatible coverage and truncated rows",()=>{
   expect(presentResponse(request,canonicalCtx(result,{...args,view:"cv_cash"})).accepted).toBe(false);
   expect(presentResponse(request,canonicalCtx({...result,missing:["result_truncated"]})).accepted).toBe(false);
   expect(presentResponse(request,canonicalCtx(result,{...args,date_from:"2026-10-31"})).accepted).toBe(false);
   expect(presentResponse({...request,panels:[{...request.panels[0],field:"unverified"}]},canonicalCtx()).accepted).toBe(false);
 });
 it("requires period selection instead of silently choosing another period",()=>{
   const other={...sales,period:{from:"2026-10-01",to:"2026-10-02"},days:[{date:"2026-10-01",netSalesCents:300},{date:"2026-10-02",netSalesCents:500}]};
   const c={...ctx(),turnResults:()=>[{name:"get_sales",result:sales},{name:"get_sales",result:other}]};
   const q={layout:"stack",panels:[{source:"daily_rollups",field:"daily_sales",kind:"line"}],suggestions:[]};
   expect(presentResponse(q,c).accepted).toBe(false);
   expect(presentResponse({...q,panels:[{...q.panels[0],from:"2026-10-01",to:"2026-10-02"}]},c)).toMatchObject({accepted:true,presentation:{panels:[{points:[{label:"2026-10-01",value:300},{label:"2026-10-02",value:500}]}]}});
 });
});

describe("dated and modeled presentations",()=>{
 it("preserves multiday saved event dates, cancellation and unverified status without pretending live research",()=>{
  const events:AgentToolResult={source:"cafe_events",period:{from:"2026-11-01",to:"2026-11-10"},missing:[],events:[
   {name:"Market",startDate:"2026-11-03",endDate:"2026-11-05",status:"cancelled",lastVerifiedAt:"2026-11-02T12:00:00Z"},
   {name:"Fair",startDate:"2026-11-06",endDate:"2026-11-06",status:"found"}]};
  expect(presentResponse({layout:"stack",panels:[],agenda:"calendar_events",suggestions:[]},ctx(events))).toMatchObject({
   accepted:true,presentation:{agenda:{coverage:"partial",entries:[{label:"Market",date:"2026-11-03",endDate:"2026-11-05",status:"cancelled"},{label:"Fair",status:"unverified"}]}}});
 });
 it("separates draft future shifts from attendance and accepts overnight saved timings",()=>{
  const shifts:AgentToolResult={source:"scheduled_shifts",period:{from:"2026-11-09",to:"2026-11-15"},missing:["coverageDisabled"],scheduleSet:true,shifts:[
   {employeeName:"Team member",date:"2026-11-11",start:"22:00",end:"02:00",source:"ai_draft"}]};
  expect(presentResponse({layout:"stack",panels:[],agenda:"timeline_shifts",suggestions:[]},ctx(shifts))).toMatchObject({
   accepted:true,presentation:{agenda:{coverage:"partial",entries:[{date:"2026-11-11",endDate:"2026-11-12",status:"ai_draft"}]}}});
 });
 it("selects only previously calculated alternatives with an identical baseline and never accepts model amounts",()=>{
  const base:AgentToolResult={source:"scenario",period:null,missing:[],status:"estimate",provenance:"estimate",
   input:{kind:"bill",monthlyChangeCents:10000},before:{monthlyProfitCents:50000},after:{monthlyProfitCents:40000}};
  const next={...base,input:{kind:"bill",monthlyChangeCents:20000},after:{monthlyProfitCents:30000}};
  const c={...ctx(),turnResults:()=>[{name:"simulate_scenario",result:base},{name:"simulate_scenario",result:next}]};
  const req={layout:"stack",panels:[],scenario:"monthly_profit",suggestions:[]};
  expect(presentResponse(req,c)).toMatchObject({accepted:true,presentation:{scenario:{provenance:"estimate",cases:[
   {beforeCents:50000,afterCents:40000},{beforeCents:50000,afterCents:30000}]}}});
  expect(presentResponse({...req,afterCents:999999},c).accepted).toBe(false);
 });
 it("does not expose estimated or incomplete cost components as recorded costs",()=>{
  const costs:AgentToolResult={source:"business_costs",period:sales.period,missing:[],completeness:"complete",estimated:[],
   components:{ingredientsCents:100,loadedStaffCents:200,cardFeesCents:0,runningCostsCents:50}};
  const req={layout:"stack",panels:[{source:"business_costs",field:"cost_components",kind:"bar"}],suggestions:[]};
  expect(presentResponse(req,ctx(costs))).toMatchObject({accepted:true,presentation:{panels:[{points:[{label:"Ingredients",value:100},{label:"Staff",value:200},{label:"Card fees",value:0},{label:"Running costs",value:50}]}]}});
  expect(presentResponse(req,ctx({...costs,estimated:["labor"]})).accepted).toBe(false);
  expect(presentResponse(req,ctx({...costs,components:{...costs.components as object,cardFeesCents:null}})).accepted).toBe(false);
 });
});

describe("ranked and downloadable presentation",()=>{
 it("permits a text-only report request without invented values or arbitrary file paths",()=>{
  const req={layout:"stack",panels:[],suggestions:[],report:true};
  expect(presentResponse(req,ctx())).toMatchObject({accepted:true,presentation:{report:true,panels:[]}});
  expect(presentResponse({...req,filePath:"/private"},ctx()).accepted).toBe(false);
 });
 it("ranks the exact values without manufacturing another metric",()=>{
  const req={layout:"stack",panels:[{source:"item_sales",field:"item_units",kind:"ranked_table"}],suggestions:[]};
  const result:AgentToolResult={source:"item_sales",period:sales.period,missing:[],items:[{name:"Latte",units:2},{name:"Tea",units:4}]};
  expect(presentResponse(req,ctx(result))).toMatchObject({accepted:true,presentation:{panels:[{points:[{label:"Tea",value:4},{label:"Latte",value:2}]}]}});
 });
});

it("does not draw a continuous line across an unobserved day; allows exact table values",()=>{
 const sparse={...sales,days:[{date:"2026-11-01",netSalesCents:100},{date:"2026-11-03",netSalesCents:200}]};
 expect(presentResponse(request,ctx(sparse)).accepted).toBe(false);
 expect(presentResponse({...request,panels:[{...request.panels[0],kind:"table"}]},ctx(sparse))).toMatchObject({accepted:true,presentation:{panels:[{points:[{label:"2026-11-01",value:100},{label:"2026-11-03",value:200}]}]}});
});

describe("Task16E reusable canonical record table",()=>{
 const result:AgentToolResult={source:"canonical_data",period:sales.period,missing:[],rows:[
  {dining_option:"Takeaway",count_order_ref:0,sum_net_sales_cents:0},
  {dining_option:"Dine in",count_order_ref:7,sum_net_sales_cents:2450}]};
 const args={view:"cv_orders",date_from:sales.period!.from,date_to:sales.period!.to,
  group_by:["dining_option"],metrics:[{fn:"count",column:"order_ref"},{fn:"sum",column:"net_sales_cents"}],filters:[]};
 const context=(r=result,a=args)=>({...ctx(),turnResults:()=>[],presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(a),result:r}]});
 const req={layout:"stack",panels:[{source:"canonical_data",field:"rows",kind:"table"}],suggestions:[]};
 it("projects multiple exact metrics and labels from one existing authenticated query",()=>{
   expect(presentResponse(req,context())).toMatchObject({accepted:true,presentation:{tables:[{
    view:"cv_orders",currency:"USD",coverage:"stored",
    columns:[{unit:"label"},{unit:"count"},{unit:"cents"}],rows:[["Takeaway",0,0],["Dine in",7,2450]]}]}});
 });
 it("labels a truncated result partial; distinguishes missing values from zero",()=>{
   expect(presentResponse(req,context({...result,truncated:true,missing:["result_truncated"],rows:[
    {dining_option:"Takeaway",count_order_ref:0,sum_net_sales_cents:null}]}))).toMatchObject({
      accepted:true,presentation:{tables:[{coverage:"partial",rows:[["Takeaway",0,null]]}]}});
 });
 it("rejects a foreign/unavailable read or an unselected data dump; no invented values",()=>{
   expect(presentResponse(req,context({...result,error:"invalid_scope"})).accepted).toBe(false);
   expect(presentResponse(req,context(result,{...args,group_by:[],metrics:[],columns:["data","business_id"]} as typeof args)).accepted).toBe(false);
   expect(presentResponse({...req,panels:[{...req.panels[0],values:[77]}]},context()).accepted).toBe(false);
 });
});
describe("Task16E interactive calculator selection",()=>{
 const r:AgentToolResult={source:"calculate",period:null,missing:[],purpose:"Order quantity estimate",kind:"estimate",
  inputs:[{name:"price",label:"Unit cost",unit:"cents",valueCents:250,from:"tool",ref:"get_product_costs:item.ingredientsCentsToday"},
          {name:"qty",label:"Quantity",unit:"count",quantity:10,from:"owner_said",ref:"owner"}],
  steps:[{id:"total",op:"multiply",args:["price","qty"],unit:"cents",valueCents:2500}],result:{unit:"cents",valueCents:2500}};
 const c=(result=r,screen_number="none")=>({...ctx(),turnResults:()=>[],presentationResults:()=>[{name:"calculate",arguments:JSON.stringify({screen_number,inputs:[{name:"price",tool:"get_product_costs",path:"item.ingredientsCentsToday"},{name:"qty",owner_value:10,owner_unit:"count"}]}),result}]});
 const q={layout:"stack",panels:[],suggestions:[],calculator:true};
 it("uses the previously calculated result, only owner-supplied assumption editable",()=>{
  expect(presentResponse(q,c())).toMatchObject({accepted:true,presentation:{calculator:{inputs:[
   {id:"price",editable:false,value:{valueCents:250}},{id:"qty",editable:true,value:{quantity:10}}],
   original:{unit:"cents",valueCents:2500}}}});
 });
 it("rejects changing a screen number, partial source, rounded mismatch or no owner assumption",()=>{
  expect(presentResponse(q,c(r,"profit")).accepted).toBe(false);
  expect(presentResponse(q,c({...r,basedOnPartialData:["get_product_costs"]})).accepted).toBe(false);
  expect(presentResponse(q,c({...r,result:{unit:"cents",valueCents:2501}})).accepted).toBe(false);
  const rounded={...r,inputs:[{name:"price",label:"Unit cost",unit:"count",quantity:2.5,from:"tool"},{name:"qty",label:"Quantity",unit:"count",quantity:10,from:"owner_said"}],result:{unit:"count",quantity:25}};
  expect(presentResponse(q,c(rounded)).accepted).toBe(false);
  expect(presentResponse(q,c({...r,inputs:(r.inputs as Array<Record<string,unknown>>).map(i=>({...i,from:"tool"}))})).accepted).toBe(false);
 });
});

describe("Task16E selected source file references",()=>{
 const id="11111111-1111-4111-8111-111111111111";
 const req={layout:"stack",panels:[],suggestions:[],files:true};
 it("references only selected already-verified attachment IDs, not model paths or URLs",()=>{
  expect(presentResponse(req,{...ctx(),presentationAttachments:[id]})).toMatchObject({accepted:true,presentation:{files:[id]}});
  expect(presentResponse(req,ctx()).accepted).toBe(false);
  expect(presentResponse({...req,files:[id]},ctx()).accepted).toBe(false);
  expect(presentResponse({...req,href:"https://example.com/private"},ctx()).accepted).toBe(false);
 });
});

it("renders canonical price scenarios and the exact estimate metric, with a verified item identity",()=>{
 const itemId="11111111-1111-4111-8111-111111111111";
 const scenario:AgentToolResult={source:"scenario",period:null,missing:[],status:"estimate",provenance:"estimate",
  input:{kind:"price",itemId,oldPriceCents:400,newPriceCents:450,weeklyUnits:50},
  before:{itemMarginCents:250,monthlyProfitCents:45000},after:{itemMarginCents:300,monthlyProfitCents:50000}};
 const menu:AgentToolResult={source:"menu_items",period:null,missing:[],items:[{id:itemId,name:"Latte"}]};
 const req={layout:"stack",panels:[],suggestions:[],scenario:"item_margin"};
 const qualified={...ctx(),turnResults:()=>[{name:"get_menu_items",result:menu},{name:"simulate_scenario",result:scenario}]};
 expect(presentResponse(req,qualified)).toMatchObject({accepted:true,presentation:{scenario:{title:"Modeled item margin",cases:[{assumption:expect.stringContaining("Latte"),beforeCents:250,afterCents:300}]}}});
 expect(presentResponse(req,ctx(scenario)).accepted).toBe(false);
});
it("uses actual roster evidence and executed scenario arguments for staffing alternatives",()=>{
 const staffId="22222222-2222-4222-8222-222222222222";
 const roster:AgentToolResult={source:"employees+scheduled_shifts",period:sales.period,missing:[],people:[{id:staffId,name:"Team lead"}]};
 const scenario:AgentToolResult={source:"scenario",period:null,missing:[],status:"estimate",provenance:"estimate",
  input:{kind:"shift",hoursChange:2,shiftsPerWeek:5,wageCents:2000,payrollTaxRate:0.1},
  before:{monthlyBreakEvenCents:100000},after:{monthlyBreakEvenCents:120000}};
 const req={layout:"stack",panels:[],suggestions:[],scenario:"monthly_break_even"};
 const c={...ctx(),turnResults:()=>[{name:"get_team",result:roster},{name:"simulate_scenario",result:scenario}],
  presentationResults:()=>[{name:"simulate_scenario",arguments:JSON.stringify({staffId}),result:scenario}]};
 expect(presentResponse(req,c)).toMatchObject({accepted:true,presentation:{scenario:{cases:[{assumption:expect.stringContaining("Team lead"),beforeCents:100000,afterCents:120000}]}}});
});

describe("independent semantic composition",()=>{
 it("selects distinct reads by exact reference and compares compatible series",()=>{
  const a={...sales,period:{from:"2026-11-01",to:"2026-11-02"},days:[{date:"2026-11-01",netSalesCents:100},{date:"2026-11-02",netSalesCents:200}]};
  const b={...sales,days:[{date:"2026-11-02",netSalesCents:300},{date:"2026-11-03",netSalesCents:400}]};
  const c={...ctx(),turnResults:()=>[{name:"get_sales",result:a},{name:"get_sales",result:b}],
    presentationResults:()=>[{ref:"r1",name:"get_sales",arguments:"{}",result:a},{ref:"r2",name:"get_sales",arguments:"{}",result:b}]};
  const sel={source:"daily_rollups",field:"daily_sales",kind:"line"};
  const req={layout:"stack",panels:[{...sel,ref:"r2"},{...sel,ref:"r1"}],groups:[{layout:"compare",items:["p1","p0"]}],suggestions:[]};
  expect(presentResponse(req,c)).toMatchObject({accepted:true,presentation:{groups:[{layout:"compare",items:["panel1","panel0"]}],panels:[{points:[{value:300},{value:400}]},{points:[{value:100},{value:200}]}]}});
  expect(presentResponse({...req,panels:[{...sel,ref:"r99"}]},c).accepted).toBe(false);
 });
 it("does not discard a valid visual omitted from an optional arrangement or repeat a leaf",()=>{
  const q={...request,groups:[{layout:"grid",items:["p0","p0","calculator"]}]};
  expect(presentResponse(q,ctx())).toMatchObject({accepted:true,presentation:{groups:[{layout:"grid",items:["panel0"]}]}});
 });
});

it("shows safe stored current-day values as partial, never as final totals",()=>{
 const r:AgentToolResult={source:"canonical_data",period:sales.period,missing:["currentDayIncomplete"],rows:[{sum_net_sales_cents:2400}],aggregate:{metric:"sum_net_sales_cents",value:2400,status:"so_far"}};
 const args={view:"cv_sales_days",date_from:sales.period!.from,date_to:sales.period!.to,group_by:null,metrics:[{fn:"sum",column:"net_sales_cents"}]};
 const c={...ctx(),presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(args),result:r}]};
 expect(presentResponse({layout:"stack",panels:[{source:"canonical_data",field:"sum_net_sales_cents",kind:"metric"}],suggestions:[]},c)).toMatchObject({accepted:true,presentation:{panels:[{coverage:"partial",points:[{value:2400}]}]}});
});

describe("real typed producer presentation",()=>{
 it("uses the existing pack planner's subtotal and does not invent landed total",()=>{
   const ingredient={id:"11111111-1111-4111-8111-111111111111",name:"Milk",base_unit:"ml"};
   const quote={id:"22222222-2222-4222-8222-222222222222",supplier_name:"Farm A",item_name:"Milk",ingredient_id:ingredient.id,price_cents:450,package_count:1,package_unit:"gal",currency_code:"USD",source_kind:"supplier_quote",quoted_on:"2026-11-01",valid_until:"2026-11-20",available_status:"confirmed",available_checked_at:"2026-11-03",delivery_on:"2026-11-06"};
   const plan=planSupplierOrder({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:5,unit:"gal"}],ingredients:[ingredient],quotes:[quote],currency:"USD",today:"2026-11-04",neededBy:"2026-11-07",preferredSupplier:null});
   const r:AgentToolResult={source:"supplier_purchase_plan",period:null,sourceTrust:"owner_reported",...plan};
   expect(presentResponse({layout:"stack",panels:[{source:r.source,field:"rows",kind:"table"},{source:r.source,field:"subtotal",kind:"bar"}],suggestions:[]},ctx(r))).toMatchObject({accepted:true,presentation:{panels:[{coverage:"partial",points:[{label:"Farm A",value:2250}]}],tables:[{coverage:"partial",rows:[["Farm A",2250,null,null]]}]}});
 });
 it("uses actual inventory projection; stale retained quantity stays null",()=>{
   const projection=projectInventoryEvidence([{source:"toast",quantity:12,data:{evidence_state:"not_observed",source_as_of:"2026-11-01"}},{source:"app",quantity:0,data:{ingredient_name:"Milk",base_unit:"ml",count_date:"2026-11-04"}}]);
   const r:AgentToolResult={source:"inventory",period:sales.period,scope:"observed_inventory_only",missing:projection.missing,inventory:projection.rows};
   expect(presentResponse({layout:"stack",panels:[{source:"inventory",field:"rows",kind:"table"}],suggestions:[]},ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["Unnamed stock record",null,null,"not_observed","2026-11-01"],["Milk",0,"ml","dated_owner_count","2026-11-04"]]}]}});
 });
});

 it("composes nested groups from scoped current results without allowing numeric or action injection",()=>{
 const nested={...request,panels:[request.panels[0],{...request.panels[0],kind:"bar"}],groups:[{id:"g0",layout:"stack",items:["g1"]},{id:"g1",layout:"grid",items:["p0","p1"]}]};
 expect(presentResponse(nested,ctx())).toMatchObject({accepted:true,presentation:{groups:[{id:"g0",layout:"stack",items:["g1"]},{id:"g1",layout:"grid",items:["panel0","panel1"]}]}});
 const cycle={...nested,groups:[{id:"g0",layout:"stack",items:["g1","p0"]},{id:"g1",layout:"grid",items:["g0","p1"]}]};
 const safe=presentResponse(cycle,ctx());expect(safe).toMatchObject({accepted:true,presentation:{panels:[{},{}]}});expect(safe.presentation).not.toHaveProperty("groups");
 });
 it("projects explicitly counted saved records across formerly blocked domains while refusing stock or personal identity inference",()=>{
 for(const view of ["cv_staff","cv_bills","cv_owner_facts","cv_inventory"]){
 const result:AgentToolResult={source:"canonical_data",period:sales.period,missing:[],rows:[{business_date:"2026-11-01",count_source_ref:2}]};
 const args={view,date_from:sales.period!.from,date_to:sales.period!.to,group_by:["business_date"],metrics:[{fn:"count",column:"source_ref"}]};
 const context={...ctx(),turnResults:()=>[],presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(args),result}]};
 expect(presentResponse({...request,panels:[{source:"canonical_data",field:"count_source_ref",kind:"bar"}]},context)).toMatchObject({accepted:true,presentation:{panels:[{title:"Saved record count",unit:"count",points:[{value:2}]}]}});
 }
 });

it("reuses safe reader table columns for generic numeric components without guessing missing values or units",()=>{
 const r:AgentToolResult={source:"menu_items",period:sales.period,missing:[],items:[{name:"Latte",priceStatus:"fixed",priceCents:450},{name:"Tea",priceStatus:"fixed",priceCents:300}]};
 const req={layout:"stack",panels:[{source:"menu_items",field:"table:catalog_price",kind:"bar"}],suggestions:[]};
 expect(presentResponse(req,ctx(r))).toMatchObject({accepted:true,presentation:{panels:[{unit:"cents",points:[{label:"Latte",value:450},{label:"Tea",value:300}]}]}});
 expect(presentResponse(req,ctx({...r,items:[{name:"Latte",priceStatus:"open",priceCents:450}]})).accepted).toBe(false);
 const stock:AgentToolResult={source:"inventory",period:sales.period,missing:[],scope:"observed_inventory_only",inventory:[{ingredient_name:"Milk",quantity:0,quantity_unit:"ml",evidence_state:"dated_owner_count",quantity_state:"known",source_as_of:"2026-11-03"},{ingredient_name:"Cream",quantity:5,quantity_unit:"ml",evidence_state:"observed_current",quantity_state:"known",source_as_of:"2026-11-04"}]};
 const q={layout:"stack",panels:[{source:"inventory",field:"table:quantity",kind:"bar"}],suggestions:[]};
 expect(presentResponse(q,ctx(stock))).toMatchObject({accepted:true,presentation:{panels:[{title:"Quantity (ml)",measurement:"ml",coverage:"partial",points:[{value:0},{value:5}]}]}});
 expect(presentResponse(q,ctx({...stock,inventory:[(stock.inventory as object[])[0],{...(stock.inventory as object[])[1],quantity_unit:"g"}]})).accepted).toBe(false);
 expect(presentResponse(q,ctx({...stock,inventory:[{...(stock.inventory as object[])[0],evidence_state:"not_observed"}]})).accepted).toBe(false);
});

it("projects canonical typed table columns without a domain-specific chart adapter and refuses truncated measures",()=>{
 const r:AgentToolResult={source:"canonical_data",period:sales.period,missing:[],rows:[{dining_option:"Takeaway",sum_net_sales_cents:100},{dining_option:"Dine in",sum_net_sales_cents:200}]};
 const args={view:"cv_orders",date_from:sales.period!.from,date_to:sales.period!.to,group_by:["dining_option"],metrics:[{fn:"sum",column:"net_sales_cents"}]};
 const c=(result=r)=>({...ctx(),presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(args),result}]});
 const req={layout:"stack",panels:[{source:"canonical_data",field:"table:sum_net_sales_cents",kind:"bar"}],suggestions:[]};
 expect(presentResponse(req,c())).toMatchObject({accepted:true,presentation:{panels:[{unit:"cents",points:[{label:"Takeaway",value:100},{label:"Dine in",value:200}]}]}});
 expect(presentResponse(req,c({...r,truncated:true})).accepted).toBe(false);
});

it("uses dictionary field semantics instead of admitting identifiers or raw JSON as numeric measures",()=>{
 const req={layout:"stack",panels:[{source:"canonical_data",field:"count_business_id",kind:"bar"}],suggestions:[]};
 const result:AgentToolResult={source:"canonical_data",period:sales.period,missing:[],rows:[{business_date:"2026-11-01",count_business_id:1}]};
 const args={view:"cv_staff",date_from:sales.period!.from,date_to:sales.period!.to,group_by:["business_date"],metrics:[{fn:"count",column:"business_id"}]};
 const c={...ctx(),presentationResults:()=>[{name:"query_data",arguments:JSON.stringify(args),result}]};
 expect(presentResponse(req,c).accepted).toBe(false);
 expect(presentResponse({...req,panels:[{...req.panels[0],field:"table:count_business_id"}]},c).accepted).toBe(false);
});

describe("labor evidence presentation",()=>{
 const labor:AgentToolResult={source:"labor_and_attendance",period:sales.period,missing:[],estimated:[],laborDays:[
  {date:"2026-11-02",wagesCents:1500,staffTaxCents:300,loadedStaffCostCents:1800,wageStatus:"actual"},
  {date:"2026-11-03",wagesCents:0,staffTaxCents:0,loadedStaffCostCents:0,wageStatus:"actual"}]};
 const q={layout:"stack",panels:[{source:"labor_and_attendance",field:"daily_labor_cost",kind:"line"}],suggestions:[]};
 it("binds the loaded labor cost without recalculating or implying whole payroll coverage",()=>{
  expect(presentResponse(q,ctx(labor))).toMatchObject({accepted:true,presentation:{panels:[{coverage:"partial",points:[{label:"2026-11-02",value:1800},{label:"2026-11-03",value:0}]}]}});
 });
 it("preserves estimate and missing wage rows instead of charting them as actual",()=>{
  const mixed={...labor,estimated:["laborWageEstimate"],laborDays:[
   {date:"2026-11-01",wagesCents:100,staffTaxCents:25,loadedStaffCostCents:125,wageStatus:"estimate"},
   {date:"2026-11-02",wagesCents:0,staffTaxCents:0,loadedStaffCostCents:0,wageStatus:"missing"}]};
  expect(presentResponse(q,ctx(mixed)).accepted).toBe(false);
  expect(presentResponse({...q,panels:[{source:"labor_and_attendance",field:"rows",kind:"table"}]},ctx(mixed))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["2026-11-01",100,25,125,"Estimate"],["2026-11-02",null,null,null,"Unavailable"]]}]}});
  expect(presentResponse(q,ctx({...labor,missing:["laborReadFailed"]})).accepted).toBe(false);
 });
});

describe("typed operational summary presentation",()=>{
 const q=(source:string,field="rows",kind="table")=>({layout:"stack",panels:[{source,field,kind}],suggestions:[]});
 it("projects returned hourly sales with zero, coverage and the local clock without guessing absent hours",()=>{
  const r:AgentToolResult={source:"get_peak_hours",period:sales.period,missing:["hourlySalesDatesNotObserved"],recordedRows:2,otherHoursOmitted:false,
   topHours:[{hourLocal:9,netSalesCents:1200,ordersCount:3},{hourLocal:10,netSalesCents:0,ordersCount:0}]};
  expect(presentResponse(q(r.source),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["09:00",1200,3],["10:00",0,0]]}]}});
  expect(presentResponse(q(r.source,"table:net_sales","bar"),ctx(r))).toMatchObject({accepted:true,presentation:{panels:[{coverage:"partial",points:[{label:"09:00",value:1200},{label:"10:00",value:0}]}]}});
  expect(presentResponse(q(r.source),ctx({...r,topHours:[{hourLocal:25,netSalesCents:1,ordersCount:1}]})).accepted).toBe(false);
 });
 it("only exposes employee comparisons when same-turn authorized identities uniquely match",()=>{
  const r:AgentToolResult={source:"get_employee_sales",period:sales.period,missing:[],recordedRows:2,employeeCount:2,employeesOmitted:false,totalAttributedNetSalesCents:1400,
   topEmployees:[{employeeId:"e1",netSalesCents:1200,ordersCount:3},{employeeId:"e2",netSalesCents:200,ordersCount:1}]};
  const res=presentResponse(q(r.source),ctx(r));
  expect(res).toMatchObject({accepted:true,presentation:{tables:[{rows:[["Returned evidence",1400,2]]}]}});
  expect(JSON.stringify(res)).not.toContain('"e1"');
  const roster:AgentToolResult={source:"employees+scheduled_shifts",period:sales.period,missing:[],people:[{id:"e1",name:"Owner test A"},{id:"e2",name:"Owner test B"}]};
  const c={...ctx(r),turnResults:()=>[{name:"get_employee_sales",result:r},{name:"get_team",result:roster}]};
  expect(presentResponse(q(r.source),c)).toMatchObject({accepted:true,presentation:{tables:[{rows:[["Owner test A",1200,3],["Owner test B",200,1]]}]}});
 });
 it("preserves payroll unknowns, never equating imported pay periods with a complete labor bill",()=>{
  const r:AgentToolResult={source:"get_payroll_facts",period:sales.period,missing:["payrollUnknown:netCents"],recordedPayPeriods:2,employeeCount:1,
   grossCents:4000,netCents:null,regularCents:3600,overtimeCents:400,doubleOvertimeCents:0,employeeTaxCents:200,employerTaxCents:300};
  expect(presentResponse(q(r.source),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["Gross pay",4000],["Net pay",null],["Regular pay",3600],["Overtime pay",400],["Double overtime pay",0],["Employee tax",200],["Employer tax",300]]}]}});
  expect(presentResponse(q(r.source),ctx({...r,recordedPayPeriods:0})).accepted).toBe(false);
 });
});

it("keeps model headings descriptive without discarding verified values or nested layout",()=>{
 for(const title of ["Profit: $9,999","Margin 27%","Profit ٩٩٩","Cost ９９９","Sales 12.00","Return ②"]){
  const q={...request,groups:[{id:"g0",layout:"stack",items:["g1"]},{id:"g1",layout:"details",title,items:["p0"]}]};
  const res=presentResponse(q,ctx());
  expect(res).toMatchObject({accepted:true,presentation:{groups:[{id:"g0",layout:"stack",items:["g1"]},{id:"g1",layout:"stack",items:["panel0"]}],panels:[{points:[{value:1200},{value:0}]}]}});
  expect(JSON.stringify(res)).not.toContain(title);
 }
 expect(presentResponse({...request,groups:[{id:"g0",layout:"details",title:"Recorded sales",items:["p0"]}]},ctx())).toMatchObject({accepted:true,presentation:{groups:[{layout:"details",title:"Recorded sales"}]}});
});

describe("additional typed producer contracts",()=>{
 const q=(source:string,field="rows",kind="table")=>({layout:"stack",panels:[{source,field,kind}],suggestions:[]});
 const checks=(source:string,result:Record<string,unknown>,rows:unknown[][],field="rows")=>expect(presentResponse(q(source,field),ctx({source,period:null,missing:[],...result}))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows}]}});
 it("preserves today's stale timestamp, provisional scope and zero",()=>{
  const r:AgentToolResult={source:"today_live",period:{from:"2026-11-04",to:"2026-11-04"},missing:["todayLiveLocationsFailed:1"],provisional:true,stale:true,readAt:"2026-11-04T10:00:00Z",netSalesCents:1200,orders:3,openChecks:0};
  const a=presentResponse(q(r.source),ctx(r));
  expect(a).toMatchObject({accepted:true,presentation:{tables:[{title:"Last saved current-day sales reading",coverage:"partial",rows:[["Net sales",1200,null],["Discounts",null,null],["Refunds",null,null],["Tips",null,null],["Orders",null,3],["Open checks",null,0]]}]}});
  expect(JSON.stringify(a)).toContain(r.readAt);
  expect(presentResponse(q(r.source),ctx({...r,provisional:false})).accepted).toBe(false);
 });
 it("keeps physical units, expected vs actual, and exact ingredient microcents",()=>{
  checks("usage_variance",{period:sales.period,rows:[{name:"Milk",unit:"ml",expected:200,actual:null,status:null},{name:"Flour",unit:"g",expected:0,actual:0,status:"on_target"}]},[["Milk","ml",200,null,null],["Flour","g",0,0,"on_target"]]);
  checks("ingredient_prices",{items:[{name:"Milk",baseUnit:"ml",costPerBaseUnitMicros:125001,effectiveFrom:"2026-11-01"}]},[["Milk","ml",125001,"2026-11-01"]]);
  const r:AgentToolResult={source:"usage_variance",period:sales.period,missing:[],rows:[{name:"Milk",unit:"ml",expected:20,actual:10},{name:"Flour",unit:"g",expected:10,actual:10}]};
  expect(presentResponse(q(r.source,"table:expected_usage","bar"),ctx(r)).accepted).toBe(false);
 });
 it("separates configured monthly bills, break-even basis, current prices and modeled suggestions",()=>{
  checks("recurring_bills",{monthlyEquivalentCents:12000,estimated:true},[["Recurring costs",12000,"Estimate"]]);
  checks("break_even",{period:sales.period,periodKind:"month_to_date",status:"estimate",periodBreakEvenCents:1000,dailyBreakEvenCents:200,knownCostBreakEvenFloorCents:null},[["Selected period break-even",1000,"Estimate"],["Daily break-even",200,"Estimate"],["Known-cost floor",null,"Floor only"]]);
  checks("pricing_engine",{itemId:"p1",currentPriceCents:300,productCostCents:100,grossProfitPerItemCents:200,recommendedPriceCents:350},[["Current price",300,"Saved price"],["Product cost",100,"Source-dependent"],["Gross profit per item",200,"Calculation"],["Recommended price",350,"Estimate"]]);
  checks("new_item_price",{draft:true,saved:false,recommendedPriceCents:400,fullCostCents:150},[["Recommended price",400,"Estimate"],["Full cost",150,"Estimate"],["Known-cost floor",null,"Floor only"]]);
  checks("milk_swap",{currency:"USD",rows:[{sizeLabel:"Small",baseServingCents:20,targetServingCents:30,additionalCostCents:10,suggestedUpchargeCents:50,inputBasis:"mixed",basis:"estimated"}]},[["Small",20,30,10,50,"mixed","estimated"]]);
 });
 it("uses only the selected dated financial class and preserves missing allocation/currency semantics",()=>{
  const r:AgentToolResult={source:"cashflow_evidence",period:null,missing:["currentCashEvidenceMissing"],selectedStatement:{currency:"USD",asOf:"2026-11-03",rows:[{i:1,date:"2026-11-02",amountCents:-300,balanceCents:800}]},documentedAccountBalances:[],claims:[{currency:"USD",issuedOn:"2026-11-01",dueOn:null,recordedClaimCents:200,documentedAllocatedCents:null,paymentStatus:"unknown"}]};
  expect(presentResponse(q(r.source,"rows:statement"),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["2026-11-02",-300,800]]}]}});
  expect(presentResponse(q(r.source,"rows:claims"),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{rows:[["2026-11-01",null,200,null,"unknown"]]}]}});
  expect(presentResponse(q(r.source,"rows:claims"),{...ctx(r),currency:"EUR"}).accepted).toBe(false);
 });
 it("does not transform missing attendance into a headcount",()=>{
  checks("current_staff",{attendanceTracked:true,onClockCount:0},[["Recorded attendance",0]]);
  expect(presentResponse(q("current_staff"),ctx({source:"current_staff",period:null,missing:[],attendanceTracked:false,onClockCount:0})).accepted).toBe(false);
 });
});

describe("Task16E presentation capability census",()=>{
 // Explicit dispositions, not a claim every tool should yield a chart.
 // A new registered capability must be assigned and verified deliberately.
 const dispositions={
  "bound": [
    "get_profit",
    "get_sales",
    "get_menu_items",
    "get_peak_hours",
    "get_employee_sales",
    "get_payroll_facts",
    "query_data",
    "get_staff",
    "get_labor",
    "get_business_hours",
    "get_coverage_gaps",
    "get_shift_cost",
    "get_expenses",
    "get_bills",
    "get_cashflow_evidence",
    "get_break_even",
    "get_cost_summary",
    "get_usage_variance",
    "get_product_costs",
    "get_ingredient_costs",
    "get_inventory",
    "get_item_sales",
    "get_price_recommendation",
    "get_today_so_far",
    "draft_week_schedule",
    "simulate_staff_absence",
    "suggest_new_item_price",
    "milk_swap_price",
    "get_goal_status",
    "get_supplier_purchase_orders",
    "inspect_supplier_purchase"
  ],
  "composition": [
    "present_response",
    "get_schedule",
    "get_team",
    "get_week_schedule",
    "get_events",
    "simulate_scenario",
    "calculate"
  ],
  "native": [
    "ask_owner",
    "describe_data",
    "get_attention_items",
    "get_investigation_source",
    "get_staff_coordination_cases",
    "get_staff_messages",
    "get_labor_rules",
    "get_price_monitor_status",
    "inspect_purchase_reconciliation",
    "get_nearby_events",
    "inspect_public_page",
    "web_search",
    "get_supervisor_permissions",
    "search_gmail",
    "list_gmail_labels",
    "read_gmail",
    "read_gmail_thread",
    "read_gmail_attachment",
    "get_maintenance_staff_candidates",
    "search_maintenance_vendor",
    "get_maintenance_cases"
  ],
  "effect": [
    "propose_financial_settlement",
    "propose_financial_bill",
    "propose_price_change",
    "propose_price_experiment",
    "propose_goal",
    "record_checkin",
    "propose_schedule",
    "propose_shift_change",
    "propose_add_staff",
    "propose_staff_change",
    "propose_availability_change",
    "propose_rule_change",
    "propose_send_schedule",
    "propose_purchases",
    "propose_purchase_receiving",
    "propose_invoice_reconciliation",
    "propose_supplier_discrepancy_followup",
    "propose_supplier_purchase_order",
    "record_supplier_order_outcome",
    "propose_supplier_vendor_email",
    "propose_event_plan",
    "manage_commitment",
    "manage_routine",
    "propose_gmail_action",
    "propose_maintenance_staff_assignment",
    "record_maintenance_repair_claim",
    "propose_maintenance_vendor_request"
  ]
} as const;
 const projections={
  "get_profit": [
    "profitability"
  ],
  "get_sales": [
    "daily_rollups"
  ],
  "get_menu_items": [
    "menu_items"
  ],
  "get_peak_hours": [
    "get_peak_hours"
  ],
  "get_employee_sales": [
    "get_employee_sales"
  ],
  "get_payroll_facts": [
    "get_payroll_facts"
  ],
  "query_data": [
    "canonical_data"
  ],
  "get_staff": [
    "current_staff"
  ],
  "get_labor": [
    "labor_and_attendance"
  ],
  "get_business_hours": [
    "locations.open_hours"
  ],
  "get_coverage_gaps": [
    "scheduled_shifts+locations.open_hours"
  ],
  "get_shift_cost": [
    "employees+shiftCost"
  ],
  "get_expenses": [
    "expenses"
  ],
  "get_bills": [
    "recurring_bills"
  ],
  "get_cashflow_evidence": [
    "cashflow_evidence"
  ],
  "get_break_even": [
    "break_even"
  ],
  "get_cost_summary": [
    "business_costs"
  ],
  "get_usage_variance": [
    "usage_variance"
  ],
  "get_product_costs": [
    "product_costs"
  ],
  "get_ingredient_costs": [
    "ingredient_prices"
  ],
  "get_inventory": [
    "inventory"
  ],
  "get_item_sales": [
    "item_sales"
  ],
  "get_price_recommendation": [
    "pricing_engine"
  ],
  "get_today_so_far": [
    "today_live"
  ],
  "draft_week_schedule": [
    "olivia_schedule",
    "olivia_owner_what_if"
  ],
  "simulate_staff_absence": [
    "olivia_hypothetical_absence"
  ],
  "suggest_new_item_price": [
    "new_item_price"
  ],
  "milk_swap_price": [
    "milk_swap"
  ],
  "get_goal_status": [
    "goals"
  ],
  "get_supplier_purchase_orders": [
    "purchase_orders"
  ],
  "inspect_supplier_purchase": [
    "supplier_purchase_plan"
  ]
} as const;
 it("classifies the complete registered registry (including gated owner tools) with no silent omissions",()=>{
  const names=Object.values(dispositions).flatMap(xs=>[...xs]);
  expect(new Set(names).size).toBe(names.length);
  expect([...names].sort()).toEqual(Object.keys(schemas).sort());
  expect(agentToolDefinitions.every(t=>names.some(name=>name===t.name))).toBe(true);
  expect(Object.keys(projections).sort()).toEqual([...dispositions.bound].sort());
  expect([...new Set(Object.values(projections).flatMap(xs=>[...xs]))].sort()).toEqual([...presentationSourceNames].sort());
 });
 it("projects a real registered hourly-sales tool response without another read",async()=>{
  let reads=0;
  const c={...ctx(),locale:"en",timezone:"America/Los_Angeles",tools:{
    getPeakHours:async()=>{reads++;return {available:true,value:{hours:[{date:"2026-11-02",hourLocal:9,locationId:null,netSalesCents:1200,ordersCount:3},{date:"2026-11-03",hourLocal:9,locationId:null,netSalesCents:1300,ordersCount:4}]},quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}};}
  }} as unknown as AgentToolContext;
  const result=await executeAgentTool("get_peak_hours",{from:"2026-11-02",to:"2026-11-03"},c);
  const p=presentResponse({layout:"stack",panels:[{source:"get_peak_hours",field:"rows",kind:"table"}],suggestions:[]},{...c,turnResults:()=>[{name:"get_peak_hours",result}]});
  expect(p).toMatchObject({accepted:true,presentation:{tables:[{rows:[["09:00",2500,7]]}]}});
  expect(reads).toBe(1);
 });
});
describe("goal, schedule and hours producer coverage",()=>{
 const q=(source:string)=>({layout:"stack",panels:[{source,field:"rows",kind:"table"}],suggestions:[]});
 it("preserves configured closed days separately from unknown days and weekly hours",()=>{
  const r:AgentToolResult={source:"locations.open_hours",period:null,missing:["businessHoursNotSet:tue"],hours:{mon:[["09:00","18:00"]],sun:[]}};
  expect(presentResponse(q(r.source),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["Sunday",null,null,"Closed"],["Monday","09:00","18:00","Configured"],["Tuesday",null,null,"Not configured"],["Wednesday",null,null,"Not configured"],["Thursday",null,null,"Not configured"],["Friday",null,null,"Not configured"],["Saturday",null,null,"Not configured"]]}]}});
 });
 it("separates goal target from observed values and retains fractional daily counts",()=>{
  const r:AgentToolResult={source:"goals",period:null,missing:[],goal:{startsOn:"2026-11-01",endsOn:"2026-12-01"},metricDetail:{metricKey:"orders",unit:"count",source:"computed"},metricEvaluation:{baseline:10.5,current:11.5,target:15,coverage:0.7},evaluation:{status:"tracking"}};
  expect(presentResponse(q(r.source),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["Baseline",10.5,"Baseline evidence"],["Current",11.5,"tracking"],["Target",15,"Goal target"]]}]}});
 });
 it("preserves incomplete or estimated staffing alternatives and never treats them as applied",()=>{
  const r:AgentToolResult={source:"olivia_schedule",period:sales.period,missing:[],draft:true,saved:false,scenarioAlternatives:[{objective:"cash",cashWagesCents:null,loadedPayrollCents:null,ownerMinutes:0,completeCoverage:false,hardConstraintsSatisfied:true,costState:"unknown"}]};
  expect(presentResponse(q(r.source),ctx(r))).toMatchObject({accepted:true,presentation:{tables:[{coverage:"partial",rows:[["cash",null,null,0,false,true,"unknown"]]}]}});
  expect(presentResponse(q(r.source),ctx({...r,saved:true})).accepted).toBe(false);
 });
});
