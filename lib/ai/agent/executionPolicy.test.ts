import {describe,it,expect} from "vitest";
import {executionPolicy,requestOutputCap,providerUsageReceipt,requestComposition} from "./executionPolicy";
describe("technical execution budgets, not business intent routing",()=>{
 it("reserves synthesis tokens for complex work and retains old provider constraints",()=>{
   const p=executionPolicy("gpt-6-luna",undefined,false);
   expect(requestOutputCap(p,0,false)).toBe(16384);
   expect(requestOutputCap(p,16384,false)).toBe(8192);
   expect(requestOutputCap(p,24576,false)).toBe(0);
   expect(requestOutputCap(p,24576,true)).toBe(8192);
   expect(requestOutputCap(p,32768,true)).toBe(0);
   expect(executionPolicy("gpt-6-luna",undefined,true).finalReserve).toBe(1200);
   expect(executionPolicy("gpt-4.1-mini",undefined,false).maxWorkOutput).toBe(1200);
 });
 it("honours a smaller authenticated claim and legacy SQL cap",()=>{
   const p=executionPolicy("gpt-6-luna",{maxElapsedMs:55000,maxModelCalls:3,maxToolCalls:7,maxInputTokens:72000,maxOutputTokens:1700},false);
   expect(p.maxWorkCalls).toBe(2);
   expect(requestOutputCap(p,0,false,1200)).toBe(1134);
   expect(requestOutputCap(p,900,false,1200)).toBe(234);
   expect(requestOutputCap(p,900,true,1200)).toBe(566);
 });
 it("preserves missing measures and computes non-reasoning output only from verified usage",()=>{
   const base={kind:"responses" as const,requestedModel:"gpt-6-luna",outcome:"completed" as const,final:false,nativeSearch:true,outputCap:8192,durationMs:42};
   expect(providerUsageReceipt(base)).toMatchObject({model:null,inputTokens:null,outputTokens:null,reasoningTokens:null,estimatedCostMicros:null});
   const receipt=providerUsageReceipt({...base,response:{model:"gpt-6-luna",usage:{input_tokens:200,output_tokens:100,input_tokens_details:{cached_tokens:50},output_tokens_details:{reasoning_tokens:25}},output:[{type:"tool_search_call",arguments:{secret:"private"}}]}});
   expect(receipt).toMatchObject({inputTokens:200,cachedTokens:50,outputTokens:100,reasoningTokens:25,nonReasoningTokens:75,discoveryCalls:1});
   expect(JSON.stringify(receipt)).not.toContain("private");
 });
});

it("measures each serialized request component without retaining prompt, schema or evidence contents",()=>{
 const params={instructions:"private instruction",tools:[{name:"private_tool"}],input:[
  {role:"developer",content:"private context"},{role:"user",content:"owner private question"},
  {role:"assistant",content:"previous answer"},{type:"function_call",arguments:"private args"},
  {type:"function_call_output",output:"private evidence"},{type:"reasoning",encrypted_content:"private replay"}]};
 const measured=requestComposition(params)!;
 expect(measured.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(params)));
 expect(measured.schemaBytes).toBe(Buffer.byteLength(JSON.stringify(params.tools)));
 expect(measured.inputBytes).toBe(Buffer.byteLength(JSON.stringify(params.input)));
 for(const key of ["instructionBytes","ownerContextBytes","developerContextBytes","assistantHistoryBytes","toolEvidenceBytes","toolCallBytes","reasoningReplayBytes"] as const)
  expect(measured[key]).toBeGreaterThan(0);
 expect(JSON.stringify(measured)).not.toContain("private");
 params.input.push({type:"function_call_output",output:"additional information"});
 expect(requestComposition(params)!.toolEvidenceBytes).toBeGreaterThan(measured.toolEvidenceBytes);
 expect(requestComposition(params)!.schemaBytes).toBe(measured.schemaBytes);
});
