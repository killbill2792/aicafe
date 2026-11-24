import {describe,expect,it} from "vitest";
import {calculateTools} from "./calculate";
import {executeAgentTool,agentToolDefinitions,type AgentToolContext,type AgentToolResult} from "./index";
import {SCREEN_NUMBER_IDS} from "../screenNumbers";
import {explainLineSchema} from "../explain";
import {checkNumbers} from "../checkNumbers";
import {questionFromReasons} from "@/lib/ownerFacts/questions";

const unavailable={available:false as const,value:null,quality:{level:"high" as const,missingInputs:["x"],estimatedInputs:[],staleInputs:[]}};
const period={from:"2026-10-29",to:"2026-10-29"};
const sales:AgentToolResult={source:"canonical_data",period,missing:[],rows:[{net_sales_cents:100000,orders:50,cost_cents:30000}]};
const costs:AgentToolResult={source:"business_costs",period,missing:[],knownTotalCents:50000,
  components:{ingredientsCents:4000,loadedStaffCents:null}};
function ctx(turn:Array<{name:string;result:AgentToolResult}>,facts:unknown[]=[]):AgentToolContext{
  return {asOf:"2026-10-30",timezone:"America/Los_Angeles",locale:"en",turnResults:()=>turn,savedOwnerFacts:facts,
    tools:{getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,getMenuCatalog:async()=>unavailable}} as AgentToolContext;
}
const input=(name:string,tool:string|null,path:string|null,fact_key:string|null=null)=>
  ({name,label:name.replace(/_/g," "),tool,path,fact_key,owner_value:null,owner_unit:null});
const said=(name:string,owner_value:number,owner_unit:"cents"|"percent"|"count")=>
  ({...input(name,null,null),owner_value,owner_unit});
const withOwner=(c:AgentToolContext,ownerText:string,ownerMessages:string[]=[],locale:"en"|"es"|"ar"="en")=>
  ({...c,ownerText,ownerMessages,locale}) as AgentToolContext;
const turn=[{name:"query_data",result:sales},{name:"get_cost_summary",result:costs}];
const knownWithEstimate={purpose:"Known costs with 20% ingredients",screen_number:"none",
  inputs:[input("sales","query_data","rows.0.net_sales_cents"),input("known","get_cost_summary","knownTotalCents"),
    input("recorded_ing","get_cost_summary","components.ingredientsCents"),input("share",null,null,"ingredient_cost_percent")],
  steps:[{id:"est_ing",label:"Ingredients at 20%",op:"percent_of",args:["share","sales"]},
    {id:"without",label:"Known costs minus ingredients",op:"subtract",args:["known","recorded_ing"]},
    {id:"total",label:"Known costs with estimate",op:"add",args:["without","est_ing"]}]};
const pctFact={fact_key:"ingredient_cost_percent",value_json:20,unit:"percent",created_at:"2026-10-30",period_scope:null};

describe("calculate tool",()=>{
  it("reads every number from a tool result or saved fact and shows the steps",async()=>{
    const r=await calculateTools.calculate.execute(knownWithEstimate,ctx(turn,[pctFact]));
    expect(r.refused).toBeUndefined();
    expect(r.result).toEqual({unit:"cents",valueCents:66000});
    expect(r.kind).toBe("estimate");
    expect(r.formula).toBe("(known − recorded_ing) + (share × sales)");
    expect(r.period).toBeNull();
    expect((r.steps as unknown[]).length).toBe(3);
    for(const line of r.explain as unknown[])expect(explainLineSchema.safeParse(line).success).toBe(true);
  });
  it("labels a result with only recorded inputs as a calculation and keeps their shared period",async()=>{
    const r=await calculateTools.calculate.execute({purpose:"Average order",screen_number:"none",
      inputs:[input("sales","query_data","rows.0.net_sales_cents"),input("orders","query_data","rows.0.orders")],
      steps:[{id:"avg",label:"Average order",op:"divide",args:["sales","orders"]}]},ctx(turn));
    expect(r).toMatchObject({kind:"calculation",period,result:{unit:"cents",valueCents:2000}});
  });
  it("its numbers count as checked evidence in the reply",async()=>{
    const r=await calculateTools.calculate.execute(knownWithEstimate,ctx(turn,[pctFact]));
    expect(checkNumbers("Known costs with your 20% estimate: $660.00.","ingredients are 20%",[...turn.map(t=>t.result),r],"en")).toEqual([]);
  });
  it("refuses numbers it cannot read, never treating unknown as zero",async()=>{
    const base={purpose:"x",screen_number:"none",steps:[{id:"y",label:"y",op:"sum",args:["a"]}]};
    const run=(inputs:unknown[])=>calculateTools.calculate.execute({...base,inputs},ctx(turn));
    expect((await run([input("a","get_sales","totalCents")])).refused).toBe("toolNotCalledThisTurn");
    expect((await run([input("a","get_cost_summary","components.loadedStaffCents")])).refused).toBe("inputIsUnknown");
    expect((await run([input("a","get_cost_summary","components")])).refused).toBe("pathIsNotANumber");
    expect((await run([input("a",null,null,"never_saved")])).refused).toBe("factNotSaved");
    expect((await run([input("a","query_data","rows.0.net_sales_cents","x")])).refused).toBe("inputNeedsToolAndPathOrFactKey");
    await expect(calculateTools.calculate.execute({...base,inputs:[{...input("a",null,null),value:5}]},ctx(turn))).rejects.toThrow();
  });
  it("a refusal never becomes an owner question",async()=>{
    const r=await calculateTools.calculate.execute({purpose:"x",screen_number:"none",
      inputs:[input("a","get_sales","totalCents")],steps:[{id:"y",label:"y",op:"sum",args:["a"]}]},ctx(turn));
    expect(r).toMatchObject({source:"calculate",missing:[],refused:"toolNotCalledThisTurn"});
    expect(questionFromReasons([], [r], "", "en", [])).toBeNull();
  });
});

describe("source-attested ingredient-rate arithmetic",()=>{
 it("converts stored microcents exactly before multiplying by a verified quantity",async()=>{
  const research:AgentToolResult={source:"u3_canonical_research",period:null,missing:[],truncated:false,
    rows:[{rate:"125001",quantity:"200"}],
    evidence:{scope:"verified_owner_cafe_lease",receipt_id:"11111111-1111-4111-8111-111111111111",
     query_fingerprint:"a".repeat(64),catalog_version:"b".repeat(16),
     column_units:{rate:"microcents",quantity:"count"}}};
  const args={purpose:"Ingredient use",screen_number:"none",
   inputs:[input("rate","query_data","rows.0.rate"),input("quantity","query_data","rows.0.quantity")],
   steps:[{id:"cost",label:"Ingredient cost",op:"multiply",args:["rate","quantity"]}]};
  const r=await calculateTools.calculate.execute(args,ctx([{name:"query_data",result:research}]));
  expect(r).toMatchObject({result:{unit:"cents",valueCents:25},kind:"calculation"});
  const legacy:AgentToolResult={source:"ingredient_prices",period:null,missing:[],items:[{costPerBaseUnitMicros:125001,quantity:200}]};
  const old=await calculateTools.calculate.execute({...args,inputs:[input("rate","get_ingredient_costs","items.0.costPerBaseUnitMicros"),input("quantity","get_ingredient_costs","items.0.quantity")]},ctx([{name:"get_ingredient_costs",result:legacy}]));
  expect(old.result).toEqual(r.result);
 });
});

describe("calculate uses what the owner says",()=>{
  const rentTurn=[...turn,{name:"get_bills",result:{source:"recurring_bills",period:null,missing:[],monthlyEquivalentCents:300000} as AgentToolResult}];
  const rentWhatIf=(c:AgentToolContext)=>calculateTools.calculate.execute({purpose:"Monthly bills if rent goes up",screen_number:"none",
    inputs:[input("bills","get_bills","monthlyEquivalentCents"),said("rent_increase",50000,"cents")],
    steps:[{id:"new_bills",label:"Bills after the increase",op:"add",args:["bills","rent_increase"]}]},c);
  it("uses a number the owner typed this turn, labeled as theirs",async()=>{
    const r=await rentWhatIf(withOwner(ctx(rentTurn),"what if rent goes up $500?"));
    expect(r).toMatchObject({result:{unit:"cents",valueCents:350000},kind:"estimate",ownerProvided:["rent_increase"]});
    expect((r.explain as Array<{provenance:string}>)[0].provenance).toBe("ownerProvided");
  });
  it("uses a number from an earlier owner message, in Spanish too",async()=>{
    const r=await rentWhatIf(withOwner(ctx(rentTurn),"y entonces?",["sube la renta 500 dólares"],"es"));
    expect(r.result).toEqual({unit:"cents",valueCents:350000});
  });
  it("uses a percent the owner said, and a typed question-card answer",async()=>{
    const pct=(c:AgentToolContext)=>calculateTools.calculate.execute({purpose:"Ingredients",screen_number:"none",
      inputs:[input("sales","query_data","rows.0.net_sales_cents"),said("share",20,"percent")],
      steps:[{id:"ing",label:"Ingredients",op:"percent_of",args:["share","sales"]}]},c);
    expect((await pct(withOwner(ctx(turn),"20% of price for all"))).result).toEqual({unit:"cents",valueCents:20000});
    expect((await pct(withOwner(ctx(turn),"Known costs yesterday?\nSaved.\nIngredient cost: 20% of price"))).result)
      .toEqual({unit:"cents",valueCents:20000});
  });
  it.each([
    ["I use 2 cartons per day, how many for 7 days?",7,7],
    ["We work 6 hours each shift",6,6],
    ["Uso 2 cajas por día durante 7 días",7,7],
    ["أعمل 6 ساعات في كل وردية",6,6],
  ] as const)("accepts an explicitly owner-stated duration: %s",async(text,duration,expected)=>{
    const locale=text.startsWith("Uso")?"es":text.startsWith("أعمل")?"ar":"en";
    const r=await calculateTools.calculate.execute({purpose:"Duration",
      screen_number:"none",inputs:[said("duration",duration,"count")],
      steps:[{id:"duration_result",label:"Duration",op:"sum",args:["duration"]}]},
      withOwner(ctx(turn),text,[],locale));
    expect(r.refused).toBeUndefined();
    expect(r).toMatchObject({result:{unit:"count",quantity:expected},ownerProvided:["duration"]});
  });
  it("refuses an unstated duration even when another duration was provided",async()=>{
    const r=await calculateTools.calculate.execute({purpose:"Duration",
      screen_number:"none",inputs:[said("days",8,"count")],
      steps:[{id:"duration_result",label:"Duration",op:"sum",args:["days"]}]},
      withOwner(ctx(turn),"I use 2 cartons per day for 7 days"));
    expect(r.refused).toBe("ownerDidNotSayThis");
  });
  it("refuses a number the owner never said",async()=>{
    expect((await rentWhatIf(withOwner(ctx(rentTurn),"what if rent goes up?"))).refused).toBe("ownerDidNotSayThis");
    expect((await rentWhatIf(withOwner(ctx(rentTurn),"rent up $400"))).refused).toBe("ownerDidNotSayThis");
  });
});

describe("metric identity is independent of tool name",()=>{
  it("keeps official metric topics without assigning exclusive tool authority",()=>{
    expect([...SCREEN_NUMBER_IDS].sort()).toEqual(["break_even","card_fees","item_cost","labor_cost","profit"]);
  });
  it.each(SCREEN_NUMBER_IDS)("allows independent %s arithmetic without asserting official screen parity",async id=>{
    const actual=await calculateTools.calculate.execute({purpose:"Independent calculation",screen_number:id,
      inputs:[input("a","query_data","rows.0.net_sales_cents"),input("b","query_data","rows.0.cost_cents")],
      steps:[{id:"r",label:"r",op:"subtract",args:["a","b"]}]},ctx(turn));
    expect(actual).toMatchObject({metric_topic:id,metric_basis:"independent_calculation",result:{unit:"cents",valueCents:70000}});
    expect(actual.refused).toBeUndefined();
  });
  it("marks explicit hypothetical inputs as estimates, never owner facts",async()=>{
    const actual=await calculateTools.calculate.execute({purpose:"Alternative cost scenario",screen_number:"profit",
      inputs:[input("a","query_data","rows.0.net_sales_cents"),
        {...input("b",null,null),assumption:{value:25000,unit:"cents",basis:"Hypothetical equipment lease"}}],
      steps:[{id:"r",label:"r",op:"subtract",args:["a","b"]}]},ctx(turn));
    expect(actual).toMatchObject({kind:"estimate",metric_basis:"independent_calculation",result:{unit:"cents",valueCents:75000},
      assumptions:[{name:"b",basis:"Hypothetical equipment lease"}]});
    expect(actual.ownerProvided).toBeUndefined();
  });
  it("does not turn incomplete input into an actual complete calculation",async()=>{
    const actual=await calculateTools.calculate.execute({purpose:"Recorded partial costs",screen_number:"profit",
      inputs:[input("a","query_data","rows.0.net_sales_cents"),input("b","get_cost_summary","knownTotalCents")],
      steps:[{id:"r",label:"r",op:"subtract",args:["a","b"]}]},
      ctx([turn[0],{...turn[1],result:{...costs,missing:["coverage_missing"]}}]));
    expect(actual).toMatchObject({kind:"estimate",missing:["incompleteCalculationInputs"],basedOnPartialData:["get_cost_summary"]});
  });
  it("is offered to the model as a strict tool and dispatched",async()=>{
    expect(agentToolDefinitions.find(t=>t.name==="calculate")?.strict).toBe(true);
    const r=await executeAgentTool("calculate",knownWithEstimate,ctx(turn,[pctFact]));
    expect(r.source).toBe("calculate");
  });
});


describe("U3 receipt-bound exact research calculation",()=>{
 const older="11111111-1111-4111-8111-111111111111";
 const newer="22222222-2222-4222-8222-222222222222";
 const sql=(receipt_id:string,value:string)=>({
  name:"query_data",result:{source:"u3_canonical_research",period:{from:"2026-11-01",to:"2026-11-01"},
   missing:[],rows:[{net_sales_cents:value}],truncated:false,
   evidence:{receipt_id,scope:"verified_owner_cafe_lease",column_units:{net_sales_cents:"cents"}}}
 }) as {name:string;result:AgentToolResult};
 const row=[sql(older,"12345"),sql(newer,"67890")];
 const query=(receipt_id:string|null,tool="query_data",path="rows.0.net_sales_cents")=>({
  purpose:"Exact prior daily amount",screen_number:"none",
  inputs:[{name:"amount",label:"Verified amount",tool,path,receipt_id,
   fact_key:null,owner_value:null,owner_unit:null}],
  steps:[{id:"result",label:"Amount",op:"sum",args:["amount"]}]
 });
 it("can calculate from an earlier page after the exact snapshot has been completely traversed",async()=>{
  const make=(id:string,amount:string,index:number):{name:string;result:AgentToolResult}=>({name:"query_data",result:{
   ...sql(id,amount).result,rows:[{net_sales_cents:amount}],rowCount:1,
   page_consistency:"verified_same_result",total_rows:2,page_offset:index,
   page_complete:index===1,truncated:index===0,next_cursor:index?null:"signed",
   missing:index?[]:["result_truncated"],
   evidence:{...(sql(id,amount).result.evidence as object),query_fingerprint:"a".repeat(64),
    catalog_version:"b".repeat(16),snapshot_id:"33333333-3333-4333-8333-333333333333",
    snapshot_digest:"c".repeat(64),as_of:"2026-11-24T00:00:00Z"}
  }});
  const first=make(older,"12345",0),last=make(newer,"67890",1);
  expect(await calculateTools.calculate.execute(query(older),ctx([first])))
   .toMatchObject({kind:"estimate",missing:["incompleteCalculationInputs"],result:{unit:"cents",valueCents:12345}});
  expect(await calculateTools.calculate.execute(query(older),ctx([first,last])))
   .toMatchObject({result:{unit:"cents",valueCents:12345}});
 });
 it("selects the exact earlier receipt rather than the latest invocation of the same tool",async()=>{
  const actual=await calculateTools.calculate.execute(query(older),ctx(row));
  expect(actual.refused).toBeUndefined();
  expect(actual.result).toEqual({unit:"cents",valueCents:12345});
  const latest=await calculateTools.calculate.execute(query(newer),ctx(row));
  expect(latest.result).toEqual({unit:"cents",valueCents:67890});
 });
 it("never treats a forged SQL alias as authoritative money units",async()=>{
  const countAsCents={...sql(older,"7"),result:{...sql(older,"7").result,
   evidence:{receipt_id:older,scope:"verified_owner_cafe_lease",
    column_units:{net_sales_cents:"count"}}}};
  const actual=await calculateTools.calculate.execute(query(older),ctx([countAsCents]));
  expect(actual.result).toEqual({unit:"count",quantity:7});
  const withoutUnit={...sql(older,"12345"),result:{...sql(older,"12345").result,
   evidence:{receipt_id:older,scope:"verified_owner_cafe_lease"}}};
  const refused=await calculateTools.calculate.execute(query(older),ctx([withoutUnit]));
  expect(refused.refused).toBe("researchUnitUnverified");
 });
 it("refuses ambiguous, fabricated, missing and untyped SQL evidence",async()=>{
  expect((await calculateTools.calculate.execute(query(null),ctx(row))).refused)
   .toBe("researchReceiptRequired");
  expect((await calculateTools.calculate.execute(
   query("33333333-3333-4333-8333-333333333333"),ctx(row))).refused)
   .toBe("receiptNotFound");
  expect((await calculateTools.calculate.execute(query(older,"query_data","rows.0.unknown"),ctx(row))).refused)
   .toBe("pathIsNotANumber");
  const fractional=await calculateTools.calculate.execute({
   ...query(older),
   inputs:[...query(older).inputs,said("n",4,"count")],
   steps:[{id:"total",label:"Four average orders",op:"multiply",args:["amount","n"]}]
  },withOwner(ctx([sql(older,"12345.25")]),"For 4 orders"));
  expect(fractional).toMatchObject({result:{unit:"cents",valueCents:49381}});
  expect(await calculateTools.calculate.execute(query(older),ctx([{
   ...sql(older,"12345"),result:{...sql(older,"12345").result,missing:["result_truncated"]}
  }]))).toMatchObject({kind:"estimate",missing:["incompleteCalculationInputs"],result:{unit:"cents",valueCents:12345}});
 });
});

describe("exact calculator continuation",()=>{
 it("reuses earlier unrounded results and refuses fabricated or out-of-turn receipts",async()=>{
  const first=await calculateTools.calculate.execute({purpose:"Split money",screen_number:"none",
   inputs:[input("a","query_data","rows.0.net_sales_cents"),said("b",3,"count")],
   steps:[{id:"split",label:"Split",op:"divide",args:["a","b"]}]},
   withOwner(ctx(turn),"Split between 3 people"));
  expect(first.result).toEqual({unit:"cents",valueCents:33333});
  const id=(first.evidence as {receipt_id:string}).receipt_id;
  const next={purpose:"Recover original total",screen_number:"none",
   inputs:[{...input("a","calculate","result"),receipt_id:id},said("b",3,"count")],
   steps:[{id:"whole",label:"Whole",op:"multiply",args:["a","b"]}]};
  const second=await calculateTools.calculate.execute(next,
   withOwner(ctx([...turn,{name:"calculate",result:first}]),"Multiply by 3"));
  expect(second).toMatchObject({kind:"estimate",result:{unit:"cents",valueCents:100000}});
  expect((await calculateTools.calculate.execute(next,withOwner(ctx(turn),"Multiply by 3"))).refused).toBe("receiptNotFound");
  expect((await calculateTools.calculate.execute(next,withOwner(ctx([{name:"calculate",result:{...first}}]),"Multiply by 3"))).refused).toBe("calculationReceiptUnavailable");
 });
 it("accepts a complete cost structure with more than twelve inputs without splitting the model call",async()=>{
  const inputs=Array.from({length:20},(_,i)=>({...input("cost"+i,null,null),assumption:{value:i+1,unit:"cents",basis:"Hypothetical scenario line "+i}}));
  const result=await calculateTools.calculate.execute({purpose:"Alternative cost structure",screen_number:"profit",inputs,
   steps:[{id:"total",label:"Total",op:"sum",args:inputs.map(x=>x.name)}]},ctx([]));
  expect(result).toMatchObject({kind:"estimate",result:{unit:"cents",valueCents:210}});
  for(const line of result.explain as unknown[])expect(explainLineSchema.safeParse(line).success).toBe(true);
 });
});
