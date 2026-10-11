#!/usr/bin/env node
/** Paid, explicit provider-contract smoke. Never use customer data or print API response bodies. */
import { SUPERVISOR_ENDPOINT,buildSupervisorRequest,buildSupervisorInstructions } from "../lib/ai/conversations/supervisorRequest.mjs";
import { SUPERVISOR_FUNCTIONS } from "../lib/ai/conversations/supervisorFunctions.mjs";

if(!process.env.OPENAI_API_KEY){
  console.error("NOT RUN: configure OPENAI_API_KEY securely, then npm run supervisor:provider-smoke");
  process.exit(2);
}
const model=process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna";
const instructions=buildSupervisorInstructions({locale:"en",asOf:"2026-10-10",
  timezone:"America/Los_Angeles"});
const request=buildSupervisorRequest({
  model,instructions,round:0,input:[{role:"user",content:"What are my monthly bills?"}],
});
if(request.tools.length!==10||request.tools!==SUPERVISOR_FUNCTIONS)throw Error("Production schema mismatch");
try {
  const response=await fetch(SUPERVISOR_ENDPOINT,{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+process.env.OPENAI_API_KEY},
    body:JSON.stringify(request),signal:AbortSignal.timeout(18000),
  });
  if(!response.ok){
    console.error(JSON.stringify({category:"provider_http",model,httpStatus:response.status,
      advertisedToolCount:request.tools.length,
      advertisedToolNames:request.tools.map(x=>x.name)}));
    process.exit(1);
  }
  const body=await response.json();
  const safeStatus=["completed","incomplete","failed","queued","in_progress"].includes(body.status)?
    body.status:"unknown";
  const allowNames=new Set(SUPERVISOR_FUNCTIONS.map(x=>x.name));
  const names=(Array.isArray(body.output)?body.output:[])
    .filter(x=>x?.type==="function_call"&&allowNames.has(x.name)).map(x=>x.name);
  const usage=body.usage??{};
  const safeToken=n=>Number.isSafeInteger(n)&&n>=0?n:null;
  console.log(JSON.stringify({model,
    httpStatus:response.status,providerStatus:safeStatus,
    advertisedToolCount:request.tools.length,
    selectedToolNames:names,
    inputTokens:safeToken(usage.input_tokens),outputTokens:safeToken(usage.output_tokens)}));
  if(safeStatus!=="completed"||names.length===0)process.exitCode=1;
}catch(e){
  console.error(JSON.stringify({category:e?.name==="TimeoutError"||e?.name==="AbortError"?
    "provider_timeout":"provider_request_failure",model}));
  process.exitCode=1;
}
