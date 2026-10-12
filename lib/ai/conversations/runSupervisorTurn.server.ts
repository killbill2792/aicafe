import "server-only";
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { GroundedSupervisorReply, SupervisorReplyBlock, EvidenceReference } from "./contracts";
import type { ConversationalTurn } from "./context";
import { createSupervisorToolRegistry, intentForCalls, parseSupervisorCalls,
  SUPERVISOR_FUNCTIONS, type ToolEvidence, type SupervisorToolName } from "./toolRegistry.server";
import { HEADLINES, SUMMARIES, SUPERVISOR_ENDPOINT, buildSupervisorInstructions, buildSupervisorRequest } from "./supervisorRequest.mjs";
import { SupervisorStageError, readSafeProviderError, type SupervisorDiagnostic } from "./diagnostics.server";

export type SupervisorUsage = {
  model: string; inputTokens: number; outputTokens: number;
  modelCallCount: number; toolCallCount: number;
};
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const FINAL = z.strictObject({
  headline:z.enum(HEADLINES as [string, ...string[]]),summary:z.enum(SUMMARIES as [string, ...string[]]),
  fact_ids:z.array(z.string().max(80)).max(12),
  task_ids:z.array(z.string().max(200)).max(8),
  insight_ids:z.array(z.string().max(80)).max(12),
  evidence_refs:z.array(z.string().max(160)).max(20),
});
const MAX_ROUNDS = 3, MAX_TOOLS = 5;
const MODEL_ACCESS_CODES = new Set(["model_not_found", "model_access_denied", "model_not_available", "model_not_accessible"]);
const integer = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0 ? x as number : 0;

function textFromResponse(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  const chunks = output.filter(x=>x && typeof x==="object" && x.type==="message")
    .flatMap(x=>Array.isArray(x.content)?x.content:[])
    .filter(x=>x && x.type==="output_text" && typeof x.text==="string")
    .map(x=>x.text);
  return chunks.length === 1 ? chunks[0] : null;
}
export function validateSupervisorFinal(raw: unknown, results: ToolEvidence[], names: SupervisorToolName[],
  locale: "en" | "es" | "ar" = "en"):
    GroundedSupervisorReply {
  const final = FINAL.parse(raw);
  const facts = results.flatMap(r=>r.facts);
  const tasks = results.flatMap(r=>r.tasks);
  const insights = results.flatMap(r=>r.insights);
  const availableRefs = results.flatMap(r=>r.evidence);
  const selectedFacts = final.fact_ids.map(id=>{
    const found = facts.find(f=>f.id===id);
    if (!found) throw new Error("Unverified Supervisor fact reference");
    return found;
  });
  const selectedTasks = final.task_ids.map(id=>{
    const found = tasks.find(t=>t.taskId===id);
    if (!found) throw new Error("Unverified Supervisor task reference");
    return found;
  });
  const selectedInsights=final.insight_ids.map(id=>{
    const found=insights.find(s=>s.id===id);
    if(!found) throw new Error("Unverified Supervisor insight reference");
    return found;
  });
  const refs: EvidenceReference[] = [];
  for (const identifier of final.evidence_refs) {
    const found = availableRefs.find(x=>x.identifier===identifier);
    if (!found) throw new Error("Unverified Supervisor evidence reference");
    refs.push(found);
  }
  for (const r of selectedFacts.map(x=>x.source).concat(selectedTasks.map(x=>x.source),selectedInsights.map(x=>x.source))) refs.push(r);
  const evidence = refs.filter((x,i,arr)=>arr.findIndex(y=>
    y.identifier===x.identifier && y.source===x.source && y.asOf===x.asOf)===i).slice(0,30);
  // Free-form text cannot introduce new amounts, dates, counts or links.
  // All business numbers and navigations must be resolved from this turn's server facts/tasks.
  const statement = [final.headline, final.summary].filter(Boolean).join(". ").slice(0,900);
  if (/[\p{N}$€£¥]|https?:\/\/|\bUSD\b/iu.test(statement)) {
    throw new Error("Supervisor natural-language text included unverified numeric or link content");
  }
  const blocks: SupervisorReplyBlock[] = [];
  if (statement) blocks.push({type:"text",text:statement});
  for (const f of selectedFacts.slice(0,12)) {
    blocks.push(f.kind==="metric"
      ? {type:"metric",label:f.label,valueCents:f.value,source:f.source}
      : {type:"count",label:f.label,value:f.value,source:f.source});
  }
  blocks.push(...selectedTasks.slice(0,8));
  for(const insight of selectedInsights)blocks.push({type:"text",text:insight.text});
  const relevant = results;
  const hasFacts = selectedFacts.length>0 || selectedTasks.length>0 || selectedInsights.length>0 || evidence.length>0;
  const anyPartial = relevant.some(x=>x.status==="partial");
  const anyEstimated = relevant.some(x=>x.status==="estimated");
  const anyMissing = relevant.some(x=>x.status==="unavailable");
  const status = !hasFacts ? "unavailable" : (anyPartial || anyMissing && hasFacts ? "partial"
    : anyEstimated ? "estimated" : "verified");
  const notices = {
    en: { partial: "Some relevant café records are missing, so these are recorded observations, not complete totals.",
      estimated: "Some figures rely on estimated inputs.", unavailable: "These café records are unavailable." },
    es: { partial: "Faltan algunos registros del café; los datos mostrados no son totales completos.",
      estimated: "Algunas cifras incluyen estimaciones.", unavailable: "Estos datos del café no están disponibles." },
    ar: { partial: "بعض سجلات المقهى غير مكتملة؛ الأرقام المعروضة ليست إجماليات كاملة.",
      estimated: "تتضمن بعض الأرقام تقديرات.", unavailable: "هذه السجلات غير متاحة." },
  };
  if (status==="partial" || status==="estimated" || status==="unavailable")
    blocks.push({type:"warning",code:status,text:notices[locale][status]});
  if (blocks.length===0) blocks.push({type:"warning",code:"unavailable",text:"No verified café records available for this answer."});
  const control=results.length===1?results[0].control:null;
  if(control){
    const messages={
      en:{greeting:"Hello. What would you like to know about your café?",
        clarification:"What would you like me to check in your café records?",
        unsupported:"I can help with questions grounded in your café records."},
      es:{greeting:"Hola. ¿Qué te gustaría saber de tu cafetería?",
        clarification:"¿Qué información de tu cafetería quieres consultar?",
        unsupported:"Puedo ayudarte con preguntas basadas en los datos de tu cafetería."},
      ar:{greeting:"مرحباً. ماذا تريد أن تعرف عن المقهى؟",
        clarification:"ما المعلومات التي تريد التحقق منها في سجلات المقهى؟",
        unsupported:"يمكنني مساعدتك في الأسئلة المستندة إلى سجلات المقهى."}
    };
    return {intent:"unknown",status:"unavailable",evidence:[],
      blocks:[{type:"text",text:messages[locale][control]}]};
  }
  if (!results.length) {
    return {intent:"unknown",status:"unavailable",evidence:[],
      blocks:[{type:"text",text:statement || "Could you clarify your question?"}]};
  }
  if (!hasFacts) {
    // Do not present an ungrounded model response as a verified factual conclusion.
    return {intent:intentForCalls(names),status:"unavailable",evidence:[],
      blocks:[{type:"warning",code:"unavailable",
        text:"I could not verify that answer from available café records."}]};
  }
  return {intent:intentForCalls(names),status,evidence,blocks:blocks.slice(0,30)};
}

/** Bounded Responses API multi-tool loop: up to three model rounds, five authorized read tools. */
export async function runSupervisorTurn(input: {
  text: string; locale:"en"|"es"|"ar"; asOf:string; cafeName:string; timezone:string;
  tools: BusinessScopedCafeTools; history: ConversationalTurn[];
  readRules: () => Promise<TeamRule[]>;
  onUsage?: (usage: SupervisorUsage) => void;
  onDiagnostic?: (diagnostic: SupervisorDiagnostic) => void;
}, transport: Transport = fetch): Promise<{reply:GroundedSupervisorReply;usage:SupervisorUsage}> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new SupervisorStageError("provider_invalid_payload","provider_request");
  let model = process.env.SUPERVISOR_OPENAI_MODEL || "gpt-6-luna";
  // No implicit fallback. Only an explicitly configured, different model may be tried.
  const fallbackModel = process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim() || null;
  let fallbackAttempted = false;
  const usage: SupervisorUsage = {model,inputTokens:0,outputTokens:0,modelCallCount:0,toolCallCount:0};
  const registry = createSupervisorToolRegistry(input);
  const toolResults: ToolEvidence[] = [], called: SupervisorToolName[] = [];
  const instructions=buildSupervisorInstructions({locale:input.locale,asOf:input.asOf,timezone:input.timezone});
  const history = input.history.slice(-12).filter(x=>x.text).map(x=>({
    role: x.role==="owner" ? "user" : "assistant", content:x.text.slice(0,850),
  }));
  const conversation: unknown[] = [...history,{role:"user",content:input.text.slice(0,4000)}];
  for (let round=0;round<MAX_ROUNDS;round++) {
    let payload: Record<string,unknown> | null = null;
    for (let attempt=0;attempt<2;attempt++) {
      const roundNumber=round+1, attemptNumber=attempt+1;
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),18_000);
      input.onDiagnostic?.({stage:"provider_request",model,round:roundNumber,attempt:attemptNumber,
        advertisedToolCount:SUPERVISOR_FUNCTIONS.length,
        advertisedToolNames:SUPERVISOR_FUNCTIONS.map(x=>x.name),
        modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
      try {
        let response:Response;
        try {
          response=await transport(SUPERVISOR_ENDPOINT,{
            method:"POST",signal:controller.signal,
            headers:{"content-type":"application/json",authorization:"Bearer "+key},
            body:JSON.stringify(buildSupervisorRequest({model,instructions,input:conversation,round})),
          });
        } catch(error) {
          const timedOut=controller.signal.aborted||(error instanceof Error&&
            (error.name==="AbortError"||error.name==="TimeoutError"));
          throw new SupervisorStageError(timedOut?"provider_timeout":"provider_http",
            "provider_request",{round:roundNumber,attempt:attemptNumber,timeout:timedOut});
        }
        if(!response.ok) {
          const safeProviderError=await readSafeProviderError(response);
          throw new SupervisorStageError("provider_http","provider_response",
            {round:roundNumber,attempt:attemptNumber,httpStatus:response.status,
              ...safeProviderError});
        }
        let body:unknown;
        try {body=await response.json();}
        catch {throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {round:roundNumber,attempt:attemptNumber,httpStatus:response.status});}
        if(!body||typeof body!=="object"||Array.isArray(body))
          throw new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:roundNumber,attempt:attemptNumber,httpStatus:response.status});
        const received=body as Record<string,unknown>;
        // Count all decoded provider usage, including incomplete Responses, BEFORE rejecting.
        usage.modelCallCount++;
        usage.model=typeof received.model==="string"?received.model.slice(0,80):model;
        const used=received.usage as {input_tokens?:unknown;output_tokens?:unknown}|undefined;
        usage.inputTokens+=integer(used?.input_tokens);
        usage.outputTokens+=integer(used?.output_tokens);
        input.onUsage?.({...usage});
        const providerStatus=typeof received.status==="string"?received.status:"unknown";
        input.onDiagnostic?.({stage:"provider_response",model:usage.model,
          httpStatus:response.status,providerStatus,round:roundNumber,attempt:attemptNumber,
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
        if(received.status==="incomplete") throw new SupervisorStageError("provider_incomplete","provider_response",
          {round:roundNumber,attempt:attemptNumber,httpStatus:response.status,providerStatus});
        if(!Array.isArray(received.output)||received.status!=="completed")
          throw new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:roundNumber,attempt:attemptNumber,httpStatus:response.status,providerStatus});
        payload=received;
        break;
      } catch(error) {
        const classified=error instanceof SupervisorStageError?error:
          new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:roundNumber,attempt:attemptNumber});
        input.onDiagnostic?.({stage:classified.stage,category:classified.category,
          model,round:roundNumber,attempt:attemptNumber,httpStatus:classified.httpStatus,
          providerStatus:classified.providerStatus,timeout:classified.timeout,
          providerErrorType:classified.providerErrorType,providerErrorCode:classified.providerErrorCode,
          providerRequestId:classified.providerRequestId,
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
        // Switching is allowed only before any Responses result or tool evidence exists.
        // 403 indicates model/project access; a known model access code is also eligible.
        // Invalid requests (including unsupported_parameter) must surface without fallback.
        const accessFailure = classified.category==="provider_http" && (
          classified.httpStatus===403 ||
          ([400,404].includes(classified.httpStatus??0) &&
            MODEL_ACCESS_CODES.has(classified.providerErrorCode??"")));
        if (accessFailure && round===0 && usage.modelCallCount===0 &&
          usage.toolCallCount===0 && toolResults.length===0 &&
          !fallbackAttempted && fallbackModel && fallbackModel!==model) {
          fallbackAttempted=true;
          input.onDiagnostic?.({stage:"provider_fallback",fromModel:model,toModel:fallbackModel,
            triggerHttpStatus:classified.httpStatus,
            triggerProviderErrorType:classified.providerErrorType,
            triggerProviderErrorCode:classified.providerErrorCode,
            modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
          model=fallbackModel;
          // The first attempt of the selected fallback starts fresh; its own normal
          // bounded retry allowance remains in effect. Never try a third model.
          attempt=-1;
          continue;
        }
        const retry=classified.category==="provider_timeout"||
          classified.category==="provider_incomplete"||
          classified.category==="provider_invalid_payload"||
          (classified.category==="provider_http"&&
            (classified.httpStatus===undefined||
            [408,409,429].includes(classified.httpStatus)||classified.httpStatus>=500));
        if(!retry||attempt===1) throw classified;
      } finally {clearTimeout(timeout);}
    }
    if (!payload) throw new SupervisorStageError("provider_invalid_payload","provider_response",{round:round+1});
    const output = payload.output;
    let calls:ReturnType<typeof parseSupervisorCalls>;
    try {calls=parseSupervisorCalls(output);}
    catch {throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});}
    input.onDiagnostic?.({stage:"tool_call_parse",model,round:round+1,
      modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
    if (round===0 && !calls.length) throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
    if (calls.length) {
      if(calls.some(x=>x.name==="conversation_control") && calls.length!==1)
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      if(round>0 && calls.some(x=>x.name==="conversation_control"))
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      if (round===MAX_ROUNDS-1 || usage.toolCallCount+calls.length>MAX_TOOLS)
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      const duplicates = new Set<string>();
      for (const call of calls) {
        if (duplicates.has(call.call_id)) throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
        duplicates.add(call.call_id);
      }
      // Preserve every Responses output item, including reasoning, and pair each tool output by call_id.
      conversation.push(...(output as unknown[]));
      for (const call of calls) {
        ++usage.toolCallCount;
        input.onDiagnostic?.({stage:"tool_execution",model,round:round+1,
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
        let result:ToolEvidence;
        try {result=await registry(call,usage.toolCallCount);}
        catch {throw new SupervisorStageError("tool_execution","tool_execution",{round:round+1});}
        called.push(call.name);toolResults.push(result);
        const trimmed = JSON.stringify(result);
        if (trimmed.length>14000) throw new SupervisorStageError("tool_execution","tool_execution",{round:round+1});
        conversation.push({type:"function_call_output",call_id:call.call_id,output:trimmed});
      }
      input.onUsage?.({...usage});
      continue;
    }
    const text = textFromResponse(output);
    input.onDiagnostic?.({stage:"final_response_parse",model,round:round+1,
      modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
    if (!text) throw new SupervisorStageError("final_output_missing","final_response_parse",{round:round+1});
    let parsed: unknown;
    try { parsed=JSON.parse(text); } catch { throw new SupervisorStageError("final_output_malformed","final_response_parse",{round:round+1}); }
    input.onDiagnostic?.({stage:"final_response_validation",model,round:round+1,
      modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
    try {return {reply:validateSupervisorFinal(parsed,toolResults,called,input.locale),usage};}
    catch {throw new SupervisorStageError("final_output_validation","final_response_validation",{round:round+1});}
  }
  throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:MAX_ROUNDS});
}
