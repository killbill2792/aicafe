import {describe,it,expect} from "vitest";
import {presentResponse} from "./presentation";
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
