/**
 * Promptfoo exercises the production Supervisor agent loop with read-only,
 * anonymized café readers. Never copy the system prompt into eval code.
 */
import { readFileSync } from "node:fs";
import { runAgentTurn, type AgentProvider } from "../../lib/ai/agent/loop.server";
import type { AgentToolContext, AgentToolName } from "../../lib/ai/agent/tools";

type Day = {date:string;netSalesCents:number;ordersCount:number;wagesCents:number|null;
  staffTaxCents:number|null;loadedStaffCostCents:number|null;wageStatus:"actual"|"missing"};
type Item = {id:string;name:string;category:string;active:boolean;priceCents:number;
  recipeCostCents:number;unitsOct19:number};
type Seed = { profile:{asOf:string;timezone:string;currency:string};
  days:Day[];menu:Item[] };
const seed = JSON.parse(readFileSync(new URL("./seed.json",import.meta.url),"utf8")) as Seed;
type ReplayCall = {name:AgentToolName;args:unknown};
type ReplayCase = {question:string;tools:ReplayCall[];followUpTools?:ReplayCall[];answer:string};
const replays = JSON.parse(readFileSync(new URL("./replays.json",import.meta.url),"utf8")) as
  {cases:Record<string,ReplayCase>};
const quality = (missingInputs:string[]=[]) => ({
  level:missingInputs.length?"low":"high",
  missingInputs,estimatedInputs:[],staleInputs:[],
});
const present = (value:unknown,missingInputs:string[]=[])=>({
  available:true,value,quality:quality(missingInputs)
});
const absent = (reason:string)=>({available:false,value:null,quality:quality([reason])});
const within = (date:string,period:{from:string;to:string})=>
  date>=period.from&&date<=period.to;
const tools = {
  getMenuCatalog:async()=>present(seed.menu.map(item=>({
    ...item,baseName:item.name,sizeLabel:null,description:null,
    menuGroup:item.category,visibility:"POS",pricingStrategy:null,modifierGroups:[],
  }))),
  getProfitability:async()=>absent("profitabilityNotSeeded"),
  getSalesTrend:async(period:{from:string;to:string})=>{
    const rows=seed.days.filter(d=>within(d.date,period)).map(d=>({
      date:d.date,netSalesCents:d.netSalesCents,ordersCount:d.ordersCount,
    }));
    return rows.length?present(rows):absent("noCoveredSalesRows");
  },
  getLaborMetrics:async(period:{from:string;to:string})=>{
    const rows=seed.days.filter(d=>within(d.date,period));
    return rows.length?present(rows,rows.filter(d=>d.wageStatus==="missing")
      .map(d=>"laborWageUnknown:"+d.date)):absent("laborNotSeeded");
  },
  getProductSales:async(period:{from:string;to:string})=>
    within(seed.days[0].date,period)?present(seed.menu.map(item=>({
      id:item.id,name:item.name,units:item.unitsOct19,
    }))):absent("itemSalesNotSeeded"),
  getProductEconomics:async(itemId:string)=>{
    const item=seed.menu.find(row=>row.id===itemId);
    return item?present({
      id:item.id,name:item.name,priceCents:item.priceCents,costStatus:"READY",
      costSource:"recipe",ingredientsCentsToday:item.recipeCostCents,
      recipeCostCents:item.recipeCostCents,ownerTotalCostCents:null,
      costQuality:"recorded",
    }):absent("itemNotSeeded");
  },
  getStaffAttendance:async()=>absent("attendanceNotSeeded"),
  getOwnerMonthlyPayrollExtras:async()=>absent("ownerPayrollExtrasNotSet"),
  getToastScopeCoverage:async()=>present({labor:true,menus:true}),
  getPosImportReviews:async()=>present([]),
};
const allowedTools:AgentToolName[]=[
  "get_menu_items","get_labor","get_product_costs","get_item_sales",
  "get_inventory","calculate",
];
const context = ():AgentToolContext=>({
  tools:tools as unknown as AgentToolContext["tools"],
  locale:"en",asOf:seed.profile.asOf,timezone:seed.profile.timezone,
  currency:seed.profile.currency,
});
/**
 * Recorded Responses *model* events drive the real tool loop. Every tool
 * implementation, canonical calculation and number guard runs unchanged.
 * This does not measure fresh model behavior or prompt/model quality.
 */
function recordedProvider(replay:ReplayCase):AgentProvider {
  const rounds=[replay.tools,...(replay.followUpTools?[replay.followUpTools]:[])];
  let round=0;
  const allIds:string[]=[];
  return async function* (params) {
    round++;
    const input=Array.isArray(params.input)?params.input:[];
    for(const id of allIds){
      if(!input.some((x:unknown)=>!!x&&typeof x==="object"&&
        (x as {type?:string;call_id?:string}).type==="function_call_output"&&
        (x as {call_id?:string}).call_id===id))
        throw new Error("production tool result missing: "+id);
    }
    if(round<=rounds.length){
      if(typeof params.instructions!=="string"||!Array.isArray(params.tools))
        throw new Error("production Supervisor instructions/tools missing");
      for(const [i,call] of rounds[round-1].entries()){
        const offered=params.tools.some((tool:unknown)=>
          !!tool&&typeof tool==="object"&&
          (tool as {name?:string}).name===call.name);
        if(!offered)throw new Error("production tool missing: "+call.name);
        const id="eval-read-"+round+"-"+i;
        allIds.push(id);
        yield {type:"response.output_item.done",item:{
          type:"function_call",name:call.name,
          arguments:JSON.stringify(call.args),call_id:id,
        }};
      }
    }else if(round===rounds.length+1){
      yield {type:"response.output_text.delta",delta:replay.answer};
    }else throw new Error("unexpected additional Supervisor model call");
    yield {type:"response.completed",response:{usage:{
      input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0},
    }}};
  };
}
export default class SupervisorEvalProvider {
  id() {return "supervisor:real-loop:recorded-responses";}
  async callApi(prompt:string,options:{vars?:Record<string,unknown>}={}) {
    const caseId=String(options.vars?.caseId??"");
    const replay=replays.cases[caseId];
    if(!replay)return {error:"Unknown recorded Supervisor eval case: "+caseId};
    if(prompt.trim()!==replay.question.trim())
      return {error:"Question changed without updating its recorded Responses trace"};
    try {
      const turn=await runAgentTurn({
        ownerText:prompt,context:context(),toolNames:allowedTools,
        provider:recordedProvider(replay),
        cafeProfile:"Evaluation café; use its authenticated currency and timezone.",
      });
      return {output:JSON.stringify({
        answer:turn.text,status:turn.status.status,endReason:turn.endReason,
        results:turn.results,usedTools:turn.tools??[],unverified:turn.unverified,
        usage:turn.usage,
      }),cost:0};
    }catch(error) {
      return {error:"Deterministic Supervisor replay failed: "+
        (error instanceof Error?error.message:"unknown")};
    }
  }
}
