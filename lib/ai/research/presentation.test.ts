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
  expect(resolveResearchSpec(spec({panels:[chart]}),new Map(),ctx)[0].tables?.[0].rows).toEqual([[null]]);
  const result=resolveResearchView({calculator:{ref:7},panels:[{...chart,ref:"wrong"},chart,{ref:"q1",kind:"table",columns:["category","amount_cents"]}]},queries,ctx);
  expect(result?.panels).toHaveLength(1);
  expect(result?.tables?.[0].rows).toEqual([[null]]);
  expect(result?.tables?.[1].rows).toEqual([["Wages",1200],["Supplies",0]]);
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
  expect(result.usage.requests).toHaveLength(3);
  expect(result.usage.toolMetrics).toMatchObject([{name:"run_sql",outcome:"failed"},{name:"run_sql",outcome:"complete",returnedRows:2}]);
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
   expect(params.tool_choice).toBe("auto");
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
  expect(view?.panels[0]).toMatchObject({points:[{label:"Rent",value:125025},{label:"Earlier amount",value:80000}]});
  expect(resolveResearchView({panels:[{kind:"metric",points:[{label:"Rent",value:{ref:"owner",quote:"$250.25"}}]}]},evidence,ctx)?.tables?.[0].rows).toEqual([["Rent",null,null]]);
 });
 it("does not coerce unknown values to zero, combine incompatible units, or expose hidden paths",()=>{
  const evidence=new Map([["q1",source({secret:42,amount_cents:1200,orders:3,missing:null},"Tool output")]]);
  for(const path of [["secret"],["__proto__","x"],["missing"],["absent"]]){
   expect(resolveResearchView({panels:[{kind:"metric",points:[{label:"Value",value:{ref:"q1",path}}]}]},evidence,ctx)?.tables?.[0].rows).toEqual([["Value",null,null]]);
  }
  expect(resolveResearchView({panels:[{kind:"bar",points:[{label:"Money",value:{ref:"q1",path:["amount_cents"]}},{label:"Orders",value:{ref:"q1",path:["orders"]}}]}]},evidence,ctx)?.tables?.[0].rows).toEqual([["Money",1200,"cents"],["Orders",3,"count"]]);
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
 expect(result.presentationDiagnostics).toMatchObject({requestedSections:1,decodedSections:1,rejectedSections:0,acceptedViews:1});
 expect(agentReplyPayload(result).metadata.presentationDiagnostics?.persistedViews).toBe(1);
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
 expect(payload.reply.status).toBe("answered");
 expect(payload.reply.blocks.map(b=>b.type)).toEqual(["text","rich_presentation","text"]);
 expect(payload.metadata.presentationDiagnostics?.persistedViews).toBe(1);
});

it("supplies verified matched answers to the resumed research turn",async()=>{
 const provider:AgentProvider=async function*(params){
  expect(params.input).toEqual(expect.arrayContaining([{role:"assistant",content:"What is the rent?"},{role:"user",content:"Rent is 1250."}]));
  yield {type:"response.output_text.delta",delta:"Rent is 1250."};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const result=await runResearchTurn({ownerText:"Review rent",matchedOwnerAnswers:[{questionId:"question",answerId:"answer",question:"What is the rent?",answer:"Rent is 1250."}],cafeContext:"Cafe",provider,scope:{db:{} as never,businessId:"business",ownerUserId:"owner"}});
 expect(result.unverified).toEqual([]);
});
it("lets the model finish after more than forty tool calls and five minutes",async()=>{
 let elapsed=0,calls=0;
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows},error:null});
 const provider:AgentProvider=async function*(params){
  calls++;expect(params.max_output_tokens).toBeUndefined();expect(params.tool_choice).toBe("auto");
  if(calls<=42){
   yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"q"+calls,arguments:JSON.stringify({sql:"select 1"})}};
  }else yield {type:"response.output_text.delta",delta:"Research complete."};
  yield {type:"response.completed",response:{usage:{input_tokens:10000,output_tokens:2000}}};
  elapsed+=10000;
 };
 const result=await runResearchTurn({ownerText:"Research",cafeContext:"Cafe",provider,now:()=>elapsed,scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"}});
 expect(calls).toBe(43);expect(rpc).toHaveBeenCalledTimes(42);expect(result.endReason).toBe("complete");expect(result.text).toBe("Research complete.");
});
it("resumes a physical worker slice without repeating completed SQL or losing presentation evidence",async()=>{
 let elapsed=0,saved:unknown=null;
 const rpc=vi.fn(async()=>{elapsed=110;return {data:{ok:true,rows},error:null};});
 const continuation={load:async()=>saved,save:async(state:unknown)=>{saved=structuredClone(state);}};
 const first:AgentProvider=async function*(){
  yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"q",arguments:JSON.stringify({sql:"select category, amount_cents from expenses"})}};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const scope={db:{rpc} as never,businessId:"business",ownerUserId:"owner"};
 const base={ownerText:"Research",cafeContext:"Cafe",scope,continuation,presentationContext:ctx,now:()=>elapsed};
 const interrupted=await runResearchTurn({...base,provider:first,executionDeadline:100});
 expect(interrupted.endReason).toBe("timeout");expect(rpc).toHaveBeenCalledTimes(1);
 const second:AgentProvider=async function*(params){
  expect(JSON.stringify(params.input)).toContain("amount_cents");
  yield {type:"response.output_text.delta",delta:"Completed.\n\n"+fence({panels:[chart]})};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const resumed=await runResearchTurn({...base,provider:second,executionDeadline:1000});
 expect(resumed.endReason).toBe("complete");expect(rpc).toHaveBeenCalledTimes(1);
 expect(resumed.results.some(r=>r.source==="response_presentation")).toBe(true);
});


describe("model-authored analytical presentation",()=>{
 it("renders derived break-even results even when not present verbatim in SQL evidence",()=>{
  const result=resolveResearchView({panels:[{kind:"metric",title:"Monthly break-even",unit:"cents",basis:"calculated",explanation:"Fixed costs divided by contribution margin",points:[{label:"Break-even sales",value:375000}]}]},new Map(),ctx);
  expect(result?.panels[0]).toMatchObject({source:"response_evidence",unit:"cents",currency:"USD",points:[{label:"Break-even sales",value:375000}]});
  expect(result?.panels[0].sourceDetail).toContain("calculated");
 });
 it("preserves Luna-authored estimate descriptions without requiring source bindings",()=>{
  const result=resolveResearchView({panels:[{kind:"line",title:"Sales forecast",unit:"cents",basis:"estimate",explanation:"Assumes steady growth",points:[{label:"December",value:120000},{label:"January",value:132000}]}]},new Map(),ctx);
  expect(result?.panels[0]).toMatchObject({coverage:"estimate",points:[{label:"December",value:120000},{label:"January",value:132000}]});
 });
 it("keeps direct model values and preserves fractional amounts without grading confidence",()=>{
  const panel={kind:"metric",title:"Break-even",unit:"cents",basis:"calculated",explanation:"Derived",points:[{label:"Value",value:1.5}]};
  expect(resolveResearchView({panels:[panel]},new Map(),ctx)?.panels[0].points[0].value).toBe(1.5);
  expect(resolveResearchView({panels:[{...panel,basis:"actual",points:[{label:"Value",value:100}]}]},new Map(),ctx)?.panels[0]).toMatchObject({points:[{value:100}]});
 });
});

it("does not discard or truncate series just because there are more than thirty records",()=>{
 const longRows=Array.from({length:40},(_,i)=>({category:"Day "+(i+1),amount_cents:i+1}));
 const sources=new Map([["q1",{data:{ok:true,rows:longRows},source:"Returned SQL evidence",kind:"sql" as const}]]);
 const view=resolveResearchView({panels:[chart,{ref:"q1",kind:"table",columns:["category","amount_cents"]}]},sources,ctx);
 expect(view?.panels[0].points).toHaveLength(40);
 expect(view?.tables?.[0].rows).toHaveLength(40);
 expect(view?.tables?.[0].coverage).toBe("stored");
});

it("keeps direct values, unknown cells, custom units and long labels without any database evidence",()=>{
 const result=resolveResearchView({panels:[
  {kind:"metric",title:"Margin 2027",unit:"%",basis:"estimate",points:[{label:"Expected",value:13.375}]},
  {kind:"bar",title:"Costs",unit:"cents",basis:"scenario",points:[{label:"Known",value:0},{label:"Unknown",value:null},{label:"Credit",value:-1200.25}]},
  {kind:"metric",unit:"cents",points:[{label:"No currency set",value:9876.5}]},
 ],tables:[{title:"Assumptions",basis:"scenario",columns:["Item","Amount"],rows:[["Rent",1200],["Other",null],["Note","x".repeat(1000)]]}]},new Map(),{asOf:ctx.asOf,currency:null});
 expect(result?.panels[0]).toMatchObject({coverage:"estimate",unit:"units",measurement:"%",points:[{value:13.375}]});
 expect(result?.panels[1]).toMatchObject({currency:null,points:[{value:9876.5}]});
 expect(result?.tables?.[0].rows).toEqual([["Known",0],["Unknown",null],["Credit",-1200.25]]);
 expect(result?.tables?.[1].rows[2][1]).toHaveLength(1000);
});
it("persists a visual-only model answer after an unavailable SQL read",async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{ok:false,error:"no records"},error:null});
 let calls=0;
 const provider:AgentProvider=async function*(){
  if(++calls===1)yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"q",arguments:JSON.stringify({sql:"select 1"})}};
  else yield {type:"response.output_text.delta",delta:fence({panels:[{kind:"metric",unit:"cents",basis:"estimate",points:[{label:"Projected cost",value:125000}]}],tables:[{columns:["Cost","Value"],rows:[["Unknown",null]]}]})};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const result=await runResearchTurn({ownerText:"Give me an estimate",cafeContext:"Cafe",provider,scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx});
 const payload=agentReplyPayload(result);
 expect(result.endReason).toBe("complete");
 expect(payload.reply.blocks).toMatchObject([{type:"rich_presentation",panels:[{coverage:"estimate",points:[{value:125000}]}],tables:[{rows:[["Unknown",null]]}]}]);
 expect(groundedReplySchema.safeParse(payload.reply).success).toBe(true);
});

it("keeps a numerical title and mixed model-authored and bound values after a failed reference",()=>{
 const heading="Estimated profit $8,500 — "+"Long heading ".repeat(20);
 const result=resolveResearchView({panels:[{kind:"bar",title:heading,points:[
  {label:"Recorded",value:{ref:"q1",path:["rows",0,"amount_cents"]}},
  {label:"Estimate",value:850000,unit:"cents",basis:"estimate"},
  {label:"Unknown",value:{ref:"absent",path:["value"]}}
 ]}]},queries,ctx);
 expect(result?.tables?.[0]).toMatchObject({title:heading,rows:[["Recorded",1200,"cents"],["Estimate",850000,"cents"],["Unknown",null,null]]});
});
it("interrupts a non-durable provider at its physical request deadline, preserving earlier completed paragraphs",async()=>{
 let elapsed=0,calls=0;
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows},error:null});
 const provider:AgentProvider=async function*(){
  if(++calls===1){
   yield {type:"response.output_text.delta",delta:"These are the available records."};
   yield {type:"response.output_item.done",item:{type:"function_call",name:"run_sql",call_id:"q",arguments:JSON.stringify({sql:"select 1"})}};
   yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
  }else{
   elapsed=2000;
   yield {type:"response.output_text.delta",delta:"Incomplete output"};
  }
 };
 const result=await runResearchTurn({ownerText:"Check sales",cafeContext:"Cafe",provider,scope:{db:{rpc} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx,now:()=>elapsed,executionDeadline:1000});
 expect(result.endReason).toBe("timeout");
 expect(result.text).toBe("These are the available records.");
 expect(agentReplyPayload(result).reply.blocks).toContainEqual({type:"text",text:result.text});
});
