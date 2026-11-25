import {describe,it,expect,vi} from "vitest";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
import {splitResearchPresentation} from "./presentation";
import {runResearchTurn} from "./turn.server";
vi.mock("server-only",()=>({}));
const fence=(value:unknown)=>"\n\n"+String.fromCharCode(96).repeat(3)+"cafe-ui\n"+JSON.stringify(value)+"\n"+String.fromCharCode(96).repeat(3);
const ctx={asOf:"2026-11-25",currency:"USD"};
const rows=[{category:"Wages",amount_cents:1200},{category:"Supplies",amount_cents:0}];
const queries=new Map([["q1",{ok:true,rows}]]);
const chart={ref:"q1",kind:"bar",x:"category",y:"amount_cents"};
describe("SQL research presentation",()=>{
 it("renders exact SQL values in existing panels without another query, including zero",()=>{
  const result=splitResearchPresentation("Here is the breakdown."+fence({layout:"grid",panels:[chart]}),queries,ctx);
  expect(result.text).toBe("Here is the breakdown.");
  expect(result.presentation).toMatchObject({type:"rich_presentation",panels:[{source:"sql_research",currency:"USD",points:[{label:"Wages",value:1200},{label:"Supplies",value:0}]}]});
 });
 it("keeps plain Markdown and valid siblings when a visual is malformed",()=>{
  const text="**Total**\n\n- Detail";
  expect(splitResearchPresentation(text,new Map(),ctx)).toEqual({text});
  const result=splitResearchPresentation(text+fence({panels:[{...chart,ref:"wrong"},chart,{ref:"q1",kind:"table",columns:["category","amount_cents"]}]}),queries,ctx);
  expect(result.text).toBe(text);
  expect(result.presentation?.panels).toHaveLength(1);
  expect(result.presentation?.tables?.[0].rows).toEqual([["Wages",1200],["Supplies",0]]);
  const malformed=text+"\n\n"+String.fromCharCode(96).repeat(3)+"cafe-ui\n{broken";
  expect(splitResearchPresentation(malformed,queries,ctx)).toEqual({text});
 });
 it("continues a failed SQL query and streams complete paragraphs and multiline summaries without a presentation-only call",async()=>{
  let calls=0;
  const streamed:string[]=[],thinking:string[]=[];
  const rpc=vi.fn().mockResolvedValueOnce({data:{ok:false,error:"unknown column"},error:null}).mockResolvedValueOnce({data:{ok:true,rows},error:null});
  const done={type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
  const query=(id:string)=>({type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:id,arguments:JSON.stringify({sql:"select category, amount_cents from expenses"})}});
  const provider:AgentProvider=async function*(params){
   calls++;
   if(calls===1){yield query("one");yield done;return;}
   if(calls===2){expect(JSON.stringify(params.input)).toContain("unknown column");yield query("two");yield done;return;}
   expect(JSON.stringify(params.input)).toContain("presentationRef");
   yield {type:"response.reasoning_summary_text.delta",delta:"Checking costs."};
   yield {type:"response.reasoning_summary_part.added"};
   yield {type:"response.reasoning_summary_text.delta",delta:"Preparing results."};
   yield {type:"response.output_text.delta",delta:"Expenses are recorded.\n\n"};
   expect(streamed.join("")).toBe("Expenses are recorded.");
   yield {type:"response.output_text.delta",delta:"Here is the breakdown."+fence({panels:[chart]})};
   yield done;
  };
  const result=await runResearchTurn({ownerText:"Break down my expenses",cafeContext:"Cafe",provider,
   scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},actions:{context:ctx as AgentToolContext,definitions:[]},
   onDelta:v=>streamed.push(v),onThinking:v=>thinking.push(v)});
  expect(calls).toBe(3);expect(rpc).toHaveBeenCalledTimes(2);
  expect(result.text).toBe("Expenses are recorded.\n\nHere is the breakdown.");
  expect(streamed.join("")).toBe(result.text);
  expect(thinking.at(-1)).toBe("Checking costs.\n\nPreparing results.");
  expect(result.results.at(-1)).toMatchObject({source:"response_presentation",accepted:true,presentation:{panels:[{points:[{value:1200},{value:0}]}]}});
  expect(result.usage.toolCalls).toBe(2);
  expect(result.toolInvocations).toHaveLength(2);
 });
});
