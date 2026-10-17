import "server-only";
import {z} from "zod";
import {SupervisorStageError} from "@/lib/ai/conversations/diagnostics.server";
import {buildInvestigationRequest,INVESTIGATION_STEP_JSON_SCHEMA} from "@/lib/ai/conversations/investigationRequest.mjs";
import {SUPERVISOR_ENDPOINT} from "@/lib/ai/conversations/supervisorRequest.mjs";
import {INVESTIGATION_LIMITS} from "./protocol";
export type InvestigationTransport=(url:string,init:RequestInit)=>Promise<Response>;
export type InvestigationUsage={model:string;modelCallCount:number;toolCallCount:number;inputTokens:number;outputTokens:number};
export async function requestInvestigation<T>(input:{name:string;schema:z.ZodType<T>;
  instructions:string;context:unknown;model:string;apiKey:string;transport:InvestigationTransport;
  usage:InvestigationUsage;deadline:number;onUsage?:(usage:InvestigationUsage)=>void}):Promise<T|null>{
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
      const response=await input.transport(SUPERVISOR_ENDPOINT,{method:"POST",signal:controller.signal,
        headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
        body:JSON.stringify(buildInvestigationRequest({model:input.usage.model,name:input.name,
          instructions:input.instructions,context:input.context,
          schema:input.name==="supervisor_investigation_step"?INVESTIGATION_STEP_JSON_SCHEMA:
            z.toJSONSchema(input.schema,{unrepresentable:"any",reused:"inline"})})),
      });
      if(!response.ok){
        const fallback=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
        let code="";
        try{const error=await response.json();code=String(error?.error?.code??"");}catch{/* No error body is evidence. */}
        if(input.usage.modelCallCount===1&&fallback&&fallback!==input.usage.model&&
          ["model_not_found","model_not_allowed","model_access_denied"].includes(code)){
          input.usage.model=fallback;
          clearTimeout(timeout);
          return requestInvestigation({...input,model:fallback});
        }
        throw new SupervisorStageError("provider_http","provider_response",{httpStatus:response.status});
      }
      const raw=await response.json();
      const positive=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
      input.usage.inputTokens+=positive(raw.usage?.input_tokens);
      input.usage.outputTokens+=positive(raw.usage?.output_tokens);
      input.onUsage?.({...input.usage});
      if(raw.status!=="completed"||!Array.isArray(raw.output))
        throw new SupervisorStageError("provider_incomplete","provider_response");
      const texts=raw.output.filter((i:{type?:unknown})=>i?.type==="message")
        .flatMap((i:{content?:Array<{type?:unknown;text?:unknown}>})=>i.content??[])
        .filter((p:{type?:unknown;text?:unknown})=>p?.type==="output_text"&&typeof p.text==="string")
        .map((p:{text:string})=>p.text);
      if(texts.length!==1||texts[0].length>18000)
        throw new SupervisorStageError("provider_invalid_payload","provider_response");
      const parsed=input.schema.safeParse(JSON.parse(texts[0]));
      if(!parsed.success)throw new SupervisorStageError("provider_invalid_payload","provider_response");
      return parsed.data;
    })(),expired]);
  }catch(error){
    if(error instanceof SupervisorStageError)throw error;
    throw new SupervisorStageError(controller.signal.aborted?"provider_timeout":"provider_invalid_payload","provider_response");
  }
  finally{clearTimeout(timeout);}
}
