import {describe,it,expect} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentToolDefinitions,type AgentToolContext} from "./tools";

/** Golden owner questions for when the Supervisor may ask the owner (Nov 4).
 * Both old failures must stay fixed:
 *  - Oct 28 (#214): with an owner-only fact missing it gave up instead of asking.
 *  - Nov 3: it asked the owner for a POS number (today's student discounts) and
 *    saved the answer "0" as a fact.
 * The scripted runs check the harness on every CI run; the live runs ask the real
 * model and run only with AGENT_LIVE_EVAL=1 and OPENAI_API_KEY (owner, before release). */
const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const missing=(key:string)=>({available:false as const,value:null,
 quality:{level:"low" as const,missingInputs:[key],estimatedInputs:[],staleInputs:[]}});
function context():AgentToolContext{
 return {locale:"en",timezone:"America/Los_Angeles",asOf:"2026-11-03",currency:"USD",
  tools:{getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
   getSalesTrend:async()=>missing("salesNotAvailable"),getProfitability:async()=>missing("payroll")},
  readTodaySoFar:async()=>({available:true,value:{provisional:true,businessDate:"2026-11-03",
   readAt:"2026-11-04T03:15:00.000Z",netSalesCents:131846,grossSalesCents:132250,discountsCents:404,
   refundsCents:0,tipCents:0,orders:130,openChecks:0,unparsedOrders:0,
   topItems:[{name:"Latte",quantity:18,netSalesCents:10350}],locationsRead:1,locationsFailed:0,truncated:false}})};
}
const goldenAskQuestions=[
 {id:"owner-only-fact-missing",ownerText:"What's my profit this month?",mustAsk:true},
 {id:"pos-detail-not-in-yet",ownerText:"How many Dental Students & Faculty discounts were used today?",mustAsk:false},
] as const;
async function asked(ownerText:string,provider?:AgentProvider){
 const turn=await runAgentTurn({ownerText,context:context(),...(provider?{provider}:{})});
 return {asked:turn.results.some(r=>r.source==="ask_owner"&&r.missing.length===0),text:turn.text};
}

describe("golden ask questions: what the model is told",()=>{
 it("asks only for owner-only facts and never for POS figures",async()=>{
  let instructions="";
  const provider:AgentProvider=async function*(params){
   instructions=String((params as {instructions?:unknown}).instructions);
   yield {type:"response.output_text.delta",delta:"OK."} as never;yield completed as never;};
  await runAgentTurn({ownerText:"Hi",context:context(),provider});
  expect(instructions).toContain("Ask the owner with ask_owner only for what only the owner knows");
  expect(instructions).toContain("Never ask the owner for a figure the POS records");
  expect(instructions).toContain("say exactly what is missing and when it should arrive, and do not ask");
  expect(instructions).toContain("If an owner-only fact is empty, failed or uncertain, give the partial answer and call ask_owner");
  expect(agentToolDefinitions.find(d=>d.name==="ask_owner")?.description)
   .toContain("never for a figure the POS records");
 });
 it("the harness tells an asking turn from an answering turn",async()=>{
  const scripted=(events:unknown[]):AgentProvider=>{let i=0;
   return async function*(){if(i++===0)for(const e of events)yield e as never;};};
  const askCall={type:"response.output_item.done",item:{type:"function_call",name:"ask_owner",call_id:"q",
   arguments:JSON.stringify({kind:"facts",question:"What is your monthly payroll?",options:[],allowOther:false,changeSaved:false,
    fields:[{key:"monthly_payroll_cents",label:"Monthly payroll",inputType:"money",units:[],defaultUnit:"",choices:null,remember:"lasting"}]})}};
  expect((await asked(goldenAskQuestions[0].ownerText,scripted([askCall,completed]))).asked).toBe(true);
  expect((await asked(goldenAskQuestions[1].ownerText,scripted([{type:"response.output_text.delta",
   delta:"$4.04 in discounts so far today; which discounts arrives after closing."},completed]))).asked).toBe(false);
 });
});

describe.runIf(process.env.AGENT_LIVE_EVAL==="1"&&Boolean(process.env.OPENAI_API_KEY))("golden ask questions: live model",()=>{
 it.each(goldenAskQuestions)("$id",async q=>{
  const result=await asked(q.ownerText);
  expect(result.asked,q.ownerText+" → "+result.text).toBe(q.mustAsk);
 },90_000);
});
