import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import "server-only";
import {z} from "zod";
import {modelTokenUsage,estimateModelCallCostMicros,standardModelTokenRates} from "@/lib/calc/supervisorTokenCost";
import {SupervisorStageError,logSupervisorDebugPayload, type SupervisorDiagnostic} from "@/lib/ai/conversations/diagnostics.server";
import {buildInvestigationRequest} from "@/lib/ai/conversations/investigationRequest.mjs";
import {SUPERVISOR_ENDPOINT} from "@/lib/ai/conversations/supervisorRequest.mjs";
import {INVESTIGATION_LIMITS} from "./protocol";
export type InvestigationTransport=(url:string,init:RequestInit)=>Promise<Response>;
export type InvestigationUsage={model:string;modelCallCount:number;toolCallCount:number;inputTokens:number;outputTokens:number};
/** A capability exposed to the model as a real OpenAI function-calling tool,
 * instead of a hand-rolled JSON envelope describing another JSON blob. */
export type ToolDef={name:string;description:string;parameters:unknown};
/** The model requested a registered tool by name/arguments through native
 * function calling, rather than answering directly. */
export type ToolCallSignal={type:"tool_call";name:string;arguments:string;callId:string;
  /** Native multi-call selection. The first call is duplicated in calls[0];
   * this keeps the one-call narrowing contract intact for all review gates. */
  calls?:readonly {name:string;arguments:string;callId:string}[]};
export function isToolCallSignal(v:unknown):v is ToolCallSignal{
  return !!v&&typeof v==="object"&&(v as {type?:unknown}).type==="tool_call"&&
    typeof (v as {name?:unknown}).name==="string"&&
    typeof (v as {arguments?:unknown}).arguments==="string"&&
    typeof (v as {callId?:unknown}).callId==="string";
}
/** OpenAI's structured-output strict mode only supports a limited JSON Schema
 * subset. Length/range/pattern constraints are still enforced by our own zod
 * parse after decoding; stripping them here only avoids a request-build
 * rejection for schemas (like the free-form investigation answer) that carry
 * them, exactly like the server already double-checks every other schema. */
function stripUnsupportedJsonSchemaKeywords(node:unknown):unknown{
  if(Array.isArray(node))return node.map(stripUnsupportedJsonSchemaKeywords);
  if(!node||typeof node!=="object")return node;
  const unsupported=new Set(["minLength","maxLength","pattern","minItems","maxItems",
    "minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","format"]);
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(node as Record<string,unknown>)){
    if(unsupported.has(key))continue;
    out[key]=stripUnsupportedJsonSchemaKeywords(value);
  }
  return out;
}
/** OpenAI's structured-output strict mode also requires EVERY declared
 * property to appear in `required` -- a zod `.optional()`/`.nullish()`
 * field (e.g. a paragraph's `formulas`, present only when there is a
 * freehand claim to verify) is otherwise an outright request-build
 * rejection ("invalid_json_schema") on EVERY call using that schema, not a
 * generation-time problem the model could ever work around (production
 * incident: every real owner question failed this way the moment such a
 * field existed anywhere in answerSchema). Reshapes only the WIRE schema
 * sent to the provider -- our own zod parse of what the model actually
 * returns still decides what is genuinely optional for the rest of this
 * module -- by moving every such property into `required` and allowing it
 * to be explicitly `null` instead, the same transform OpenAI's own SDK
 * helpers apply to a zod/Pydantic optional field for exactly this reason. */
function closeRequiredForStrictMode(node:unknown):unknown{
  if(Array.isArray(node))return node.map(closeRequiredForStrictMode);
  if(!node||typeof node!=="object")return node;
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(node as Record<string,unknown>))
    out[key]=closeRequiredForStrictMode(value);
  if(out.type==="object"&&out.properties&&typeof out.properties==="object"){
    const required=new Set(Array.isArray(out.required)?out.required as string[]:[]);
    const properties:Record<string,unknown>={};
    for(const [key,propertySchema] of Object.entries(out.properties as Record<string,unknown>)){
      properties[key]=required.has(key)?propertySchema:{anyOf:[propertySchema,{type:"null"}]};
      required.add(key);
    }
    out.properties=properties;
    out.required=[...required];
  }
  return out;
}
/** Accept the first complete, schema-valid step even when a provider puts a
 * duplicate answer or trailing commentary inside the SAME output_text part.
 * Checking only complete part-prefixes misses this production failure shape.
 * Never use this on semantic approval/privacy verdicts. */
function recoverFirstStep<T>(rawText:string,schema:z.ZodType<T>):T|undefined{
  const start=rawText.search(/\S/);
  if(start<0||rawText[start]!=="{")return undefined;
  const closers:string[]=[];
  let quoted=false,escaped=false;
  for(let i=start;i<rawText.length;i++){
    const ch=rawText[i];
    if(quoted){
      if(escaped)escaped=false;
      else if(ch==="\\")escaped=true;
      else if(ch==='"')quoted=false;
      continue;
    }
    if(ch==='"'){quoted=true;continue;}
    if(ch==="{"||ch==="["){closers.push(ch==="{"?"}":"]");continue;}
    if(ch==="}"||ch==="]"){
      if(closers.pop()!==ch)return undefined;
      if(closers.length===0){
        let candidate:unknown;
        try{candidate=JSON.parse(rawText.slice(start,i+1));}catch{return undefined;}
        const valid=schema.safeParse(candidate);
        return valid.success?valid.data:undefined;
      }
    }
  }
  return undefined;
}
type RequestInvestigationInput<T>={name:string;schema:z.ZodType<T>;
  instructions:string;context:unknown;reserveModelCalls?:number;
  selectionBudgetDeadline?:boolean;model:string;apiKey:string;transport:InvestigationTransport;
  usage:InvestigationUsage;deadline:number;onUsage?:(usage:InvestigationUsage)=>void;
  onDiagnostic?:(event:SupervisorDiagnostic)=>void;tools?:readonly ToolDef[]};
/** Returns a plain T for every existing (no-`tools`) caller, or a
 * ToolCallSignal when the model used native function calling instead of
 * answering directly. Callers that never pass `tools` can safely narrow the
 * result with `!isToolCallSignal(result)`, since one can never occur there. */
export async function requestInvestigation<T>(input:RequestInvestigationInput<T>,attempt=1):
  Promise<T|ToolCallSignal|null>{
  return requestInvestigationCore(input,attempt);
}
/** Plain (non-overloaded) implementation. Recursive self-calls (retry,
 * model-access fallback) go through this name so overload resolution never
 * has to reconstruct which overload a spread/rebuilt input object matches. */
async function requestInvestigationCore<T>(input:RequestInvestigationInput<T>,attempt=1):
  Promise<T|ToolCallSignal|null>{
  // Nested semantic gates (public-search privacy / calendar clarification) must
  // not spend the final answer and independent review's reserved model attempts.
  // This applies to a gate's own malformed-output retry as well as its first call.
  const maxCalls=INVESTIGATION_LIMITS.modelCalls-
    Math.max(0,Math.min(2,input.reserveModelCalls??0));
  if(input.usage.modelCallCount>=maxCalls||Date.now()>=input.deadline||
    input.usage.outputTokens>=INVESTIGATION_LIMITS.totalOutputTokens)return null;
  input.usage.modelCallCount++;
  const providerCallStartedAt=Date.now();
  input.onUsage?.({...input.usage});
  const controller=new AbortController();
  // Distinguish our shorter, explicit tool-selection reserve from the ordinary
  // per-provider 18s timeout. A genuine provider timeout always propagates.
  const remainingDeadlineMs=input.deadline-Date.now();
  const cappedSelectionExpiry=input.selectionBudgetDeadline===true&&
    remainingDeadlineMs<INVESTIGATION_LIMITS.providerTimeoutMs;
  let expire:()=>void=()=>{};
  const expired=new Promise<never>((_resolve,reject)=>{expire=()=>reject(
    new SupervisorStageError("provider_timeout","provider_response",{
      timeout:true,providerErrorCode:cappedSelectionExpiry?"investigation_selection_deadline":undefined,
    }));});
  const timeout=setTimeout(()=>{controller.abort();expire();},Math.max(1,Math.min(
    INVESTIGATION_LIMITS.providerTimeoutMs,remainingDeadlineMs)));
  try{
    return await Promise.race([(async()=>{
      // Clamp to what remains of the turn's own output-token backstop so one
      // call's max_output_tokens cannot push the turn's total past it.
      const maxOutputTokens=Math.max(500,Math.min(6000,
        INVESTIGATION_LIMITS.totalOutputTokens-input.usage.outputTokens));
      const jsonSchema=closeRequiredForStrictMode(stripUnsupportedJsonSchemaKeywords(
        z.toJSONSchema(input.schema,{unrepresentable:"any",reused:"inline"})));
      const wireRequest=buildInvestigationRequest({model:input.usage.model,name:input.name,
        instructions:input.instructions,context:input.context,maxOutputTokens,schema:jsonSchema,
        tools:input.tools?.map(t=>({name:t.name,description:t.description,
          parameters:closeRequiredForStrictMode(stripUnsupportedJsonSchemaKeywords(t.parameters))}))});
      // Private trace keeps the exact provider request body, never the bearer token.
      logSupervisorDebugPayload({point:"model_request",requestName:input.name,
        attempt,model:input.usage.model,body:wireRequest,
        modelCallCount:input.usage.modelCallCount,maxOutputTokens,
        providerTimeoutMs:Math.max(1,Math.min(INVESTIGATION_LIMITS.providerTimeoutMs,
          remainingDeadlineMs))});
      const response=await input.transport(SUPERVISOR_ENDPOINT,{method:"POST",signal:controller.signal,
        headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
        body:JSON.stringify(wireRequest),
      });
      if(!response.ok){
        const fallback=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
        let code="";
        try{const error=await response.json();code=String(error?.error?.code??"");}catch{/* No error body is evidence. */}
        if(input.usage.modelCallCount===1&&fallback&&fallback!==input.usage.model&&
          ["model_not_found","model_not_allowed","model_access_denied","model_not_available","model_not_accessible"].includes(code)){
          input.usage.model=fallback;
          clearTimeout(timeout);
          return requestInvestigationCore({...input,model:fallback});
        }
        logSupervisorDebugPayload({point:"model_response_error",requestName:input.name,
          attempt,httpStatus:response.status,providerErrorCode:code||null,
          durationMs:Date.now()-providerCallStartedAt,
          modelCallCount:input.usage.modelCallCount,
          providerRequestId:response.headers.get("x-request-id")});
        throw new SupervisorStageError("provider_http","provider_response",
          {httpStatus:response.status,providerErrorCode:code||undefined});
      }
      const raw=await response.json();
      logSupervisorDebugPayload({point:"model_response",requestName:input.name,attempt,
        httpStatus:response.status,raw,durationMs:Date.now()-providerCallStartedAt,
        modelCallCount:input.usage.modelCallCount,
        providerRequestId:response.headers.get("x-request-id")});
      const positive=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
      input.usage.inputTokens+=positive(raw.usage?.input_tokens);
      input.usage.outputTokens+=positive(raw.usage?.output_tokens);
      input.onUsage?.({...input.usage});
      const tokens=modelTokenUsage(raw.usage);
      const providerModel=typeof raw.model==="string"?raw.model:null;
      const actualModel=providerModel??input.usage.model;
      const primary=configuredSupervisorModel();
      const fallback=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
      const prefix=actualModel===primary?"SUPERVISOR_":
        (fallback&&actualModel===fallback?"SUPERVISOR_FALLBACK_":null);
      const configured=prefix?{
        input:process.env[prefix+"INPUT_USD_PER_MILLION_TOKENS"],
        cachedInput:process.env[prefix+"CACHED_INPUT_USD_PER_MILLION_TOKENS"],
        output:process.env[prefix+"OUTPUT_USD_PER_MILLION_TOKENS"],
      }:{input:undefined,cachedInput:undefined,output:undefined};
      const hasConfiguredRate=Object.values(configured).some(v=>v!==undefined);
      const snapshot=tokens&&!hasConfiguredRate?
        standardModelTokenRates(actualModel,raw.service_tier??null,tokens.inputTokens):null;
      const rates=snapshot??configured;
      // Pricing is an estimate from explicit model/tier rates, not the provider invoice.
      const estimatedCostMicros=tokens?estimateModelCallCostMicros(tokens,rates):null;
      logSupervisorDebugPayload({point:"model_usage",requestName:input.name,
        model:actualModel,requestedModel:input.usage.model,
        providerRequestId:response.headers.get("x-request-id"),responseId:raw.id,
        modelCallCount:input.usage.modelCallCount,attempt,status:raw.status,
        serviceTier:raw.service_tier??null,
        usage:tokens??null,rawUsage:raw.usage??null,estimatedCostMicros,
        rateUsdPerMillion:snapshot||hasConfiguredRate?rates:null,
        pricingSource:snapshot?"openai_standard_short_context_2026_10_19":
          hasConfiguredRate?"environment_configured":"unpriced",
        pricingStatus:!tokens?"usage_unavailable":
          estimatedCostMicros===null?"missing_or_mismatched_rate":"configured_estimate",
        durationMs:Date.now()-providerCallStartedAt});
      // "incomplete" (e.g. hit the output-token limit) is a one-time model
      // hiccup worth retrying. Any other non-"completed" status (failed,
      // cancelled, ...) is a terminal provider-side failure, not a retryable
      // output problem, and must propagate like a transport failure.
      if(raw.status==="incomplete")
        throw new SupervisorStageError("provider_incomplete","provider_response");
      if(raw.status!=="completed")
        throw new SupervisorStageError("provider_http","provider_response",
          {providerStatus:typeof raw.status==="string"?raw.status:undefined});
      // One malformed-output turn used to mean one new diagnostic field added to
      // chase the last failure, then a day's wait for the next retry to find out
      // what we still didn't capture. Instead, compute every currently-known-safe
      // signal up front, in one pass, and attach the SAME bundle to whichever
      // branch below actually throws — so the next unseen failure shape already
      // carries full context on its first occurrence. These tags are the OpenAI
      // protocol's own fixed, documented item/part "type" enum values (e.g.
      // "message", "reasoning", "output_text", "refusal"); a parse error's
      // position is a numeric offset; none of this is ever model-generated
      // content, café data or owner text.
      const outputIsArray=Array.isArray(raw.output);
      const outputItems:Array<{type?:unknown;content?:Array<{type?:unknown;text?:unknown}>;
        name?:unknown;arguments?:unknown;call_id?:unknown}>=outputIsArray?raw.output:[];
      // Native function calls are separate typed provider output items. Return
      // all calls together; the dispatcher owns dependency and scope checks.
      if(input.tools&&input.tools.length){
        const functionCalls=outputItems.filter(i=>i?.type==="function_call");
        if(functionCalls.length>INVESTIGATION_LIMITS.operations)
          throw new SupervisorStageError("provider_invalid_payload","provider_response",
            {invalidPayloadReason:"multiple_function_calls",
              outputItemTypes:outputItems.map(i=>i?.type) as string[]});
        if(functionCalls.length){
          if(functionCalls.some(call=>typeof call.name!=="string"||
            typeof call.arguments!=="string"||typeof call.call_id!=="string"))
            throw new SupervisorStageError("provider_invalid_payload","provider_response",
              {invalidPayloadReason:"malformed_function_call",
                outputItemTypes:outputItems.map(i=>i?.type) as string[]});
          const calls=functionCalls.map(call=>({name:call.name as string,
            arguments:call.arguments as string,callId:call.call_id as string}));
          if(new Set(calls.map(call=>call.callId)).size!==calls.length)
            throw new SupervisorStageError("provider_invalid_payload","provider_response",
              {invalidPayloadReason:"malformed_function_call",
                outputItemTypes:outputItems.map(i=>i?.type) as string[]});
          return {type:"tool_call" as const,...calls[0],
            ...(calls.length>1?{calls}: {})};
        }
      }
      const messageParts=outputItems.filter(i=>i?.type==="message").flatMap(i=>i.content??[]);
      const texts=messageParts.filter((p):p is {type:unknown;text:string}=>
        p?.type==="output_text"&&typeof p.text==="string").map(p=>p.text);
      const text=texts.join("");
      let decoded:unknown,jsonErrorPosition:number|undefined,concatenatedTextParses=false;
      if(texts.length>0){
        try{decoded=JSON.parse(text);concatenatedTextParses=true;}
        catch(jsonError){
          const position=jsonError instanceof SyntaxError?/position (\d+)/.exec(jsonError.message):null;
          jsonErrorPosition=position?Number(position[1]):undefined;
        }
      }
      // Distinguishes trailing noise after an already-complete JSON prefix from a
      // document genuinely fragmented mid-token — the two have very different
      // fixes — without ever logging any part's content. Checks EVERY leading
      // prefix of parts, not just the first part alone: valid JSON can span two
      // or more parts before trailing noise begins. validPrefixMatchesSchema
      // additionally confirms the longest valid prefix is a real schema-shaped
      // answer, not merely coincidentally-valid JSON.
      //
      // Production evidence (gathered via these exact fields): about half of
      // unparseable_json failures have a complete, schema-valid answer sitting
      // in a leading prefix, with the provider then emitting trailing noise
      // (observed as a likely repeat/duplicate of its own answer) that breaks
      // the full concatenation. Discarding a verified, schema-valid answer in
      // that case — and forcing a full retry — is strictly worse than just
      // using it, so acceptablePrefix (the longest prefix that is BOTH valid
      // JSON and schema-valid) is accepted below instead of thrown away.
      // ONLY for supervisor_investigation_step, though: that is the sole
      // request whose payload is genuine answer content, and the only one
      // production evidence actually supports leniency for. The other three
      // requests (supervisor_investigation_review, supervisor_
      // calendar_context_review, supervisor_public_query_review) are all
      // semantic verdict/authorization gates — their schema can confirm a
      // prefix's *shape* (e.g. {supported:true,complete:true}) but not that
      // the verdict itself is trustworthy out of a response that was not
      // entirely clean, so they must keep the existing fail-closed behavior.
      let validPrefixPartCount:number|undefined,validPrefixMatchesSchema:boolean|undefined;
      let acceptablePrefix:T|undefined;
      const allowPrefixRecovery=input.name==="supervisor_investigation_step";
      if(texts.length>1){
        validPrefixPartCount=0;
        for(let i=1;i<texts.length;i++){
          let prefix:unknown;
          try{prefix=JSON.parse(texts.slice(0,i).join(""));}
          catch{continue;/* this prefix length is not valid JSON; a longer one still might be */}
          validPrefixPartCount=i;
          const prefixParsed=input.schema.safeParse(prefix);
          validPrefixMatchesSchema=prefixParsed.success;
          if(prefixParsed.success)acceptablePrefix=prefixParsed.data;
        }
      }
      const shapeMeta={outputItemTypes:outputItems.map(i=>i?.type) as string[],
        messagePartTypes:messageParts.map(p=>p?.type) as string[],
        outputTextPartCount:texts.length,jsonTextLength:text.length,
        jsonErrorPosition,validPrefixPartCount,validPrefixMatchesSchema};
      if(!outputIsArray||texts.length===0||text.length>18000)
        throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {invalidPayloadReason:"wrong_text_shape",...shapeMeta});
      if(!concatenatedTextParses){
        // Real provider responses also duplicate an entire JSON step inside a
        // single output_text part (the part-boundary prefix scan misses it).
        // Recovery is only for requested investigative steps, never reviews.
        if(allowPrefixRecovery&&acceptablePrefix===undefined)
          acceptablePrefix=recoverFirstStep(text,input.schema);
        if(allowPrefixRecovery&&acceptablePrefix!==undefined){
          // Not an error: record it for observability (no category — this
          // path never retries or degrades the turn), then use the answer.
          input.onDiagnostic?.({stage:"provider_response",requestName:input.name,...shapeMeta,
            attempt,modelCallCount:input.usage.modelCallCount});
          return acceptablePrefix;
        }
        throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {invalidPayloadReason:"unparseable_json",...shapeMeta});
      }
      const parsed=input.schema.safeParse(decoded);
      if(!parsed.success){
        const issue=parsed.error.issues[0];
        throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {invalidPayloadReason:"schema_mismatch",...shapeMeta,
            schemaIssuePath:issue?.path.join(".")||undefined,schemaIssueCode:issue?.code,
            schemaIssueCount:parsed.error.issues.length});
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
    logSupervisorDebugPayload({point:"model_attempt_failed",requestName:input.name,attempt,
      category:classified.category,durationMs:Date.now()-providerCallStartedAt,
      httpStatus:classified.httpStatus,providerStatus:classified.providerStatus,
      providerErrorCode:classified.providerErrorCode,
      modelCallCount:input.usage.modelCallCount});
    input.onDiagnostic?.({stage:"provider_response",category:classified.category,
      httpStatus:classified.httpStatus,providerStatus:classified.providerStatus,
      providerErrorCode:classified.providerErrorCode,requestName:input.name,
      invalidPayloadReason:classified.invalidPayloadReason,
      schemaIssuePath:classified.schemaIssuePath,schemaIssueCode:classified.schemaIssueCode,
      schemaIssueCount:classified.schemaIssueCount,
      outputItemTypes:classified.outputItemTypes,messagePartTypes:classified.messagePartTypes,
      outputTextPartCount:classified.outputTextPartCount,
      jsonTextLength:classified.jsonTextLength,jsonErrorPosition:classified.jsonErrorPosition,
      validPrefixPartCount:classified.validPrefixPartCount,
      validPrefixMatchesSchema:classified.validPrefixMatchesSchema,
      attempt,modelCallCount:input.usage.modelCallCount});
    // The model producing malformed JSON or an incomplete turn is a one-time
    // hiccup in its own output, not an infrastructure failure. Give it exactly
    // one more try with the same inputs before giving up; a persistent failure
    // degrades to a graceful "unavailable" reply (handled by every call site's
    // existing null-check) instead of crashing the whole owner turn.
    if(classified.category==="provider_invalid_payload"||classified.category==="provider_incomplete"){
      if(attempt<2)return requestInvestigationCore(input,attempt+1);
      return null;
    }
    throw classified;
  }
  finally{clearTimeout(timeout);}
}
