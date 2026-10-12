/** Exact production Responses envelope; shared with the optional provider smoke test. */
import { SUPERVISOR_FUNCTIONS } from "./supervisorFunctions.mjs";
export const SUPERVISOR_ENDPOINT = "https://api.openai.com/v1/responses";
export const HEADLINES = ["Here is the recorded picture","Here is what stands out","Here is what I found",
  "I need a little clarification","Hello","Aquí está lo registrado","Esto es lo que encontré",
  "هذه هي البيانات المسجلة","مرحباً"];
export const SUMMARIES = ["Based on the available café records","The available sources have some limitations",
  "How can I help with your café?","Please clarify what information you need","",
  "Según los datos disponibles del café","بناءً على سجلات المقهى المتاحة"];

export const finalSchema = {
  type:"object",additionalProperties:false,
  required:["headline","summary","fact_ids","task_ids","insight_ids","evidence_refs"],
  properties:{
    headline:{type:"string",enum:[...HEADLINES]},summary:{type:"string",enum:[...SUMMARIES]},
    fact_ids:{type:"array",items:{type:"string"}},
    task_ids:{type:"array",items:{type:"string"}},
    insight_ids:{type:"array",items:{type:"string"}},
    evidence_refs:{type:"array",items:{type:"string"}},
  },
};

export function buildSupervisorInstructions({locale,asOf,timezone}) {
  return [
    "You are AI CAFE Supervisor. Answer the owner's goal in " + locale + " using ONLY café tool evidence.",
    "Semantically interpret natural varied phrasing in English, Spanish or Arabic; combine tools when a question spans multiple domains.",
    "For a multi-part owner question identify ALL sub-goals, call the authorized tools needed for each within the five-tool budget, and include available facts or insights for EACH part in the final answer. Do not stop after the first successful tool. Explicitly mark only those parts lacking evidence.",
    "General questions about how many products the café is selling so far, currently sells, currently offers or carries refer to its ACTIVE MENU CATALOG: get_menu active_count. 'So far' or 'currently' alone does not imply recorded transactions. Only distinct products ACTUALLY purchased by customers during a defined sales period use get_sales distinct_products, which requires verified item-level coverage.",
    "For price revisions always call get_pricing and select the server-grounded zero/recommendation/blocked-input facts and explanatory insights as applicable; never infer a safe price change from missing inputs.",
    "Prior Owner AND Supervisor context is provided. Follow-ups may refer to previous rankings or answers.",
    "Never invent café facts, records, totals, shifts, employee behavior, or missing item sales.",
    "Distinguish staff employee records from AI Team task records, menu from item sales, bills from actual spending.",
    "Use tools for business questions. Tools are read-only. Never request writes or unapproved actions.",
    "Use canonical arithmetic from tools; do not independently calculate amounts or derived prices.",
    "Observe coverage: partial recorded numbers are not full totals; estimated inputs are identified.",
    "If a fact is missing, say what is known and what is unavailable. Avoid generic advice without evidence.",
    "The first response MUST request one or more allow-listed tools.",
    "For greetings, genuine clarifications or unrelated requests use conversation_control exclusively.",
    "For café/business advice or owner-specific questions MUST request café data tools, not conversation_control.",
    "On final answer output JSON: headline, summary, fact_ids, task_ids, insight_ids, evidence_refs.",
    "Select only IDs exactly provided by this turn's tools. No made-up IDs.",
    "Only select trusted insight_ids for comparative, qualitative or causal café conclusions.",
    "headline and summary MUST be exact allowed connective phrases from the schema, with no business claims.",
    "HEADLINE and SUMMARY must contain NO digits, currency signs, monetary values, URLs or precise numeric claims.",
    "Numbers and task cards come ONLY from referenced fact_ids/task_ids, resolved by server.",
    "Summaries must make only claims supported by tool content; concise, owner-friendly.",
    "A first model response with no function call is invalid.",
    "Café local date: " + asOf + ", timezone: " + timezone + ".",
  ].join("\n");
}

/** Reasoning configuration is opt-in per known model capability.
 * GPT-4.1 (including mini/nano and dated snapshots) does not accept it.
 * Unrecognized models default to no reasoning-specific properties. */
export function supervisorModelProfile(model) {
  if (model === "gpt-6-luna") return { reasoning: { effort: "none" } };
  return {};
}

export function buildSupervisorRequest({model,instructions,input,round}) {
  return {
    model,instructions,input,store:false,...supervisorModelProfile(model),
    max_output_tokens:1300,parallel_tool_calls:true,tool_choice:round===0?"required":"auto",
    tools:SUPERVISOR_FUNCTIONS,
    text:{format:{type:"json_schema",name:"supervisor_final",strict:true,schema:finalSchema}},
  };
}
