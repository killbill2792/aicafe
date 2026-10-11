import "server-only";
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";
import type { GroundedSupervisorReply, SupervisorReplyBlock, EvidenceReference } from "./contracts";
import type { ConversationalTurn } from "./context";
import { createSupervisorToolRegistry, intentForCalls, parseSupervisorCalls,
  SUPERVISOR_FUNCTIONS, type ToolEvidence, type SupervisorToolName } from "./toolRegistry.server";

export type SupervisorUsage = {
  model: string; inputTokens: number; outputTokens: number;
  modelCallCount: number; toolCallCount: number;
};
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const FINAL = z.strictObject({
  headline: z.string().trim().max(130),
  summary: z.string().trim().max(500),
  fact_ids: z.array(z.string().max(80)).max(12),
  task_ids: z.array(z.string().max(200)).max(8),
  evidence_refs: z.array(z.string().max(160)).max(20),
});
const finalSchema = {
  type:"object",additionalProperties:false,
  required:["headline","summary","fact_ids","task_ids","evidence_refs"],
  properties:{
    headline:{type:"string"},summary:{type:"string"},
    fact_ids:{type:"array",items:{type:"string"}},
    task_ids:{type:"array",items:{type:"string"}},
    evidence_refs:{type:"array",items:{type:"string"}},
  },
};
const MAX_ROUNDS = 3, MAX_TOOLS = 5;
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
  const refs: EvidenceReference[] = [];
  for (const identifier of final.evidence_refs) {
    const found = availableRefs.find(x=>x.identifier===identifier);
    if (!found) throw new Error("Unverified Supervisor evidence reference");
    refs.push(found);
  }
  for (const r of selectedFacts.map(x=>x.source).concat(selectedTasks.map(x=>x.source))) refs.push(r);
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
  const relevant = results;
  const hasFacts = selectedFacts.length>0 || selectedTasks.length>0 || evidence.length>0;
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
}, transport: Transport = fetch): Promise<{reply:GroundedSupervisorReply;usage:SupervisorUsage}> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Supervisor provider unavailable");
  const model = process.env.SUPERVISOR_OPENAI_MODEL || "gpt-6-luna";
  const usage: SupervisorUsage = {model,inputTokens:0,outputTokens:0,modelCallCount:0,toolCallCount:0};
  const registry = createSupervisorToolRegistry(input);
  const toolResults: ToolEvidence[] = [], called: SupervisorToolName[] = [];
  const instructions = [
    "You are AI CAFE Supervisor. Answer the owner's goal in " + input.locale + " using ONLY café tool evidence.",
    "Semantically interpret natural varied phrasing; combine tools when a question spans multiple domains.",
    "Prior Owner AND Supervisor context is provided. Follow-ups may refer to previous rankings or answers.",
    "Never invent café facts, records, totals, shifts, employee behavior, or missing item sales.",
    "Distinguish staff employee records from AI Team task records, menu from item sales, bills from actual spending.",
    "Use tools for business questions. Tools are read-only. Never request writes or unapproved actions.",
    "Use canonical arithmetic from tools; do not independently calculate amounts or derived prices.",
    "Observe coverage: partial recorded numbers are not full totals; estimated inputs are identified.",
    "If a fact is missing, say what is known and what is unavailable. Avoid generic advice without evidence.",
    "On final answer output JSON: headline, summary, fact_ids, task_ids, evidence_refs.",
    "Select only IDs exactly provided by this turn's tools. No made-up IDs.",
    "HEADLINE and SUMMARY must contain NO digits, currency signs, monetary values, URLs or precise numeric claims.",
    "Numbers and task cards come ONLY from referenced fact_ids/task_ids, resolved by server.",
    "Summaries must make only claims supported by tool content; concise, owner-friendly.",
    "For greetings and genuine clarification you may produce a final response with no tools.",
    "Café local date: " + input.asOf + ", timezone: " + input.timezone + ".",
  ].join("\n");
  const history = input.history.slice(-12).filter(x=>x.text).map(x=>({
    role: x.role==="owner" ? "user" : "assistant", content:x.text.slice(0,850),
  }));
  const conversation: unknown[] = [...history,{role:"user",content:input.text.slice(0,4000)}];
  for (let round=0;round<MAX_ROUNDS;round++) {
    let payload: Record<string,unknown> | null = null;
    for (let attempt=0;attempt<2;attempt++) {
      const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),18_000);
      let retryable = true;
      try {
        const response = await transport("https://api.openai.com/v1/responses",{
          method:"POST",signal:controller.signal,
          headers:{"content-type":"application/json",authorization:"Bearer "+key},
          body:JSON.stringify({
            model,instructions,input:conversation,store:false,reasoning:{effort:"none"},
            max_output_tokens:1300,parallel_tool_calls:true,tool_choice:"auto",
            tools:SUPERVISOR_FUNCTIONS,
            text:{format:{type:"json_schema",name:"supervisor_final",strict:true,schema:finalSchema}},
          }),
        });
        if (!response.ok) {
          retryable=[408,409,429].includes(response.status)||response.status>=500;
          throw new Error("Supervisor provider unavailable");
        }
        const body: unknown = await response.json();
        if (!body || typeof body!=="object" || !("output" in body) ||
          (body as {status?:unknown}).status==="incomplete") throw new Error("Supervisor provider incomplete");
        payload=body as Record<string,unknown>;
        break;
      } catch {
        if (!retryable || attempt===1) throw new Error("Supervisor provider unavailable");
      } finally { clearTimeout(timeout); }
    }
    if (!payload) throw new Error("Supervisor provider unavailable");
    usage.modelCallCount++;
    usage.model = typeof payload.model==="string" ? payload.model.slice(0,80) : model;
    const used = payload.usage as {input_tokens?:unknown;output_tokens?:unknown}|undefined;
    usage.inputTokens+=integer(used?.input_tokens); usage.outputTokens+=integer(used?.output_tokens);
    input.onUsage?.({...usage});
    const output = payload.output;
    const calls = parseSupervisorCalls(output);
    if (calls.length) {
      if (round===MAX_ROUNDS-1 || usage.toolCallCount+calls.length>MAX_TOOLS)
        throw new Error("Supervisor safe tool budget exceeded");
      const duplicates = new Set<string>();
      for (const call of calls) {
        if (duplicates.has(call.call_id)) throw new Error("Duplicate Supervisor call ID");
        duplicates.add(call.call_id);
      }
      // Preserve every Responses output item, including reasoning, and pair each tool output by call_id.
      conversation.push(...(output as unknown[]));
      for (const call of calls) {
        const result = await registry(call,++usage.toolCallCount);
        called.push(call.name);toolResults.push(result);
        const trimmed = JSON.stringify(result);
        if (trimmed.length>14000) throw new Error("Supervisor tool result exceeded safe size");
        conversation.push({type:"function_call_output",call_id:call.call_id,output:trimmed});
      }
      input.onUsage?.({...usage});
      continue;
    }
    const text = textFromResponse(output);
    if (!text) throw new Error("Supervisor final response unavailable");
    let parsed: unknown;
    try { parsed=JSON.parse(text); } catch { throw new Error("Supervisor final response malformed"); }
    return {reply:validateSupervisorFinal(parsed,toolResults,called,input.locale),usage};
  }
  throw new Error("Supervisor safe turn limit exceeded");
}
