import {describe,it,expect} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import {scopedOwnerQuestionKey} from "@/lib/ownerFacts/questions";
import type {AgentToolContext} from "./tools";
const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const say=(delta:string)=>({type:"response.output_text.delta",delta});
const tool=(name:string,args:unknown,call_id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id}});
const base:AgentToolContext={locale:"en",timezone:"America/Los_Angeles",asOf:"2026-10-28",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{level:"low",missingInputs:["salesNotAvailable"],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{level:"low",missingInputs:["payroll"],estimatedInputs:[],staleInputs:[]}})
 }
};
function fixture(rounds:unknown[][]):AgentProvider{
 let i=0;return async function*(){for(const e of rounds[i++]??[])yield e as never;};
}
const scopedMenuKey=scopedOwnerQuestionKey(
 {kind:"empty",key:"menu_items",tool:"menu_items"},[],
 "What menu items can I price?"
);
describe("main-loop mandatory owner question",()=>{
 it("model skips card after empty menu → code adds typed card",async()=>{
  const turn=await runAgentTurn({ownerText:"What menu items can I price?",context:{...base},provider:fixture([
   [tool("get_menu_items",{query:null,limit:null},"menu"),completed],
   [say("I found no items in the menu."),completed]
  ])});
  const card=turn.results.find(r=>r.source==="ask_owner");
  expect(card).toMatchObject({kind:"facts",missing:[]});
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify"&&b.kind==="facts")).toBe(true);
 });
 it("a partial numeric answer is preserved next to a mandatory owner card",async()=>{
  const turn=await runAgentTurn({ownerText:"What item prices are recorded?",context:{...base},
   provider:fixture([[tool("get_menu_items",{query:null,limit:null},"menu"),completed],
    [say("The owner recorded $5.00, but other costs are not available."),completed]])});
  expect(turn.text).toContain("$5.00");
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(true);
 });
 it("saved fact in a new thread prevents repeat card",async()=>{
  const turn=await runAgentTurn({ownerText:"What menu items can I price?",context:{...base},
   ownerFacts:[{fact_key:scopedMenuKey,value_json:"Owner said no current items",unit:null,period_scope:null,created_at:"2026-10-28T00:00:00Z"}],
   provider:fixture([[tool("get_menu_items",{query:null,limit:null},"menu"),completed],[say("No recorded items."),completed]])});
  expect(turn.results.some(r=>r.source==="ask_owner")).toBe(false);
 });
 it("a saved fact replaces model no-data refusal without repeating the card",async()=>{
  const saved=[{fact_key:scopedMenuKey,value_json:"Owner says three items",
   unit:null,period_scope:null,created_at:"2026-10-28T00:00:00Z"}];
  const turn=await runAgentTurn({ownerText:"What menu items can I price?",context:{...base},
   ownerFacts:saved,provider:fixture([[tool("get_menu_items",{query:null,limit:null},"menu"),completed],
    [say("No data."),completed]])});
  expect(turn.results.some(r=>r.source==="ask_owner")).toBe(false);
  expect(turn.text).toContain("Owner says three items");
  expect(turn.text).not.toContain("No data.");
 });
 it("owner-fact database outage remains an explicit tool failure",async()=>{
  const turn=await runAgentTurn({ownerText:"What is our payroll?",context:{...base},
   ownerFactsReadFailed:true,provider:fixture([[say("No data."),completed]])});
  expect(turn.results.some(r=>r.source==="owner_facts"&&r.error==="owner_facts_read_failed")).toBe(true);
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(true);
  expect(turn.text).toContain("I couldn't read");
 });
 it.each([["es","No tengo esa información."],["ar","لا توجد بيانات."]] as const)(
  "model refusal in %s is replaced with an owner card",async(locale,reply)=>{
   const turn=await runAgentTurn({ownerText:locale==="es"?"¿Cuánto cuesta?":"كم السعر؟",
    context:{...base,locale},provider:fixture([[say(reply),completed]])});
   expect(turn.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(true);
   expect(turn.text).not.toContain(reply);
  });
 it("model may voluntarily ask a noncatalog text fact",async()=>{
  const turn=await runAgentTurn({ownerText:"Where do we store delivery crates?",
   context:{...base},provider:fixture([
    [tool("ask_owner",{kind:"facts",question:"Where are crates?",options:[],allowOther:false,
      fields:[{key:"crate_location",label:"Crate location",inputType:"text",units:[],defaultUnit:""}]},"q"),completed]
   ])});
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(true);
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify"&&b.kind==="facts")).toBe(true);
 });
});
