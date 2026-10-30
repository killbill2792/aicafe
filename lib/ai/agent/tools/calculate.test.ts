import {describe,expect,it} from "vitest";
import {calculateTools} from "./calculate";
import {schemas,executeAgentTool,agentToolDefinitions,type AgentToolContext,type AgentToolResult} from "./index";
import {SCREEN_NUMBERS,SCREEN_NUMBER_IDS} from "../screenNumbers";
import {explainLineSchema} from "../explain";
import {checkNumbers} from "../checkNumbers";
import {classifyNeedsAsk} from "@/lib/ownerFacts/needsAsk";
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
const input=(name:string,tool:string|null,path:string|null,fact_key:string|null=null)=>({name,label:name.replace(/_/g," "),tool,path,fact_key});
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
    expect(classifyNeedsAsk([r],"","")).toEqual([]);
    expect(questionFromReasons(classifyNeedsAsk([r],"",""),[r],"","en",[])).toBeNull();
  });
});

describe("calculate never rebuilds a screen number",()=>{
  it("lists exactly the owner-approved screen numbers, each backed by real tools",()=>{
    expect(SCREEN_NUMBER_IDS.sort()).toEqual(["break_even","card_fees","item_cost","labor_cost","profit"]);
    for(const tools of Object.values(SCREEN_NUMBERS))for(const tool of tools)expect(Object.hasOwn(schemas,tool)).toBe(true);
  });
  it.each(SCREEN_NUMBER_IDS)("%s from parts is refused; building on its tool's number is allowed",async id=>{
    const steps=[{id:"r",label:"r",op:"subtract" as const,args:["a","b"]}];
    const parts=await calculateTools.calculate.execute({purpose:"rebuilt",screen_number:id,
      inputs:[input("a","query_data","rows.0.net_sales_cents"),input("b","query_data","rows.0.cost_cents")],steps},ctx(turn));
    expect(parts.refused).toBe("screenNumberComesFromItsTool");
    const tool=SCREEN_NUMBERS[id][0];
    const own:AgentToolResult={source:tool,period,missing:[],valueCents:30000};
    const built=await calculateTools.calculate.execute({purpose:"what-if",screen_number:id,
      inputs:[input("a",tool,"valueCents"),input("b","query_data","rows.0.cost_cents")],steps},
      ctx([...turn,{name:tool,result:own}]));
    expect(built.refused).toBeUndefined();
  });
  it("is offered to the model as a strict tool and dispatched",async()=>{
    expect(agentToolDefinitions.find(t=>t.name==="calculate")?.strict).toBe(true);
    const r=await executeAgentTool("calculate",knownWithEstimate,ctx(turn,[pctFact]));
    expect(r.source).toBe("calculate");
  });
});
