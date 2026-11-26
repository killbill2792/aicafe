import {describe,it,expect,vi} from "vitest";
import type {AgentProvider} from "./loop.server";
import {runResearchTurn} from "../research/turn.server";
import {agentToolDefinitions,type AgentToolContext} from "./tools";
import {agentReplyPayload} from "./persist.server";
import {resumeOwnerQuestion} from "@/lib/ownerFacts/resume";
import {swapCostPerSize} from "@/lib/metrics/core/modifierPricing";
const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const say=(delta:string)=>({type:"response.output_text.delta",delta});
const call=(name:string,args:unknown,id:string)=>({type:"response.output_item.done",item:{type:"function_call",name,arguments:JSON.stringify(args),call_id:id}});
function fixture(rounds:unknown[][]):AgentProvider{
 let i=0;
 return async function*(){for(const event of rounds[i++]??[])yield event as never;};
}
const ctx=()=>({asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",currency:"EUR",tools:{}} as AgentToolContext);
const costSql=(target:string)=>"select * from cv_owner_facts where data->>'fact_key' in ('milk_base_serving_cost_cents:16oz','milk_"+target+"_serving_cost_cents:16oz')";
const calc={inputs:[{name:"base",value:"40",unit:"cents"},{name:"alternative",value:"90",unit:"cents"},{name:"target",value:"0.30",unit:"ratio"}],steps:[{id:"extra",op:"subtract",args:["alternative","base"]},{id:"price",op:"divide",args:["extra","target"]}]};
async function owner(ownerText:string,provider:AgentProvider,rows:Record<string,unknown>[]=[],context=ctx()){
 const rpc=vi.fn(async()=>({data:{ok:true,rows,truncated:false},error:null}));
 const turn=await runResearchTurn({ownerText,provider,cafeContext:"Fixture cafe; EUR",scope:{db:{rpc} as never,businessId:"b",ownerUserId:"o"},actions:{context,definitions:agentToolDefinitions.filter(t=>t.name==="ask_owner")}});
 return {turn,rpc};
}
describe("SQL research and owner-confirmed milk costs",()=>{
 it.each(["oat","almond","soy","coconut","macadamia"])("uses the exact named %s evidence and calculator",async target=>{
  const rows=[{fact_key:"milk_base_serving_cost_cents:16oz",value_json:40},{fact_key:"milk_"+target+"_serving_cost_cents:16oz",value_json:90}];
  const seen:Record<string,unknown>[]=[];
  const rounds=fixture([[call("run_sql",{sql:costSql(target)},"milk"),completed],[call("calculate",calc,"math"),completed],[say(target+" milk: estimated €1.67 before rounding."),completed]]);
  const provider:AgentProvider=async function*(params,signal){seen.push(params);yield* rounds(params,signal);};
  const {turn,rpc}=await owner("Milk upcharge for "+target,provider,rows);
  expect(rpc).toHaveBeenCalledWith("supervisor_research_sql",expect.objectContaining({p_sql:costSql(target)}));
  expect(turn.tools).toEqual(["run_sql","calculate"]);
  expect(turn.text).toContain(target+" milk");
  const output=(seen[2].input as {type?:string;call_id?:string;output?:string}[]).find(x=>x.type==="function_call_output"&&x.call_id==="math");
  expect(JSON.parse(output!.output!)).toMatchObject({ok:true,result:{value:"166.666667",unit:"cents"}});
  const screen=swapCostPerSize([{id:"16oz",label:"16 oz"}],"whole milk",target,
    {"16oz":{ml:160,basis:"owner_provided"}},
    {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},[target]:{costPerMlMicros:562500,basis:"owner_provided"}}).sizes[0];
  expect(Math.ceil(Number(JSON.parse(output!.output!).result.value)/5)*5).toBe(screen.suggestedUpchargeCents);
 });
 it("rejects a global cost card and recovers with an item-specific question",async()=>{
  const {turn}=await owner("What does a latte cost?",fixture([
   [call("ask_owner",{kind:"facts",question:"Cost?",options:[],allowOther:false,fields:[{key:"unitCostCents",label:"Cost",inputType:"money",units:[],defaultUnit:""}]},"bad"),completed],
   [call("ask_owner",{kind:"facts",question:"What does one latte cost you to make?",options:[],allowOther:false,fields:[{key:"owner_question_latte_cost",label:"Latte cost",inputType:"text",units:[],defaultUnit:""}]},"retry"),completed],
  ]));
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.error==="invalidFactFields")).toBe(true);
  expect(agentReplyPayload(turn).reply.blocks).toContainEqual(expect.objectContaining({type:"clarify",kind:"facts"}));
 });
 it("asks for a missing owner-only cost and resumes with exact arithmetic",async()=>{
  const original="What should I charge to switch a 16 oz latte to almond milk?";
  const {turn:asked}=await owner(original,fixture([[call("run_sql",{sql:costSql("almond")},"milk"),completed],
   [call("ask_owner",{kind:"facts",question:"What does almond milk cost per 16 oz serving?",options:[],allowOther:false,fields:[{key:"milk_almond_serving_cost_cents:16oz",label:"Almond milk cost",inputType:"money",units:[],defaultUnit:""}]},"ask"),completed]]));
  expect(agentReplyPayload(asked).reply.blocks).toContainEqual(expect.objectContaining({type:"clarify",kind:"facts"}));
  const resumed=resumeOwnerQuestion(original,"Saved",[{label:"Almond milk per serving",value:"0.90"}]);
  expect(resumed).toContain(original);
  const {turn}=await owner(resumed,fixture([[call("run_sql",{sql:costSql("almond")},"milk"),completed],[call("calculate",calc,"math"),completed],[say("Almond milk: estimated €1.67 before rounding."),completed]]),[{fact_key:"milk_base_serving_cost_cents:16oz",value_json:40},{fact_key:"milk_almond_serving_cost_cents:16oz",value_json:90}]);
  expect(turn.tools).toEqual(["run_sql","calculate"]);
  expect(turn.text).toContain("€1.67");
  expect(turn.results.some(r=>r.source==="ask_owner")).toBe(false);
 });
});
