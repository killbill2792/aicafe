#!/usr/bin/env node
/** Paid, explicit provider-contract smoke. Never use customer data or print API response bodies. */
import {SUPERVISOR_ENDPOINT} from "../lib/ai/conversations/supervisorRequest.mjs";
import {buildInvestigationRequest,INVESTIGATION_STEP_JSON_SCHEMA} from "../lib/ai/conversations/investigationRequest.mjs";

if(!process.env.OPENAI_API_KEY){
  console.error("NOT RUN: configure OPENAI_API_KEY securely, then npm run supervisor:provider-smoke");
  process.exit(2);
}
const model=process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna";
const request=buildInvestigationRequest({model,name:"supervisor_investigation_step",
  schema:INVESTIGATION_STEP_JSON_SCHEMA,
  instructions:"You are a café advisor. Return action answer, null capabilityId/argumentsJson and responseJson containing paragraphs [{kind:advice,text,citations:[]}]. Give qualitative general handoff advice, no invented café facts or numerical claims.",
  context:{ownerRequest:"How could a café improve shift handoffs?",locale:"en",observations:[],remainingOperations:0},
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
  const text=(Array.isArray(body.output)?body.output:[]).filter(x=>x?.type==="message")
    .flatMap(x=>x.content??[]).filter(x=>x?.type==="output_text").map(x=>x.text);
  let validAnswer=false;
  try{
    const step=JSON.parse(text[0]);
    const answer=JSON.parse(step.responseJson);
    validAnswer=text.length===1&&step.action==="answer"&&step.capabilityId===null&&step.argumentsJson===null&&
      Array.isArray(answer.paragraphs)&&answer.paragraphs.length>0&&answer.paragraphs.every(p=>
        p.kind==="advice"&&typeof p.text==="string"&&Array.isArray(p.citations)&&p.citations.length===0);
  }catch{/* Invalid output fails without printing the response body. */}
  const usage=body.usage??{};
  const safeToken=n=>Number.isSafeInteger(n)&&n>=0?n:null;
  console.log(JSON.stringify({model,
    httpStatus:response.status,providerStatus:safeStatus,
    protocol:request.text.format.name,validAnswer,
    inputTokens:safeToken(usage.input_tokens),outputTokens:safeToken(usage.output_tokens)}));
  if(safeStatus!=="completed"||!validAnswer)process.exitCode=1;
}catch(e){
  console.error(JSON.stringify({category:e?.name==="TimeoutError"||e?.name==="AbortError"?
    "provider_timeout":"provider_request_failure",model}));
  process.exitCode=1;
}
