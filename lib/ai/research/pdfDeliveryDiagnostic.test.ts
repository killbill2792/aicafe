import {describe,expect,it,vi} from "vitest";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
import {runResearchTurn} from "./turn.server";
import {agentReplyPayload} from "@/lib/ai/agent/persist.server";
import {nativeChartProps} from "@/lib/ai/conversations/nativePresentation";
import {renderSavedAnswerPdf} from "@/lib/ai/conversations/pdfReport.server";
import {PDFParse} from "pdf-parse";
vi.mock("server-only",()=>({}));
const ctx={asOf:"2026-11-25",currency:"USD"};
const doc={root:"doc",elements:{
 doc:{type:"Document",props:{title:"Diagnostic accounting statement"},children:["page"]},
 page:{type:"Page",props:{size:"LETTER"},children:["heading","table"]},
 heading:{type:"Heading",props:{text:"Diagnostic statement",level:"h1"},children:[]},
 table:{type:"Table",props:{columns:[{header:"Account"},{header:"Amount"}],rows:[["Sales","123.45"],["Costs","-25.00"]]},children:[]}
}};
const patches=[{op:"add",path:"/root",value:doc.root},...Object.entries(doc.elements).map(([key,value])=>({op:"add",path:"/elements/"+key,value}))].map(v=>JSON.stringify(v)).join("\n");
const intro="I prepared the accounting summary PDF below.\n\n";
const fence=(lang:string,body:string)=>"\x60\x60\x60"+lang+"\n"+body+"\n\x60\x60\x60";
async function replay(label:string,raw:string,terminalOnly=false){
 let calls=0;
 const provider:AgentProvider=async function*(){
  calls++;
  const streamed=terminalOnly?intro:raw;
  for(let i=0;i<streamed.length;i+=7)yield {type:"response.output_text.delta",delta:streamed.slice(i,i+7)};
  yield {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[{type:"output_text",text:raw,annotations:[]}]}};
  yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
 };
 const result=await runResearchTurn({ownerText:"Generate a PDF",cafeContext:"Synthetic Cafe",provider,scope:{db:{} as never,businessId:"business",ownerUserId:"owner"},presentationContext:ctx});
 const reply=agentReplyPayload(result).reply;
 const documents=reply.blocks.flatMap(b=>b.type==="rich_presentation"&&b.pdfSpec?[b]:[]);
 let pdfTitle:string|null=null,pdfContainsData=false;
 if(documents[0]){
  const bytes=await renderSavedAnswerPdf({blocks:reply.blocks,grounding:null,createdAt:"2026-11-25T10:00:00Z"},documents[0]);
  expect(Buffer.from(bytes).subarray(0,5).toString()).toBe("%PDF-");
  const parser=new PDFParse({data:Uint8Array.from(bytes)});
  try{pdfTitle=String((await parser.getInfo()).info.Title);pdfContainsData=(await parser.getText()).text.includes("123.45");}finally{await parser.destroy();}
 }
 expect(calls).toBe(1);
 console.log("PDF_REPLAY "+JSON.stringify({label,diagnostics:result.presentationDiagnostics,documents:documents.length,pdfTitle,pdfContainsData,textLength:result.text.length,hasIntro:result.text.includes("I prepared"),hasDocumentDataInText:result.text.includes("123.45")}));
 return {documents,pdfTitle,pdfContainsData,result};
}
describe("deployed PDF delivery diagnostic (no provider, no production data)",()=>{
 it("runs the canonical split-delta document all the way through saved answer and actual PDF bytes",async()=>{
  const r=await replay("canonical",intro+fence("spec",patches)+"\n");
  expect(r.documents).toHaveLength(1);expect(r.pdfTitle).toBe("Diagnostic accounting statement");expect(r.pdfContainsData).toBe(true);
 },30000);
 it("reproduces a missing document when the provider emits only the introduction",async()=>{
  const r=await replay("prose-only",intro);expect(r.documents).toHaveLength(0);
 });
 it("recovers a document available in the completed message but missing from text deltas",async()=>{
  const r=await replay("terminal-message-document",intro+fence("spec",patches)+"\n",true);
  expect(r.documents).toHaveLength(1);expect(r.pdfTitle).toBe("Diagnostic accounting statement");expect(r.pdfContainsData).toBe(true);
 });
 it("delivers alternative serializations with identical document content",async()=>{
  for(const [label,raw] of [
    ["json-fence-full-spec",intro+fence("json",JSON.stringify(doc))+"\n"],
    ["spec-fence-full-spec",intro+fence("spec",JSON.stringify(doc))+"\n"],
    ["spec-fence-patch-array",intro+fence("spec",JSON.stringify(JSON.parse("["+patches.split("\n").join(",")+"]")))+"\n"],
    ["canonical-no-trailing-newline",intro+fence("spec",patches)]
  ]){const r=await replay(label,raw);expect(r.documents).toHaveLength(1);expect(r.pdfTitle).toBe("Diagnostic accounting statement");expect(r.pdfContainsData).toBe(true);}

 },30000);
 it("accepts omitted currency in a count metric without calling the model",()=>{
  const count={kind:"metric",title:"Orders",unit:"count",asOf:ctx.asOf,points:[{label:"Orders",value:1}]};
  const without=nativeChartProps.safeParse(count),withNull=nativeChartProps.safeParse({...count,currency:null});
  console.log("METRIC_REPLAY "+JSON.stringify({withoutCurrency:without.success,withNullCurrency:withNull.success}));
  expect(without.success).toBe(true);expect(withNull.success).toBe(true);if(without.success)expect(without.data.currency).toBeNull();
 });
});
