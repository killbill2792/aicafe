import "server-only";
import { z } from "zod";
import { SUPERVISOR_ENDPOINT, supervisorModelProfile } from "@/lib/ai/conversations/supervisorRequest.mjs";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";
import { buildP1P2Registrations } from "./p1Adapters.server";
import { createP2Registry, type ResultStatus, type TrustedReadScope } from "./registry";

const clause=z.string().trim().min(2).max(1000);
const auditSchema=z.strictObject({
  complete:z.boolean(),clauses:z.array(clause).min(1).max(5),
});
const choice=z.strictObject({
  clause,capabilityId:z.string().max(120).nullable(),
  inputJson:z.string().max(3000).nullable(),
  reason:z.enum(["missing_input","unsupported","no_data","source_free"]).nullable(),
});
const planSchema=z.strictObject({
  complete:z.boolean(),choices:z.array(choice).min(1).max(5),
});
/** OpenAI Responses strict structured output, with no generic functions, raw SQL, effect
 * arguments, tenant IDs or client-supplied capability definitions. */
export const P2_AUDIT_SCHEMA={
  type:"object",additionalProperties:false,
  required:["complete","clauses"],properties:{
    complete:{type:"boolean"},
    clauses:{type:"array",items:{type:"string"}},
  },
} as const;
export const P2_PLAN_SCHEMA={
  type:"object",additionalProperties:false,
  required:["complete","choices"],properties:{
    complete:{type:"boolean"},
    choices:{type:"array",items:{type:"object",additionalProperties:false,
      required:["clause","capabilityId","inputJson","reason"],
      properties:{
        clause:{type:"string"},capabilityId:{type:["string","null"]},
        inputJson:{type:["string","null"]},
        reason:{type:["string","null"],enum:["missing_input","unsupported","no_data","source_free",null]},
      },
    }},
  },
} as const;

export type ShadowRegistry=ReturnType<typeof createP2Registry>;
export const createDefaultShadowRegistry=()=>createP2Registry(buildP1P2Registrations());
type Transport=(url:string,init:RequestInit)=>Promise<Response>;
type Usage={model:string;modelCalls:number;inputTokens:number;outputTokens:number};
export type ShadowEvidence={
  clause:string;capabilityId:string|null;status:ResultStatus;
  /** P1 data already has canonical source, currency/unit, quality, actuality and coverage. */
  result:unknown; reason:string|null;
};
export type ShadowOutcome={
  kind:"p2_read_only_shadow";status:"verified"|"estimated"|"partial"|"unavailable";
  evidence:ShadowEvidence[];reason:string|null;usage:Usage;
  /** Actual registry read invocations, including failures; excludes model selections. */
  attemptedReads:number;
  /** No business effects of any kind can be produced by this entry point. */
  executedEffects:0;
};
const missing=(reason:string,usage:Usage,evidence:ShadowEvidence[]=[]):ShadowOutcome=>({
  kind:"p2_read_only_shadow",status:evidence.length?"partial":"unavailable",
  evidence,reason,usage:{...usage},attemptedReads:0,executedEffects:0,
});
const normalize=(x:string)=>x.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();

/** A model's `complete=true` is not proof of coverage. Reject material
 * unmatched stretches of the original owner request without inferring any
 * specialist intent or adding a question-specific routing taxonomy.
 * Permit only generic conversational framing; material omissions fail closed.
 */
const opening=new Set([
  "can","could","would","will","you","please","kindly","tell","me","if",
  "whether","what","did","were","our","we","review","check","inspect",
  "examine","show","explain","look","at","do","does","is","are",
  // Only generic Spanish and Arabic conversation framing, never business facts.
  "revisa","revisar","puedes","podrías","podrias","decirme","dime","si","por","favor",
  "هل","يمكنك","يمكن","مراجعة","تخبرني","الرجاء","من","فضلك","رجاء",
]);
const bridge=new Set([
  "and","or","also","then","tell","me","if","whether","please","could","you",
  "review","check","inspect","examine","y","e","también","además","و","ثم","أيضا",
]);
const closing=new Set(["please","thanks","thank","you","gracias","شكرا"]);
function onlyFraming(segment:string,role:"opening"|"bridge"|"closing"):boolean {
  const words=normalize(segment).match(/[\p{L}\p{N}]+/gu)??[];
  const allowed=role==="opening"?opening:role==="bridge"?bridge:closing;
  return words.every(word=>allowed.has(word));
}
export function hasP2ClauseCoverage(goal:string,clauses:readonly string[]):boolean {
  const original=normalize(goal);
  // Clauses must match separate non-overlapping occurrences in original order.
  // indexOf(part) alone can incorrectly reuse a substring of an earlier clause.
  let cursor=0;
  const unmatched:string[]=[];
  for(const c of clauses){
    const part=normalize(c);
    if(!part)return false;
    // Reject potential multi-intent clauses rather than letting one model
    // selection silently represent only the first of several owner goals.
    // Conservative in P2: an ambiguous conjunction is reported unverified.
    // Numeric date ranges (e.g. October 1 and October 3) are one filter,
    // not two business goals. Do not reject a clause solely for that joiner.
    const withoutDateJoiners=part.replace(
      /\d{1,2}\s+(?:and|y|و)\s+(?:(?:[\p{L}]+\s+)?\d{1,2})/giu,
      "date-range",
    );
    if(/(?:^|[^\p{L}])(?:and|or|also|plus|y|e|además|también|و|ثم|وكذلك)(?:[^\p{L}]|$)/iu.test(withoutDateJoiners))
      return false;
    const start=original.indexOf(part,cursor);
    if(start<0)return false;
    unmatched.push(original.slice(cursor,start));
    cursor=start+part.length;
  }
  unmatched.push(original.slice(cursor));
  return unmatched.every((segment,i)=>onlyFraming(segment,
    i===0?"opening":i===unmatched.length-1?"closing":"bridge"));
}
function responseText(response:unknown):string|null {
  if(!response||typeof response!=="object")return null;
  const r=response as {status?:unknown;output?:unknown};
  if(r.status!=="completed"||!Array.isArray(r.output))return null;
  const parts:string[]=[];
  for(const item of r.output){
    if(!item||typeof item!=="object"||(item as {type?:string}).type!=="message")continue;
    const content=(item as {content?:unknown}).content;
    if(!Array.isArray(content))continue;
    for(const p of content){
      if(p && typeof p==="object" && (p as {type?:string}).type==="output_text" &&
        typeof (p as {text?:unknown}).text==="string")
        parts.push((p as {text:string}).text);
    }
  }
  return parts.length===1 && parts[0].length<=20000?parts[0]:null;
}
function counter(usage:Usage,response:unknown) {
  if(!response||typeof response!=="object")return;
  const r=response as {model?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown}};
  usage.modelCalls++;
  if(typeof r.model==="string")usage.model=r.model.slice(0,100);
  for(const [target,key] of [["inputTokens","input_tokens"],["outputTokens","output_tokens"]] as const){
    const n=r.usage?.[key];
    if(typeof n==="number" && Number.isSafeInteger(n) && n>=0)usage[target]+=n;
  }
}
async function requestStructured<T>(params:{
  instructions:string;input:unknown;schema:object;name:string;parse:z.ZodType<T>;
  model:string;key:string;usage:Usage;transport:Transport;
}):Promise<T|null> {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),18000);
  try {
    const response=await params.transport(SUPERVISOR_ENDPOINT,{
      method:"POST",signal:controller.signal,
      headers:{"content-type":"application/json",authorization:"Bearer "+params.key},
      body:JSON.stringify({
        model:params.model,...supervisorModelProfile(params.model),store:false,
        max_output_tokens:1600,instructions:params.instructions,
        input:[{role:"user",content:JSON.stringify(params.input)}],
        text:{format:{type:"json_schema",name:params.name,strict:true,schema:params.schema}},
      }),
    });
    if(!response.ok)return null;
    const body:unknown=await response.json();
    counter(params.usage,body);
    const text=responseText(body);
    if(!text)return null;
    const parsed=params.parse.safeParse(JSON.parse(text));
    return parsed.success?parsed.data:null;
  }catch{return null;}
  finally{clearTimeout(timeout);}
}

/**
 * Exported test/integration seam, NOT a route. Trust is supplied exclusively by
 * an authenticated selected-business owner caller; injected transport enables
 * deterministic Responses fixtures without network credentials in normal CI.
 */
export async function runP2ShadowWithScope(params:{
  goal:string;scope:TrustedReadScope;transport:Transport;registry:ShadowRegistry;
  apiKey:string;model:string;
  allowSourceFree?:boolean;history?:readonly {role:"owner"|"assistant";text:string}[];
}):Promise<ShadowOutcome> {
  const usage:Usage={model:params.model,modelCalls:0,inputTokens:0,outputTokens:0};
  const validGoal=z.string().trim().min(3).max(3000).safeParse(params.goal);
  const discover=params.registry.discover(params.scope);
  if(!params.scope.shadowEnabled || !validGoal.success || !params.apiKey ||
    !discover.length)return missing("disabled_or_unauthorized",usage);
  const goal=validGoal.data;
  const audit=await requestStructured({
    instructions:[
      "This is a read-only shadow completeness audit, not an answer.",
      "Split the owner's exact goal into EVERY independent semantic request, including unsupported work.",
      "Do not combine independent goals joined by and/or/y/و into one clause.",
      "Preserve standalone conjunctions outside individually addressable clauses.",
      "Use recent conversation context only to understand references, never to replace the current message.",
      "Return each clause as an EXACT CONTIGUOUS SUBSTRING of the original question,",
      "without paraphrasing, invented facts, substitutions, or merging distinct goals.",
      "Include all material outcome predicates, limitations and restrictions in clauses.",
      "Only polite framing and connective words may be omitted.",
      "Set complete=false if you cannot preserve all clauses in at most five elements.",
      "Do not make any claim about café records or approved actions.",
    ].join(" "),
    input:{goal,recentConversationContext:(params.history??[]).slice(-6).map(h=>({
      role:h.role,text:h.text.slice(0,450),
    }))},schema:P2_AUDIT_SCHEMA,name:"p2_goal_audit",parse:auditSchema,
    key:params.apiKey,model:params.model,usage,transport:params.transport,
  });
  if(!audit || !audit.complete || !hasP2ClauseCoverage(goal,audit.clauses))
    return missing("scope_unverified",usage);
  const plan=await requestStructured({
    instructions:[
      "Read-only capability selection for this independent shadow demonstration.",
      "Recheck the ORIGINAL owner goal independently against the supplied clause list.",
      "If any independently requested goal is missing, set complete=false.",
      "You MUST return exactly one choice per supplied audit clause in the same order,",
      "with the clause string copied character-for-character. Never silently drop one.",
      "Select a capability ID ONLY from the reviewed owner-visible server manifest.",
      "Use its input JSON schema and allowedPurpose; inputJson must be a JSON string",
      "containing its strict input (including exact id, version, purpose).",
      "Do not fabricate product IDs, sales, wages, source coverage or data.",
      "If a required ID/period cannot be safely selected, choose null and missing_input.",
      "For unsupported changes, approvals, purchases, publish or payroll: choose null and unsupported.",
      "Do not emit SQL, businessId, ownerId, effects, write requests or summaries.",
      "Selection is NOT evidence of a completed read or business outcome.",
      ...(params.allowSourceFree?[ 
        "For independently owner-stated arithmetic with no cafe records needed,",
        "select null capability, null inputJson and reason source_free; never read cafe data.",
      ]:[]),
    ].join(" "),
    input:{originalGoal:goal,localDate:params.scope.identity.asOf,
      recentConversationContext:(params.history??[]).slice(-6).map(h=>({
        role:h.role,text:h.text.slice(0,450),
      })),
      timezone:params.scope.identity.timezone,clauses:audit.clauses,
      capabilities:discover.map(def=>({
      id:def.id,mode:def.mode,purpose:def.purpose,
      allowedPurposes:def.allowedPurposes,inputJsonSchema:def.inputJsonSchema,
      sources:def.sourceIds,availability:def.availability,
    }))},
    schema:P2_PLAN_SCHEMA,name:"p2_capability_selection",parse:planSchema,
    key:params.apiKey,model:params.model,usage,transport:params.transport,
  });
  if(!plan || !plan.complete || plan.choices.length!==audit.clauses.length ||
    plan.choices.some((v,i)=>v.clause!==audit.clauses[i]))
    return missing("scope_unverified",usage);
  const supportedIds=new Set(discover.map(d=>d.id));
  const evidence:ShadowEvidence[]=[];
  let attemptedReads=0;
  for(const selected of plan.choices){
    const id=selected.capabilityId;
    if(!id) {
      const sourceFree=selected.reason==="source_free" && params.allowSourceFree;
      evidence.push({clause:selected.clause,capabilityId:null,status:"unavailable",
        result:null,reason:sourceFree?"source_free":
          selected.reason==="source_free"?"unsupported":selected.reason??"unsupported"});
      continue;
    }
    if(selected.reason==="source_free"){
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"invalid_request"});
      continue;
    }
    if(!supportedIds.has(id)){
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"unknown_capability"});
      continue;
    }
    if(attemptedReads>=4) {
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"budget_exceeded"});
      continue;
    }
    // Never let model-only no_data assertions bypass an authorized canonical read.
    if(selected.reason==="missing_input" || !selected.inputJson){
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"missing_input"});
      continue;
    }
    let parsed:unknown;
    try{parsed=JSON.parse(selected.inputJson);}
    catch {
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"invalid_request"});continue;
    }
    attemptedReads++;
    const result=await params.registry.invoke(params.scope,id,parsed);
    const raw=result as {status?:ResultStatus;reason?:string};
    const accepted=raw.status==="verified" || raw.status==="estimated" || raw.status==="partial";
    const status:ResultStatus=accepted?raw.status!:"unavailable";
    evidence.push({clause:selected.clause,capabilityId:id,status,
      result:accepted?result:null,
      reason:accepted?null:raw.reason??raw.status??"unavailable_source"});
  }
  const successful=evidence.filter(e=>e.status!=="unavailable");
  const status:ShadowOutcome["status"]=successful.length===0?"unavailable":
    successful.length!==evidence.length?"partial":
    evidence.some(e=>e.status==="partial"||e.status==="insufficient_evidence")?"partial":
    evidence.some(e=>e.status==="estimated")?"estimated":"verified";
  return {kind:"p2_read_only_shadow",status,evidence,
    reason:successful.length===evidence.length?null:"some_goals_unavailable",usage,
    attemptedReads,executedEffects:0};
}

/** Off by default. Only an existing authenticated owner can call this isolated
 * server function; no API route, UI, background job or production router uses it.
 */
export async function runAuthorizedP2Shadow(goal:string):Promise<ShadowOutcome> {
  const model=process.env.SUPERVISOR_P2_SHADOW_MODEL ||
    process.env.SUPERVISOR_OPENAI_MODEL || "gpt-6-luna";
  const usage={model,modelCalls:0,inputTokens:0,outputTokens:0};
  if(process.env.SUPERVISOR_P2_SHADOW_ENABLED!=="true" || !process.env.OPENAI_API_KEY)
    return missing("disabled",usage);
  try {
    const authorized=await authorizedOwnerP1();
    const businessId=authorized.identity.businessId;
    if(!businessId)return missing("unauthorized",usage);
    return runP2ShadowWithScope({
      goal,model,apiKey:process.env.OPENAI_API_KEY,transport:fetch,
      scope:{role:"owner",businessId,identity:authorized.identity,
        tools:authorized.tools,shadowEnabled:true},
      registry:createDefaultShadowRegistry(),
    });
  }catch{return missing("unauthorized_or_unavailable",usage);}
}
