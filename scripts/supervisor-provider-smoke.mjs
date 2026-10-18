#!/usr/bin/env node
/** Paid, explicit provider-contract smoke. Never use customer data or print API response bodies. */
import {SUPERVISOR_ENDPOINT} from "../lib/ai/conversations/supervisorRequest.mjs";
import {buildInvestigationRequest} from "../lib/ai/conversations/investigationRequest.mjs";

if(!process.env.OPENAI_API_KEY){
  console.error("NOT RUN: configure OPENAI_API_KEY securely, then npm run supervisor:provider-smoke");
  process.exit(2);
}
const model=process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna";
// Exercises the actual production wire shape: a native function-calling tool
// plus the direct {paragraphs:[...]} answer schema, matching
// lib/ai/supervisor/investigation/model.server.ts exactly. This call is
// instructed to use the tool, so a successful run proves the provider
// accepts our tools payload and returns a real function_call item, not the
// removed action/capabilityId/argumentsJson/responseJson envelope.
const toolName="get_shift_handoff_tips";
const request=buildInvestigationRequest({model,name:"supervisor_investigation_step",
  schema:{type:"object",additionalProperties:false,required:["paragraphs"],
    properties:{paragraphs:{type:"array",items:{type:"object",additionalProperties:false,
      required:["kind","text","citations"],properties:{
        kind:{type:"string",enum:["evidence","advice","clarification"]},
        text:{type:"string"},citations:{type:"array",items:{type:"string"}}}}}}},
  instructions:"You are a café advisor. For a question about improving shift handoffs, call the "+
    toolName+" function with no arguments. Never answer this directly.",
  context:{ownerRequest:"How could a café improve shift handoffs?",locale:"en",observations:[],remainingOperations:1},
  tools:[{name:toolName,description:"Retrieve general shift-handoff improvement tips.",
    parameters:{type:"object",additionalProperties:false,properties:{},required:[]}}],
  // Matches the production per-call cap (lib/ai/supervisor/investigation/model.server.ts)
  // when the turn's full output-token budget is still available.
  maxOutputTokens:6000,
});
try {
  const response=await fetch(SUPERVISOR_ENDPOINT,{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+process.env.OPENAI_API_KEY},
    body:JSON.stringify(request),signal:AbortSignal.timeout(18000),
  });
  if(!response.ok){
    // As in server diagnostics, inspect only bounded error.type / error.code.
    let providerErrorType,providerErrorCode;
    const safeIdentifier=value=>typeof value==="string"&&/^[A-Za-z0-9_.-]+$/.test(value.slice(0,64))
      ?value.slice(0,64):undefined;
    try{
      const payload=await response.json();
      providerErrorType=safeIdentifier(payload?.error?.type);
      providerErrorCode=safeIdentifier(payload?.error?.code);
    }catch{/* Non-JSON HTTP failure: status remains sufficient. */}
    console.error(JSON.stringify({category:"provider_http",model,httpStatus:response.status,
      providerErrorType,providerErrorCode,
      protocol:request.text.format.name}));
    process.exit(1);
  }
  const body=await response.json();
  const safeStatus=["completed","incomplete","failed","queued","in_progress"].includes(body.status)?
    body.status:"unknown";
  const output=Array.isArray(body.output)?body.output:[];
  const functionCalls=output.filter(x=>x?.type==="function_call");
  let validToolCall=false;
  try{
    validToolCall=functionCalls.length===1&&functionCalls[0].name===toolName&&
      typeof functionCalls[0].call_id==="string"&&
      JSON.parse(functionCalls[0].arguments??"")&&typeof functionCalls[0].arguments==="string";
  }catch{/* Invalid tool-call shape fails without printing the response body. */}
  const usage=body.usage??{};
  const safeToken=n=>Number.isSafeInteger(n)&&n>=0?n:null;
  console.log(JSON.stringify({model,
    httpStatus:response.status,providerStatus:safeStatus,
    protocol:request.text.format.name,toolsSent:request.tools?.length??0,validToolCall,
    inputTokens:safeToken(usage.input_tokens),outputTokens:safeToken(usage.output_tokens)}));
  if(safeStatus!=="completed"||!validToolCall)process.exitCode=1;
}catch(e){
  console.error(JSON.stringify({category:e?.name==="TimeoutError"||e?.name==="AbortError"?
    "provider_timeout":"provider_request_failure",model}));
  process.exitCode=1;
}
