import "server-only";
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { GroundedSupervisorReply, SupervisorReplyBlock, EvidenceReference } from "./contracts";
import type { ConversationalTurn } from "./context";
import { createSupervisorToolRegistry, intentForCalls, parseSupervisorCalls,
  SUPERVISOR_FUNCTIONS, type ToolEvidence, type SupervisorToolName } from "./toolRegistry.server";
import { HEADLINES, SUMMARIES, SUPERVISOR_ENDPOINT, buildSupervisorInstructions, buildSupervisorRequest, buildSupervisorScopeAuditRequest } from "./supervisorRequest.mjs";
import { SupervisorStageError, readSafeProviderError, type SupervisorDiagnostic } from "./diagnostics.server";
import { requestScopeSchema, scopeAuditSchema, normalizeRequestedGoals, reconcileRequestScopesDetailed,
  coversRequestedGoal, fallbackCallForGoal, goalLabel, unavailableGoalText,
  type RequestedGoal } from "./requestScope";
import type { SupervisorToolCall } from "./toolRegistry.server";

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
  locale: "en" | "es" | "ar" = "en", goals: RequestedGoal[] = [],
  executed: SupervisorToolCall[] = []):
    GroundedSupervisorReply {
  const final = FINAL.parse(raw);
  goals = normalizeRequestedGoals(goals);
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
  // Fixed connective phrases remain strictly validated but never lead grounded
  // business answers. Display only facts, task cards and trusted insights.
  const blocks: SupervisorReplyBlock[] = [];
  const labels = {
    en:{month_to_date:"month to date",today:"today",yesterday:"yesterday",week_to_date:"week to date",
      previous_week:"last week",previous_month:"last month",last_7_days:"last 7 days",
      last_28_days:"last 28 days",custom:"selected period",
      pricingStart:"Price review",zero:"No price changes are currently verified.",
      reviews:"products have verified recommendations to review.",
      kept:"products were fully evaluated and do not currently need a price change.",
      newPrice:"products have first-price recommendations, not revisions to an existing price.",
      blocked:"still need complete cost/pricing data before their prices can be verified.",
      staffCoverage:"Staff time records are incomplete for the selected period.",
      costCoverage:"Total-cost records are incomplete for the selected period."},
    es:{month_to_date:"en lo que va del mes",today:"hoy",yesterday:"ayer",week_to_date:"en lo que va de la semana",
      previous_week:"la semana pasada",previous_month:"el mes pasado",last_7_days:"últimos 7 días",
      last_28_days:"últimos 28 días",custom:"período seleccionado",
      pricingStart:"Revisión de precios",zero:"No hay cambios de precio verificados actualmente.",
      reviews:"productos tienen recomendaciones de precios verificadas para revisar.",
      kept:"productos se evaluaron por completo y no necesitan cambios de precio por ahora.",
      newPrice:"productos tienen un precio inicial recomendado, no un cambio de precio existente.",
      blocked:"aún necesitan datos completos de costos y precios para su verificación.",
      staffCoverage:"Los registros de horas del personal están incompletos para el período seleccionado.",
      costCoverage:"Los registros de costos totales están incompletos para el período seleccionado."},
    ar:{month_to_date:"من بداية الشهر حتى الآن",today:"اليوم",yesterday:"أمس",week_to_date:"من بداية الأسبوع حتى الآن",
      previous_week:"الأسبوع الماضي",previous_month:"الشهر الماضي",last_7_days:"آخر ٧ أيام",
      last_28_days:"آخر ٢٨ يومًا",custom:"الفترة المحددة",
      pricingStart:"مراجعة الأسعار",zero:"لا توجد تغييرات أسعار مثبتة حاليًا.",
      reviews:"منتجات لديها توصيات أسعار مثبتة للمراجعة.",
      kept:"منتجات خضعت لتقييم كامل ولا تحتاج إلى تغيير السعر حاليًا.",
      newPrice:"منتجات لديها توصيات بسعر أولي وليست تغييرات لأسعار موجودة.",
      blocked:"لا تزال تحتاج إلى بيانات تكاليف وأسعار مكتملة للتحقق من أسعارها.",
      staffCoverage:"سجلات ساعات الموظفين غير مكتملة للفترة المحددة.",
      costCoverage:"سجلات التكاليف الإجمالية غير مكتملة للفترة المحددة."},
  }[locale];
  // Evidence selection by the model is optional for coverage, but evidence itself is not.
  // Every semantic request-scope goal produces one trusted fact or a specific unavailable line.
  const chosen:typeof facts=[];
  const supplementalTexts:string[]=[];
  const represented=new Set<string>();
  let specificWarning=false;
  let missingGoal=false;
  for(const goal of goals){
    const index=executed.findIndex(c=>coversRequestedGoal(goal,c));
    const result=index>=0 ? results[index] : undefined;
    const suffixByDomain:Partial<Record<RequestedGoal["domain"],string[]>>={
      total_business_costs:[":value"],staff_cost:[":labor"],menu_count:[":active",":count"],
      pricing_review:[":pricingCount"],owner_profit:[":value"],monthly_bills:[":bills"],
      recorded_spending:[":spent"],distinct_products:[":distinct"],team:[":needsYou"],
    };
    const primary=result?.facts.find(f=>(suffixByDomain[goal.domain]??[]).some(s=>f.id.endsWith(s)))
      ?? result?.facts.find(f=>selectedFacts.some(selected=>selected.id===f.id))
      ?? result?.facts[0];
    if(!result || (result.status==="unavailable" && !primary) || !primary && !result.insights.length && !result.tasks.length){
      supplementalTexts.push(unavailableGoalText(goal.domain,locale));
      specificWarning=true;missingGoal=true;
      continue;
    }
    if(primary){
      const heading=goalLabel(goal.domain,locale);
      const suffix=goal.domain==="total_business_costs"||goal.domain==="staff_cost"
        ? " — "+labels[goal.period] : "";
      const primaryLabel=suffixByDomain[goal.domain] ? heading+suffix : primary.label;
      chosen.push({...primary,label:primaryLabel});represented.add(primary.id);
    } else if(result.insights.length){
      supplementalTexts.push(goalLabel(goal.domain,locale)+": "+result.insights[0].text);
    }
    if(goal.domain==="team"&&result.status!=="unavailable"){
      const filter=(result.data as {filterStatus?:unknown}|null)?.filterStatus;
      if((filter==="all"||filter==="needs_you") &&
        !result.tasks.some(t=>t.status==="needs_owner"||t.status==="needs_response")){
        supplementalTexts.push({
          en:"No AI Team tasks currently need your attention.",
          es:"Actualmente no hay tareas del equipo de IA que requieran tu atención.",
          ar:"لا توجد حاليًا مهام لفريق الذكاء الاصطناعي تحتاج إلى اهتمامك.",
        }[locale]);
      }
    }
    if(goal.domain==="pricing_review"){
      const data=result.data as Record<string,unknown>|null;
      const n=(key:string)=>data && Number.isSafeInteger(data[key]) && (data[key] as number)>=0
        ? data[key] as number : null;
      const examined=n("examined"),blocked=n("blocked"),keep=n("noChange"),reviews=n("reviewReady"),
        newPrice=n("newPrice");
      if(examined!==null && blocked!==null && keep!==null && reviews!==null){
        const explanations:string[]=[];
        if(reviews===0)explanations.push(labels.zero);
        else explanations.push(reviews+" "+labels.reviews);
        if(keep>0)explanations.push(keep+" "+labels.kept);
        if(newPrice!==null && newPrice>0)explanations.push(newPrice+" "+labels.newPrice);
        if(blocked>0)explanations.push(blocked+" / "+examined+" "+labels.blocked);
        supplementalTexts.push(labels.pricingStart+": "+explanations.join(" "));
        if(blocked>0)specificWarning=true;
      }
    }
    if(goal.domain==="staff_cost" && result.status==="partial"){
      supplementalTexts.push(labels.staffCoverage);specificWarning=true;
    }
    if(goal.domain==="total_business_costs" && result.status==="partial"){
      supplementalTexts.push(labels.costCoverage);specificWarning=true;
    }
  }
  // Single-domain detailed answers retain the model's chosen additional facts. For
  // multi-domain responses, use one primary fact per goal rather than a nested dashboard.
  for(const f of chosen){
    if(!evidence.some(e=>e.identifier===f.source.identifier &&
      e.source===f.source.source && e.asOf===f.source.asOf))evidence.push(f.source);
  }
  const suffixByDomainForMulti=(goalsToCheck:RequestedGoal[],call:SupervisorToolCall)=>
    goalsToCheck.some(g=>["total_business_costs","staff_cost","menu_count","pricing_review"].includes(g.domain)
      && coversRequestedGoal(g,call));
  const allowable=new Set(executed.flatMap((call,i)=>goals.some(g=>coversRequestedGoal(g,call))
    ? results[i]?.facts.map(f=>f.id)??[] : []));
  const extraFacts = selectedFacts.filter(f=>!represented.has(f.id) &&
    (!goals.length || allowable.has(f.id)) &&
    (goals.length<2 || !executed.some((c,i)=>goals.some(g=>coversRequestedGoal(g,c)) &&
      suffixByDomainForMulti(goals,c) &&
      results[i]?.facts.some(x=>x.id===f.id))));
  for(const f of [...chosen,...extraFacts].slice(0,12)){
    blocks.push(f.kind==="metric"
      ? {type:"metric",label:f.label,valueCents:f.value,source:f.source}
      : {type:"count",label:f.label,value:f.value,source:f.source});
  }
  // The model cannot suppress trusted persisted task cards from Team or Overview.
  const deterministicTasks=executed.flatMap((call,i)=>{
    if(call.name==="get_cafe_overview")return results[i]?.tasks.slice(0,3)??[];
    if(call.name==="get_team"&&goals.some(g=>coversRequestedGoal(g,call))){
      const result=results[i],filter=(result?.data as {filterStatus?:unknown}|null)?.filterStatus;
      return (result?.tasks??[]).filter(t=>filter==="all"||filter==="needs_you"?
        t.status==="needs_owner"||t.status==="needs_response":true).slice(0,5);
    }
    return [];
  });
  const shownTasks=[...deterministicTasks,...selectedTasks].filter((t,i,arr)=>
    arr.findIndex(x=>x.taskId===t.taskId)===i).slice(0,8);
  for(const task of shownTasks){
    if(!evidence.some(e=>e.identifier===task.source.identifier&&
      e.source===task.source.source&&e.asOf===task.source.asOf))evidence.push(task.source);
  }
  blocks.push(...shownTasks);
  const pricingGoals=goals.some(g=>g.domain==="pricing_review");
  for(const insight of selectedInsights){
    // Specific pricing statement from canonical counts supersedes generic English
    // pricing snippets; never duplicate them or leak English into ES/AR.
    if(pricingGoals && insight.id.includes("pricing"))continue;
    blocks.push({type:"text",text:insight.text});
  }
  for(const text of supplementalTexts)blocks.push({type:"text",text});
  const hasFacts = blocks.length>0;
  const trusted = chosen.length>0 || extraFacts.length>0 || shownTasks.length>0 ||
    selectedInsights.length>0 || blocks.some(b=>b.type==="text" && !supplementalTexts.includes(b.text));
  const anyPartial=results.some(x=>x.status==="partial");
  const anyEstimated=results.some(x=>x.status==="estimated");
  const anyMissing=results.some(x=>x.status==="unavailable");
  const status: GroundedSupervisorReply["status"] = !trusted ? "unavailable"
    : (anyPartial || anyMissing || missingGoal
      ? "partial" : anyEstimated ? "estimated" : "verified");
  const notices={
    en:{partial:"Some relevant café records are missing, so these are recorded observations, not complete totals.",
      estimated:"Some figures rely on estimated inputs.",unavailable:"These café records are unavailable."},
    es:{partial:"Faltan algunos registros del café; los datos mostrados no son totales completos.",
      estimated:"Algunas cifras incluyen estimaciones.",unavailable:"Estos datos del café no están disponibles."},
    ar:{partial:"بعض سجلات المقهى غير مكتملة؛ الأرقام المعروضة ليست إجماليات كاملة.",
      estimated:"تتضمن بعض الأرقام تقديرات.",unavailable:"هذه السجلات غير متاحة."},
  };
  if((status==="partial" || status==="estimated" || status==="unavailable") && !specificWarning)
    blocks.push({type:"warning",code:status,text:notices[locale][status]});
  if(blocks.length===0)blocks.push({type:"warning",code:"unavailable",
    text:"No verified café records available for this answer."});
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
  const executed: SupervisorToolCall[] = [];
  let requestedGoals: RequestedGoal[] | null = null;
  const instructions=buildSupervisorInstructions({locale:input.locale,asOf:input.asOf,timezone:input.timezone});
  const history = input.history.slice(-12).filter(x=>x.text).map(x=>({
    role: x.role==="owner" ? "user" : "assistant", content:x.text.slice(0,850),
  }));
  const conversation: unknown[] = [...history,{role:"user",content:input.text.slice(0,4000)}];
  // A separate, bounded read of the original owner utterance using the SAME
  // configured model. No café tools, prior scope, history or business records are
  // included. The original tool loop never sees a redeclaration.
  async function auditFirstScope(declared: RequestedGoal[]): Promise<RequestedGoal[] | null> {
    // One semantic audit with the same model and at most two transport attempts.
    // Never fall back here: the first model response has already succeeded.
    const request=JSON.stringify(buildSupervisorScopeAuditRequest({
      model,text:input.text,locale:input.locale,asOf:input.asOf,timezone:input.timezone,
    }));
    for(let attempt=0;attempt<2;attempt++){
      const attemptNumber=attempt+1,controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),18_000);
      input.onDiagnostic?.({stage:"provider_request",model,round:1,attempt:attemptNumber,
        advertisedToolCount:0,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
      try{
        let response:Response;
        try{
          response=await transport(SUPERVISOR_ENDPOINT,{
            method:"POST",signal:controller.signal,
            headers:{"content-type":"application/json",authorization:"Bearer "+key},
            body:request,
          });
        }catch(error){
          const timedOut=controller.signal.aborted||(error instanceof Error&&
            (error.name==="AbortError"||error.name==="TimeoutError"));
          throw new SupervisorStageError(timedOut?"provider_timeout":"provider_http",
            "provider_request",{round:1,attempt:attemptNumber,timeout:timedOut});
        }
        if(!response.ok){
          const safeProviderError=await readSafeProviderError(response);
          throw new SupervisorStageError("provider_http","provider_response",
            {round:1,attempt:attemptNumber,httpStatus:response.status,...safeProviderError});
        }
        let decoded:unknown;
        try{decoded=await response.json();}
        catch{throw new SupervisorStageError("provider_invalid_payload","provider_response",
          {round:1,attempt:attemptNumber,httpStatus:response.status});}
        if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))
          throw new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:1,attempt:attemptNumber,httpStatus:response.status});
        const payload=decoded as Record<string,unknown>;
        // As in the normal tool loop, count every decoded provider response,
        // including incomplete results that cause a single bounded retry.
        usage.modelCallCount++;
        usage.model=typeof payload.model==="string"?payload.model.slice(0,80):model;
        const billed=payload.usage as {input_tokens?:unknown;output_tokens?:unknown}|undefined;
        usage.inputTokens+=integer(billed?.input_tokens);
        usage.outputTokens+=integer(billed?.output_tokens);
        input.onUsage?.({...usage});
        const providerStatus=typeof payload.status==="string"?payload.status:"unknown";
        input.onDiagnostic?.({stage:"provider_response",model:usage.model,round:1,attempt:attemptNumber,
          httpStatus:response.status,providerStatus,modelCallCount:usage.modelCallCount,
          toolCallCount:usage.toolCallCount});
        if(payload.status==="incomplete")throw new SupervisorStageError("provider_incomplete",
          "provider_response",{round:1,attempt:attemptNumber,httpStatus:response.status,providerStatus});
        if(payload.status!=="completed"||!Array.isArray(payload.output))
          throw new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:1,attempt:attemptNumber,httpStatus:response.status,providerStatus});
        const text=textFromResponse(payload.output);
        let verified:ReturnType<typeof scopeAuditSchema.parse>|null=null;
        if(text){
          try{verified=scopeAuditSchema.parse(JSON.parse(text));}
          catch{/* Invalid scope audit payload is not evidence; never emit raw text. */}
        }
        if(!verified){
          input.onDiagnostic?.({stage:"scope_reconciliation",model,round:1,
            declaredGoalDomains:declared.map(g=>g.domain),auditedGoalDomains:[],
            normalizedGoalDomains:declared.map(g=>g.domain),
            scopeAuditComplete:false,scopeAuditAmbiguous:false,
            reconciliationOutcome:"audit_incomplete"});
          return null;
        }
        const reconciled=reconcileRequestScopesDetailed(declared,verified.goals,
          verified.complete,verified.ambiguous);
        // Only static domain enum values, booleans and a bounded outcome enum.
        // Never emit the owner utterance, provider output or café/task evidence.
        input.onDiagnostic?.({stage:"scope_reconciliation",model,round:1,
          declaredGoalDomains:reconciled.declaredDomains,
          auditedGoalDomains:reconciled.auditedDomains,
          normalizedGoalDomains:reconciled.normalizedDomains,
          scopeAuditComplete:verified.complete,scopeAuditAmbiguous:verified.ambiguous,
          reconciliationOutcome:reconciled.outcome});
        return reconciled.goals;
      }catch(error){
        const classified=error instanceof SupervisorStageError?error:
          new SupervisorStageError("provider_invalid_payload","provider_response",
            {round:1,attempt:attemptNumber});
        input.onDiagnostic?.({stage:classified.stage,category:classified.category,
          model,round:1,attempt:attemptNumber,httpStatus:classified.httpStatus,
          providerStatus:classified.providerStatus,timeout:classified.timeout,
          providerErrorType:classified.providerErrorType,providerErrorCode:classified.providerErrorCode,
          providerRequestId:classified.providerRequestId,modelCallCount:usage.modelCallCount,
          toolCallCount:usage.toolCallCount});
        // Same transient classification as the established main transport.
        // No access fallback here, because the primary model already answered.
        const retry=classified.category==="provider_timeout"||
          classified.category==="provider_incomplete"||
          classified.category==="provider_invalid_payload"||
          (classified.category==="provider_http"&&
            (classified.httpStatus===undefined||
            [408,409,429].includes(classified.httpStatus)||classified.httpStatus>=500));
        if(!retry||attempt===1)throw classified;
      }finally{clearTimeout(timeout);}
    }
    throw new SupervisorStageError("provider_invalid_payload","provider_response",{round:1});
  }
  const clarification={
    en:"I couldn't reliably identify every part of that question. Please ask the parts separately so nothing is missed.",
    es:"No pude identificar con seguridad todas las partes de la pregunta. Consulta cada parte por separado para que no falte ninguna.",
    ar:"لم أتمكن من تحديد جميع أجزاء السؤال بثقة. يُرجى طرح كل جزء على حدة حتى لا يفوتني شيء.",
  }[input.locale];

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
      const declarations=calls.filter(x=>x.name==="declare_request_scope");
      const reads=calls.filter(x=>x.name!=="declare_request_scope");
      if(declarations.length>1 || (round!==0 && declarations.length) ||
        (round===0 && reads.some(x=>x.name!=="conversation_control") && declarations.length!==1) ||
        (declarations.length>0 && reads.some(x=>x.name==="conversation_control")))
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      if (reads.some(x=>x.name==="conversation_control") && reads.length!==1)
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      if(round>0 && reads.some(x=>x.name==="conversation_control"))
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      if (round===MAX_ROUNDS-1 || usage.toolCallCount+reads.length>MAX_TOOLS)
        throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
      const duplicates = new Set<string>();
      for (const call of calls) {
        if (duplicates.has(call.call_id)) throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});
        duplicates.add(call.call_id);
      }
      conversation.push(...(output as unknown[]));
      if(declarations.length){
        let firstScope:RequestedGoal[];
        try{firstScope=requestScopeSchema.parse(declarations[0].arguments).goals;}
        catch{throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:round+1});}
        const audited=await auditFirstScope(normalizeRequestedGoals(firstScope));
        if(!audited)return {reply:{intent:"unknown",status:"unavailable",evidence:[],
          blocks:[{type:"text",text:clarification}]},usage};
        requestedGoals=audited;
        conversation.push({type:"function_call_output",call_id:declarations[0].call_id,
          output:JSON.stringify({accepted:true,goals:requestedGoals.length,
            note:"Scope verified independently before any café read."})});
      }
      for (const call of reads) {
        ++usage.toolCallCount;
        input.onDiagnostic?.({stage:"tool_execution",model,round:round+1,
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
        let result:ToolEvidence;
        try {result=await registry(call,usage.toolCallCount);}
        catch {throw new SupervisorStageError("tool_execution","tool_execution",{round:round+1});}
        called.push(call.name);executed.push(call);toolResults.push(result);
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

    // Bounded deterministic repair of missing declared goals. Never exceed the
    // established five CAFÉ read-tool calls, and never invent evidence for a goal.
    if(requestedGoals){
      for(const goal of requestedGoals){
        if(executed.some(c=>coversRequestedGoal(goal,c)))continue;
        if(usage.toolCallCount>=MAX_TOOLS)break;
        const fallback=fallbackCallForGoal(goal);
        if(!fallback)continue;
        const call:SupervisorToolCall={...fallback,call_id:"scope:"+usage.toolCallCount};
        ++usage.toolCallCount;
        let result:ToolEvidence;
        try {result=await registry(call,usage.toolCallCount);}
        catch {result={status:"unavailable",coverage:{},missingInputs:["readFailed"],
          estimatedInputs:[],data:null,facts:[],tasks:[],insights:[],evidence:[]};}
        executed.push(call);called.push(call.name);toolResults.push(result);
        input.onUsage?.({...usage});
      }
    }
    try {return {reply:validateSupervisorFinal(parsed,toolResults,called,input.locale,
      requestedGoals??[],executed),usage};}
    catch {throw new SupervisorStageError("final_output_validation","final_response_validation",{round:round+1});}
  }
  throw new SupervisorStageError("invalid_tool_call","tool_call_parse",{round:MAX_ROUNDS});
}
