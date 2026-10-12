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
    "For every business owner turn FIRST call declare_request_scope with a semantic goal for EVERY requested supported domain. You may call the actual read tools in the SAME response. This is mandatory planning metadata and does not consume any of the five read-tool slots. If owner asks total business costs, staff costs, menu count, pricing reviews: declare FOUR separate goals, not three. Never drop a clause.",
    "For each financial/staff goal with NO owner-specified period use month_to_date; today/week/month/custom explicit periods override. Specify the period for EACH goal in declare_request_scope. Use the SAME periods in read tools.",
    "Distinguish staff current staffing, attendance, schedules and coverage as separate goals when asked. For comparisons specify both current and comparison periods; do not guess a missing comparison period.",
    "Use remaining read tools for all declared goals. The server will check coverage and, when budget allows, fill any missing supported read deterministically; the final answer must contain a result or explicit unavailable status for every goal.",
    "General questions about how many products the café is selling so far, currently sells, currently offers or carries refer to its ACTIVE MENU CATALOG: get_menu active_count. 'So far' or 'currently' alone does not imply recorded transactions. Only distinct products ACTUALLY purchased by customers during a defined sales period use get_sales distinct_products, which requires verified item-level coverage.",
    "For price revisions always call get_pricing. Distinguish verified recommended price changes, evaluated KEEP_CURRENT_PRICE items, and blocked items. Zero verified changes with blocked products does NOT imply no prices need revision. Never infer a safe price change from missing inputs.",
    "Prior Owner AND Supervisor context is provided. Follow-ups may refer to previous rankings or answers.",
    "Never invent café facts, records, totals, shifts, employee behavior, or missing item sales.",
    "Distinguish staff employee records from AI Team task records, menu from item sales, bills from actual spending.",
    "Questions about unresolved tasks, owner attention, action items or what needs handling belong to the persisted AI Team inbox: declare team and use get_team view=tasks status=needs_you. The server displays trusted actionable cards and treats a verified empty inbox as zero, never as unknown. Snapshot Team/menu/pricing/owner-rule goals have no meaningful calendar period.",
    "For today, describe verified POS sales and orders as recorded so far, never a finalized full-day total. A verified zero is real; no connector coverage remains unavailable.",
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

/** One fresh independent semantic scope audit before the first café read.
 * No café tools, business context, history, SQL or prior declared goals are sent. */
export function buildSupervisorScopeAuditRequest({model,text,locale,asOf,timezone}) {
  const declaration=SUPERVISOR_FUNCTIONS.find(x=>x.name==="declare_request_scope");
  return {
    model,store:false,...supervisorModelProfile(model),max_output_tokens:1000,
    instructions:[
      "Independently re-read ONLY the owner's question and enumerate EVERY supported café business sub-goal.",
      "This is a scope-completeness audit, NOT a business answer. Do not infer data or amounts.",
      "Do not combine total business costs and staff costs. Keep separate menu count and pricing review requests.",
      "Choose month_to_date when costs or staff costs have no explicit period. Preserve all explicitly mentioned periods.",
      "For snapshot Team, menu count, pricing review, owner rules, break-even and coverage-task goals, period is meaningless metadata and must not imply a different request. For comparisons include both current and comparison periods.",
      "For all non-comparison goals comparison_period, comparison_from and comparison_to MUST be null.",
      "Mark complete=false or ambiguous=true if the intent or requested sub-goals cannot safely be enumerated.",
      "Use at most five distinct goals. Do not guess unsupported questions.",
      "Locale: "+locale+"; café local date: "+asOf+"; timezone: "+timezone,
    ].join("\n"),
    input:[{role:"user",content:String(text).slice(0,4000)}],
    text:{format:{type:"json_schema",name:"supervisor_scope_audit",strict:true,schema:{
      type:"object",additionalProperties:false,required:["complete","ambiguous","goals"],
      properties:{complete:{type:"boolean"},ambiguous:{type:"boolean"},
        goals:declaration.parameters.properties.goals},
    }}},
  };
}
