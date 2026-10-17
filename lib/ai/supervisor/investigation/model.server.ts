import "server-only";
import {z} from "zod";
import {SupervisorStageError, type SupervisorDiagnostic} from "@/lib/ai/conversations/diagnostics.server";
import {buildInvestigationRequest,INVESTIGATION_STEP_JSON_SCHEMA} from "@/lib/ai/conversations/investigationRequest.mjs";
import {SUPERVISOR_ENDPOINT} from "@/lib/ai/conversations/supervisorRequest.mjs";
import {INVESTIGATION_LIMITS} from "./protocol";
export type InvestigationTransport=(url:string,init:RequestInit)=>Promise<Response>;
export type InvestigationUsage={model:string;modelCallCount:number;toolCallCount:number;inputTokens:number;outputTokens:number};
export async function requestInvestigation<T>(input:{name:string;schema:z.ZodType<T>;
  instructions:string;context:unknown;model:string;apiKey:string;transport:InvestigationTransport;
  usage:InvestigationUsage;deadline:number;onUsage?:(usage:InvestigationUsage)=>void;
  onDiagnostic?:(event:SupervisorDiagnostic)=>void},attempt=1):Promise<T|null>{
  if(input.usage.modelCallCount>=INVESTIGATION_LIMITS.modelCalls||Date.now()>=input.deadline||
    input.usage.outputTokens>=INVESTIGATION_LIMITS.totalOutputTokens)return null;
  input.usage.modelCallCount++;
  input.onUsage?.({...input.usage});
  const controller=new AbortController();
  let expire:()=>void=()=>{};
  const expired=new Promise<never>((_resolve,reject)=>{expire=()=>reject(
    new SupervisorStageError("provider_timeout","provider_response",{timeout:true}));});
  const timeout=setTimeout(()=>{controller.abort();expire();},Math.max(1,Math.min(
    INVESTIGATION_LIMITS.providerTimeoutMs,input.deadline-Date.now())));
  try{
    return await Promise.race([(async()=>{
      // Clamp to what remains of the turn's own output-token backstop so one
      // call's max_output_tokens cannot push the turn's total past it.
      const maxOutputTokens=Math.max(500,Math.min(6000,
        INVESTIGATION_LIMITS.totalOutputTokens-input.usage.outputTokens));
      const response=await input.transport(SUPERVISOR_ENDPOINT,{method:"POST",signal:controller.signal,
        headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
        body:JSON.stringify(buildInvestigationRequest({model:input.usage.model,name:input.name,
          instructions:input.instructions,context:input.context,maxOutputTokens,
          schema:input.name==="supervisor_investigation_step"?INVESTIGATION_STEP_JSON_SCHEMA:
            z.toJSONSchema(input.schema,{unrepresentable:"any",reused:"inline"})})),
      });
      if(!response.ok){
        const fallback=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
        let code="";
        try{const error=await response.json();code=String(error?.error?.code??"");}catch{/* No error body is evidence. */}
        if(input.usage.modelCallCount===1&&fallback&&fallback!==input.usage.model&&
          ["model_not_found","model_not_allowed","model_access_denied","model_not_available","model_not_accessible"].includes(code)){
          input.usage.model=fallback;
          clearTimeout(timeout);
          return requestInvestigation({...input,model:fallback});
        }
        throw new SupervisorStageError("provider_http","provider_response",
          {httpStatus:response.status,providerErrorCode:code||undefined});
      }
      const raw=await response.json();
      const positive=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
      input.usage.inputTokens+=positive(raw.usage?.input_tokens);
      input.usage.outputTokens+=positive(raw.usage?.output_tokens);
      input.onUsage?.({...input.usage});
      // "incomplete" (e.g. hit the output-token limit) is a one-time model
      // hiccup worth retrying. Any other non-"completed" status (failed,
      // cancelled, ...) is a terminal provider-side failure, not a retryable
      // output problem, and must propagate like a transport failure.
      if(raw.status==="incomplete")
        throw new SupervisorStageError("provider_incomplete","provider_response");
      if(raw.status!=="completed")
        throw new SupervisorStageError("provider_http","provider_response",
          {providerStatus:typeof raw.status==="string"?raw.status:undefined});
      // Production evidence (the sub-classification tags added alongside this
      // comment previously) showed a "message" item with one or more genuine
      // "output_text" parts every time: the provider legitimately splits a long
      // JSON answer across multiple output_text parts in the same message, which
      // is valid Responses API shape, not malformed output. Concatenate them in
      // order rather than requiring exactly one. These tags are the OpenAI
      // protocol's own fixed, documented item/part "type" enum values (e.g.
      // "message", "reasoning", "output_text", "refusal"); never model-generated
      // content, café data or owner text, so recording them (bounded, deduped)
      // is safe and is what pinpointed this exact shape without reading the payload.
      const outputIsArray=Array.isArray(raw.output);
      const outputItems:Array<{type?:unknown;content?:Array<{type?:unknown;text?:unknown}>}>=
        outputIsArray?raw.output:[];
      const messageParts=outputItems.filter(i=>i?.type==="message").flatMap(i=>i.content??[]);
      const texts=messageParts.filter((p):p is {type:unknown;text:string}=>
        p?.type==="output_text"&&typeof p.text==="string").map(p=>p.text);
      const text=texts.join("");
      if(!outputIsArray||texts.length===0||text.length>18000)
        throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {invalidPayloadReason:"wrong_text_shape",
            outputItemTypes:outputItems.map(i=>i?.type) as string[],
            messagePartTypes:messageParts.map(p=>p?.type) as string[],
            outputTextPartCount:texts.length});
      let decoded:unknown;
      try{decoded=JSON.parse(text);}
      catch{throw new SupervisorStageError("provider_invalid_payload","provider_response",
        {invalidPayloadReason:"unparseable_json"});}
      const parsed=input.schema.safeParse(decoded);
      if(!parsed.success){
        const issue=parsed.error.issues[0];
        throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {invalidPayloadReason:"schema_mismatch",
            schemaIssuePath:issue?.path.join(".")||undefined,schemaIssueCode:issue?.code});
      }
      return parsed.data;
    })(),expired]);
  }catch(error){
    // Only a SupervisorStageError thrown above, after a response was actually
    // received and inspected, is evidence of malformed/incomplete MODEL output.
    // A raw error here (DNS failure, connection reset, a rejected fetch) never
    // reached that inspection and must stay a transport failure, not be treated
    // as a lenient, retryable model hiccup.
    const classified=error instanceof SupervisorStageError?error:
      new SupervisorStageError(controller.signal.aborted?"provider_timeout":"provider_http","provider_response");
    // This is the only visibility production has into why an investigation
    // step failed; without it, a failure here is otherwise completely silent
    // between "cafe_identity_loaded" and "reply_persistence" in the logs.
    input.onDiagnostic?.({stage:"provider_response",category:classified.category,
      httpStatus:classified.httpStatus,providerStatus:classified.providerStatus,
      providerErrorCode:classified.providerErrorCode,requestName:input.name,
      invalidPayloadReason:classified.invalidPayloadReason,
      schemaIssuePath:classified.schemaIssuePath,schemaIssueCode:classified.schemaIssueCode,
      outputItemTypes:classified.outputItemTypes,messagePartTypes:classified.messagePartTypes,
      outputTextPartCount:classified.outputTextPartCount,
      attempt,modelCallCount:input.usage.modelCallCount});
    // The model producing malformed JSON or an incomplete turn is a one-time
    // hiccup in its own output, not an infrastructure failure. Give it exactly
    // one more try with the same inputs before giving up; a persistent failure
    // degrades to a graceful "unavailable" reply (handled by every call site's
    // existing null-check) instead of crashing the whole owner turn.
    if(classified.category==="provider_invalid_payload"||classified.category==="provider_incomplete"){
      if(attempt<2)return requestInvestigation(input,attempt+1);
      return null;
    }
    throw classified;
  }
  finally{clearTimeout(timeout);}
}
