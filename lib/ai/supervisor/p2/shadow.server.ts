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
  reason:z.enum(["missing_input","unsupported","no_data"]).nullable(),
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
        reason:{type:["string","null"],enum:["missing_input","unsupported","no_data",null]},
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
  /** No business effects of any kind can be produced by this entry point. */
  executedEffects:0;
};
const missing=(reason:string,usage:Usage,evidence:ShadowEvidence[]=[]):ShadowOutcome=>({
  kind:"p2_read_only_shadow",status:evidence.length?"partial":"unavailable",
  evidence,reason,usage:{...usage},executedEffects:0,
});
const normalize=(x:string)=>x.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();

/** A model's `complete=true` is not proof of coverage. Reject material
 * unmatched stretches of the original owner request without inferring any
 * specialist intent or adding a question-specific routing taxonomy.
 * Short connective/polite fragments are allowed; suspicious omissions fail closed.
 */
export function hasP2ClauseCoverage(goal:string,clauses:readonly string[]):boolean {
  const original=normalize(goal);
  const spans:Array<{start:number;end:number}>=[];
  for(const c of clauses){
    const part=normalize(c);
    if(!part)return false;
    const start=original.indexOf(part);
    if(start<0)return false;
    spans.push({start,end:start+part.length});
  }
  spans.sort((a,b)=>a.start-b.start);
  let end=0;
  const unmatched:string[]=[];
  for(const span of spans){
    if(span.start<end)return false;
    unmatched.push(original.slice(end,span.start));
    end=span.end;
  }
  unmatched.push(original.slice(end));
  return unmatched.every(segment=>
    (segment.match(/[\p{L}\p{N}]+/gu)?.length??0)<5);
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
      "Return each clause as an EXACT CONTIGUOUS SUBSTRING of the original question,",
      "without paraphrasing, invented facts, substitutions, or merging distinct goals.",
      "Set complete=false if you cannot preserve all clauses in at most five elements.",
      "Do not make any claim about café records or approved actions.",
    ].join(" "),
    input:{goal},schema:P2_AUDIT_SCHEMA,name:"p2_goal_audit",parse:auditSchema,
    key:params.apiKey,model:params.model,usage,transport:params.transport,
  });
  if(!audit || !audit.complete || !hasP2ClauseCoverage(goal,audit.clauses) ||
    new Set(audit.clauses.map(normalize)).size!==audit.clauses.length)
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
    ].join(" "),
    input:{originalGoal:goal,localDate:params.scope.identity.asOf,
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
  for(const selected of plan.choices){
    const id=selected.capabilityId;
    if(!id) {
      evidence.push({clause:selected.clause,capabilityId:null,status:"unavailable",
        result:null,reason:selected.reason??"unsupported"});
      continue;
    }
    if(!supportedIds.has(id)){
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"unknown_capability"});
      continue;
    }
    if(evidence.filter(x=>x.capabilityId!==null && x.reason!=="budget_exceeded").length>=4) {
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"budget_exceeded"});
      continue;
    }
    if(selected.reason || !selected.inputJson){
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:selected.reason??"missing_input"});
      continue;
    }
    let parsed:unknown;
    try{parsed=JSON.parse(selected.inputJson);}
    catch {
      evidence.push({clause:selected.clause,capabilityId:id,status:"unavailable",
        result:null,reason:"invalid_request"});continue;
    }
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
    executedEffects:0};
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
