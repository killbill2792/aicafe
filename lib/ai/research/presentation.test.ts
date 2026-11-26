import {describe,it,expect,vi} from "vitest";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
import {resolveResearchSpec,resolveResearchView,INLINE_PRESENTATION_HINT} from "./presentation";
import {agentReplyPayload} from "@/lib/ai/agent/persist.server";
import {groundedReplySchema} from "@/lib/ai/conversations/contracts";
import {researchInlineEvents} from "./inlineStream";
import {runResearchTurn} from "./turn.server";
vi.mock("server-only",()=>({}));
const spec=(value:unknown)=>[{op:"add",path:"/root",value:"view"},{op:"add",path:"/elements/view",value:{type:"DataView",props:value,children:[]}}];
const fence=(value:unknown)=>String.fromCharCode(96).repeat(3)+"spec\n"+spec(value).map(p=>JSON.stringify(p)).join("\n")+"\n"+String.fromCharCode(96).repeat(3)+"\n";
const ctx={asOf:"2026-11-25",currency:"USD"};
const rows=[{category:"Wages",amount_cents:1200},{category:"Supplies",amount_cents:0}];
const queries=new Map([["q1",{data:{ok:true,rows},source:"Returned SQL evidence",kind:"sql" as const}]]);
const chart={ref:"q1",kind:"bar",x:"category",y:"amount_cents"};
describe("SQL research presentation",()=>{
 it("renders exact SQL values in existing panels without another query, including zero",()=>{
  const result=resolveResearchSpec(spec({layout:"grid",panels:[chart]}),queries,ctx);
  expect(result).toMatchObject([{type:"rich_presentation",panels:[{source:"sql_research",currency:"USD",points:[{label:"Wages",value:1200},{label:"Supplies",value:0}]}]}]);
 });
 it("keeps valid siblings when a visual is malformed and rejects unsafe patches",()=>{
  expect(resolveResearchSpec(spec({panels:[chart]}),new Map(),ctx)).toEqual([]);
  const result=resolveResearchView({calculator:{ref:7},panels:[{...chart,ref:"wrong"},chart,{ref:"q1",kind:"table",columns:["category","amount_cents"]}]},queries,ctx);
  expect(result?.panels).toHaveLength(1);
  expect(result?.tables?.[0].rows).toEqual([["Wages",1200],["Supplies",0]]);
  const blocks=resolveResearchSpec([...spec({panels:[chart]}),{op:"add",path:"/elements/__proto__/polluted",value:true}],queries,ctx);
  expect(blocks).toHaveLength(1);
  expect(({} as {polluted?:boolean}).polluted).toBeUndefined();
 });
 it("native transform preserves blank lines and emits separate text and UI sections across split chunks",async()=>{
  const raw="**Total**\n\n"+fence({panels:[chart]})+"Next paragraph.\n\n"+fence({panels:[{...chart,kind:"table"}]})+"Done.";
  async function* source(){for(let i=0;i<raw.length;i+=7)yield {type:"response.output_text.delta",delta:raw.slice(i,i+7)};yield {type:"response.completed"};}
  const out=[];for await(const event of researchInlineEvents(source()))out.push(event);
  expect(out.filter(e=>e.type==="inline-text").map(e=>e.delta).join("")).toBe("**Total**\n\nNext paragraph.\n\nDone.");
  expect(out.filter(e=>e.type==="inline-patch")).toHaveLength(4);
 });
 it("continues a failed SQL query and streams complete paragraphs and multiline summaries without a presentation-only call",async()=>{
  let calls=0;
  const streamed:string[]=[],thinking:string[]=[];
  const order:string[]=[];
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
   yield {type:"response.output_text.delta",delta:fence({panels:[chart]})+"Here is the breakdown.\n\n"+fence({panels:[{...chart,kind:"table",columns:["category","amount_cents"]}]})+"Review the costs."};
   yield done;
  };
  const result=await runResearchTurn({ownerText:"Break down my expenses",cafeContext:"Cafe",provider,
   scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},actions:{context:ctx as AgentToolContext,definitions:[]},
   onDelta:v=>{streamed.push(v);order.push("text:"+v);},onThinking:v=>thinking.push(v),onPresentation:(_at,block)=>order.push(block.tables?.length?"table":"chart")});
  expect(calls).toBe(3);expect(rpc).toHaveBeenCalledTimes(2);
  expect(result.text).toBe("Expenses are recorded.\n\nHere is the breakdown.\n\nReview the costs.");
  expect(order).toEqual(["text:Expenses are recorded.\n\n","chart","text:Here is the breakdown.\n\n","table","text:Review the costs."]);
  expect(streamed.join("")).toBe(result.text);
  expect(thinking).toEqual(["Checking costs.","Preparing results."]);
  expect(result.results.filter(r=>r.source==="response_presentation")).toHaveLength(2);
  expect(result.results.at(-2)).toMatchObject({source:"response_presentation",accepted:true,presentation:{panels:[{points:[{value:1200},{value:0}]}]}});
  const payload=agentReplyPayload(result);
  expect(payload.reply.blocks.map(b=>b.type)).toEqual(["text","rich_presentation","text","rich_presentation","text"]);
  expect(groundedReplySchema.safeParse(payload.reply).success).toBe(true);
  expect(result.usage.toolCalls).toBe(2);
  expect(result.toolInvocations).toHaveLength(2);
 });
});

describe("failed SQL research provider streams",()=>{
 const done={type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 const say=(delta:string)=>({type:"response.output_text.delta",delta});
 const query={type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"costs",arguments:JSON.stringify({sql:"select category, amount_cents from expenses"})}};
 const earlier="I will check the expense records.";
 const wrong="❌ Expenses were $900.";
 const corrected="Recorded wages were $12.";
 it.each(["response.failed","response.incomplete","error","disconnect","throw"])("rolls back only the failed call (%s) before recovering",async failure=>{
  let calls=0,client="";
  const resets:number[]=[];
  const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows},error:null});
  const provider:AgentProvider=async function*(params){
   calls++;
   if(calls===1){yield say(earlier+"\n\n");yield query;yield done;return;}
   if(calls===2){
    yield say(wrong+"\n\n");
    yield say("Unfinished second paragraph");
    if(failure==="throw")throw Error("connection lost");
    if(failure!=="disconnect")yield {type:failure};
    return;
   }
   expect(calls).toBe(3);
   expect(client).toBe(earlier+"\n\n");
   expect(params.tool_choice).toBe("none");
   expect(JSON.stringify(params.input)).not.toContain(wrong);
   yield say(corrected+"\n\n"+fence({panels:[chart]}));yield done;
  };
  const turn=await runResearchTurn({ownerText:"Check expenses",cafeContext:"Cafe",provider,
   scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},actions:{context:ctx as AgentToolContext,definitions:[]},
   onDelta:delta=>{client+=delta;},onReset:count=>{resets.push(count);client=client.slice(0,client.length-count);}});
  expect(calls).toBe(3);expect(rpc).toHaveBeenCalledTimes(1);
  expect(resets).toEqual([(wrong+"\n\n").length]);
  expect(turn.text).toBe(earlier+"\n\n"+corrected+"\n\n");
  expect(client).toBe(turn.text);
  expect(turn.results.at(-1)).toMatchObject({source:"response_presentation",accepted:true});
 });
 it("also rolls back a failed recovery request",async()=>{
  let calls=0,client="";
  const resets:number[]=[];
  const recovery="Another incomplete conclusion.";
  const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows},error:null});
  const provider:AgentProvider=async function*(){
   calls++;
   if(calls===1){yield say(earlier);yield query;yield done;return;}
   yield say((calls===2?wrong:recovery)+"\n\n");
   yield {type:"response.failed"};
  };
  const turn=await runResearchTurn({ownerText:"Check expenses",cafeContext:"Cafe",provider,
   scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},
   onDelta:delta=>{client+=delta;},onReset:count=>{resets.push(count);client=client.slice(0,client.length-count);}});
  expect(calls).toBe(3);
  expect(resets).toEqual([("\n\n"+wrong+"\n\n").length,("\n\n"+recovery+"\n\n").length]);
  expect(turn.text).toBe(earlier);
  expect(client).toBe(earlier);
  expect(turn.endReason).toBe("provider_error");
 });
 it("does not retain a failed first response even when there is no research to recover",async()=>{
  let client="";
  const provider:AgentProvider=async function*(){yield say(wrong+"\n\n");yield {type:"response.failed"};};
  const turn=await runResearchTurn({ownerText:"Check expenses",cafeContext:"Cafe",provider,
   scope:{db:{} as never,businessId:"business",ownerUserId:"owner"},
   onDelta:delta=>{client+=delta;},onReset:count=>{client=client.slice(0,client.length-count);}});
  expect(turn.text).toBe("");
  expect(client).toBe("");
  expect(turn.endReason).toBe("provider_error");
 });
});

it("rolls back already streamed visuals from a failed call but preserves earlier successful components",async()=>{
 let calls=0,client="",live=0;const resets:number[][]=[];
 const done={type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 const say=(delta:string)=>({type:"response.output_text.delta",delta});
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows},error:null});
 const provider:AgentProvider=async function*(){
  calls++;
  if(calls===1){yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"one",arguments:JSON.stringify({sql:"select category, amount_cents from expenses"})}};yield done;return;}
  if(calls===2){yield say("Confirmed.\n\n"+fence({panels:[chart]})+"Discard this.\n\n");yield {type:"response.failed"};return;}
  expect(client).toBe("");expect(live).toBe(0);
  yield say("Recovered.\n\n"+fence({panels:[chart]})+"Done.");yield done;
 };
 const result=await runResearchTurn({ownerText:"Expenses",cafeContext:"Cafe",provider,scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},actions:{context:ctx as AgentToolContext,definitions:[]},
  onDelta:delta=>{client+=delta;},onPresentation:()=>{live++;},onReset:(chars,views)=>{client=client.slice(0,client.length-chars);live-=views??0;resets.push([chars,views??0]);}});
 expect(resets[0][1]).toBe(1);expect(client).toBe("Recovered.\n\nDone.");expect(live).toBe(1);
 expect(result.results.filter(r=>r.source==="response_presentation")).toHaveLength(1);
});

describe("source-independent inline presentation",()=>{
 const source=(data:Record<string,unknown>,source:string)=>({data,source});
 it("combines independently admitted values from arbitrary nested tool responses and SQL rows",()=>{
  const evidence=new Map([["q1",source({ok:true,rows:[{total_cents:930000}]},"Sales evidence")],["q2",source({result:{laborCents:210000}},"Labor evidence")]]);
  const view=resolveResearchView({panels:[{kind:"bar",title:"Costs and sales",points:[
   {label:"Sales",value:{ref:"q1",path:["rows",0,"total_cents"]}},
   {label:"Labor",value:{ref:"q2",path:["result","laborCents"]}},
  ]}]},evidence,ctx);
  expect(view?.panels[0]).toMatchObject({source:"response_evidence",unit:"cents",points:[{label:"Sales",value:930000},{label:"Labor",value:210000}],sourceDetail:"Sales evidence; Labor evidence"});
 });
 it("binds owner and historical text without treating it as fresh actuals",()=>{
  const evidence=new Map([["owner",{data:{},text:"Rent $1,250.25 and utilities $450.",source:"Owner supplied"}],["history1",{data:{},text:"Earlier amount $800.",source:"Historical message",coverage:"partial" as const}]]);
  const view=resolveResearchView({panels:[{kind:"bar",points:[{label:"Rent",value:{ref:"owner",quote:"$1,250.25"}},{label:"Earlier amount",value:{ref:"history1",quote:"$800"}}]}]},evidence,ctx);
  expect(view?.panels[0]).toMatchObject({coverage:"partial",points:[{label:"Rent",value:125025},{label:"Earlier amount",value:80000}]});
  expect(resolveResearchView({panels:[{kind:"metric",points:[{label:"Rent",value:{ref:"owner",quote:"$250.25"}}]}]},evidence,ctx)).toBeUndefined();
 });
 it("does not coerce unknown values to zero, combine incompatible units, or expose hidden paths",()=>{
  const evidence=new Map([["q1",source({secret:42,amount_cents:1200,orders:3,missing:null},"Tool output")]]);
  for(const path of [["secret"],["__proto__","x"],["missing"],["absent"]]){
   expect(resolveResearchView({panels:[{kind:"metric",points:[{label:"Value",value:{ref:"q1",path}}]}]},evidence,ctx)).toBeUndefined();
  }
  expect(resolveResearchView({panels:[{kind:"bar",points:[{label:"Money",value:{ref:"q1",path:["amount_cents"]}},{label:"Orders",value:{ref:"q1",path:["orders"]}}]}]},evidence,ctx)).toBeUndefined();
 });
 it("can compose a visual without any data retrieval or extra model request",async()=>{
  const provider:AgentProvider=async function*(params){
   expect(JSON.stringify(params.input)).toContain("Presentation text references");
   yield {type:"response.output_text.delta",delta:"Your provided figures.\n\n"+fence({panels:[{kind:"bar",title:"Rent and bills",points:[{label:"Rent",value:{ref:"owner",quote:"$1250"}},{label:"Bills",value:{ref:"owner",quote:"$450"}}]}]})+"These are your figures."};
   yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
  };
  const result=await runResearchTurn({ownerText:"Rent $1250 and bills $450",cafeContext:"Cafe",provider,scope:{db:{} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx});
  expect(result.usage.modelCalls).toBe(1);expect(result.usage.toolCalls).toBe(0);
  expect(agentReplyPayload(result).reply.blocks.map(b=>b.type)).toEqual(["text","rich_presentation","text"]);
 });
});

it("uses the library's schema-derived native syntax without unsupported demo widgets or state requirements",()=>{
 expect(INLINE_PRESENTATION_HINT).toContain('"type":"DataView"');
 expect(INLINE_PRESENTATION_HINT).toContain("points");
 expect(INLINE_PRESENTATION_HINT).not.toContain('"type":"Card"');
 expect(INLINE_PRESENTATION_HINT).not.toContain("Include realistic sample data");
 expect(INLINE_PRESENTATION_HINT).not.toContain("You MUST include state patches");
});
it("distinguishes absent output, rejected view selection, and persisted visual receipts",async()=>{
 const provider:AgentProvider=async function*(){
  yield {type:"response.output_text.delta",delta:"Evidence unavailable.\n\n"+fence({panels:[{kind:"metric",points:[{label:"Unbound",value:{ref:"unknown",path:["total_cents"]}}]}]})+"No value was supplied."};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const result=await runResearchTurn({ownerText:"Compare",cafeContext:"Cafe",provider,scope:{db:{} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx});
 expect(result.presentationDiagnostics).toMatchObject({requestedSections:1,decodedSections:1,rejectedSections:1,acceptedViews:0});
 expect(agentReplyPayload(result).metadata.presentationDiagnostics?.persistedViews).toBe(0);
 expect(result.text).toContain("No value was supplied.");
});

it("preserves a valid owner-sourced visual when an unrelated tool fails",async()=>{
 let calls=0;
 const provider:AgentProvider=async function*(){
  calls++;
  if(calls===1){yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"failed",arguments:JSON.stringify({sql:"select 1"})}};}
  else yield {type:"response.output_text.delta",delta:"From your own information.\n\n"+fence({panels:[{kind:"metric",points:[{label:"Rent",value:{ref:"owner",quote:"$1250"}}]}]})+"The business records could not be retrieved."};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const rpc=vi.fn().mockResolvedValue({data:{ok:false,error:"unavailable"},error:null});
 const result=await runResearchTurn({ownerText:"Rent $1250",cafeContext:"Cafe",provider,scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx});
 const payload=agentReplyPayload(result);
 expect(payload.reply.status).toBe("unavailable");
 expect(payload.reply.blocks.map(b=>b.type)).toEqual(["text","rich_presentation","text"]);
 expect(payload.metadata.presentationDiagnostics?.persistedViews).toBe(1);
});
