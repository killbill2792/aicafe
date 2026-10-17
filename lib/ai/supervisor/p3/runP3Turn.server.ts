import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GroundedSupervisorReply,EvidenceReference,SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";
import { SUPERVISOR_ENDPOINT,supervisorModelProfile } from
  "@/lib/ai/conversations/supervisorRequest.mjs";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";
import { readAuthorizedAtomicP1SourceSnapshot } from
  "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { runP2ShadowWithScope } from "@/lib/ai/supervisor/p2/shadow.server";
import { createP3ReadRegistry } from "./sourceRegistry.server";
import { buildAlexP3Registrations } from "@/lib/pricing/alexP3Capabilities.server";
import { buildOliviaP3Registrations } from "@/lib/scheduling/oliviaP3Capabilities.server";
import { parseOwnerDateWindows, ownerDateWindowsFromContext } from "@/lib/ai/conversations/ownerDateIntent";
import { projectP1Evidence } from "./operandProjection.server";
import { enrichResolvedProductEconomics } from "./productEconomicsAdapter.server";
import { EXPRESSION_ID,planSchema,type ExpressionOutcome } from "./expression";
import { simulationOutputSchema } from "./simulateRegistration.server";
import { rebaseQuotedOccurrence } from "./quoteOccurrences";
import { presentRegisteredReads,registeredReadReason } from "./readEvidencePresentation";
import { formatScenarioValue,formatScenarioAssumption,formatScenarioFormula } from "./formatScenario";
import type { ConversationalTurn } from "@/lib/ai/conversations/context";

type Transport=(url:string,init:RequestInit)=>Promise<Response>;
const coverage=z.strictObject({
  complete:z.boolean(),
  plans:z.array(z.strictObject({
    coveredClauses:z.array(z.string().min(2).max(1000)).min(1).max(5),
    planJson:z.string().max(6000).nullable(),reason:z.enum([
      "unsupported","missing_input","unsupported_action","read_only"]).nullable(),
  })).min(1).max(5),
});
const OUTPUT_SCHEMA={
  type:"object",additionalProperties:false,required:["complete","plans"],
  properties:{
    complete:{type:"boolean"},
    plans:{type:"array",minItems:1,maxItems:5,items:{
      type:"object",additionalProperties:false,
      required:["coveredClauses","planJson","reason"],
      properties:{
        coveredClauses:{type:"array",minItems:1,maxItems:5,items:{type:"string"}},
        planJson:{type:["string","null"]},
        reason:{type:["string","null"],enum:[
          "unsupported","missing_input","unsupported_action","read_only",null]},
      },
    }},
  },
} as const;
export type P3Usage={model:string;modelCallCount:number;toolCallCount:number;
  inputTokens:number;outputTokens:number};
export type P3Result={reply:GroundedSupervisorReply;usage:P3Usage;
  kind:"p3_read_only_conditional";executedEffects:0};

function responseText(raw:unknown):string|null {
  if(!raw||typeof raw!=="object")return null;
  const obj=raw as {status?:unknown;output?:unknown};
  if(obj.status!=="completed"||!Array.isArray(obj.output))return null;
  const text:string[]=[];
  for(const item of obj.output){
    if(!item||typeof item!=="object"||(item as {type?:string}).type!=="message")continue;
    const content=(item as {content?:unknown}).content;
    if(!Array.isArray(content))continue;
    for(const part of content){
      if(part&&typeof part==="object"&&(part as {type?:string}).type==="output_text"&&
        typeof (part as {text?:unknown}).text==="string")
        text.push((part as {text:string}).text);
    }
  }
  return text.length===1&&text[0].length<14000?text[0]:null;
}
async function modelComposition(input:{
  goal:string;clauses:string[];history:readonly {role:"owner"|"assistant";text:string}[];
  operands:Array<{
    handle:string;unit:string;sourceQuality:string;entityName:string;
    entityId:string;field:string;matchedClause:string;
  }>;readableSourceClauses:readonly string[];
  model:string;apiKey:string;transport:Transport;
}):Promise<{plan:ReturnType<typeof coverage.parse>;tokens:{input:number;output:number}}|null>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),18000);
  try{
    const response=await input.transport(SUPERVISOR_ENDPOINT,{
      method:"POST",signal:controller.signal,
      headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
      body:JSON.stringify({
        model:input.model,...supervisorModelProfile(input.model),
        store:false,max_output_tokens:1600,
        instructions:[
          "You plan an owner-requested READ-ONLY bounded calculation, not a business action.",
          "Open-ended goals may combine different specialties; preserve EVERY supplied semantic clause.",
          "Return up to five independent expressions. One expression may cover multiple clauses.",
          "Each coveredClauses entry must be copied exactly from the verified list.",
          "Cover each supplied clause exactly once. If impossible set complete=false.",
          "planJson is a JSON STRING containing strictly the versioned expression plan.",
          "Allowed expression keys: capabilityId platform.scenario.expression.v1, version 1,",
          "purpose preauthorized_operands or no_external_sources, description and nodes.",
          "Nodes are a bounded postfix/RPN stack program of sources, clearly named owner",
          "hypotheticals, and vetted operators: add, subtract, multiply, divide,",
          "ratio, scenario_delta, compare, convert, loaded_labor. Use handles ONLY from authorized list.",
          "Use units exactly as supplied for sources; do not make up source values.",
          "Each opaque source handle is bound to a verified entityName, entityId,",
          "field and matchedClause. Match requested names to these bindings,",
          "never guess employee/product identity from a UUID or reverse records.",
          "For hypothetical nodes copy the exact owner-quoted substring as quotedNumber",
          "and provide an integer value. If the SAME number occurs multiple times",
          "with different units, include occurrence: zero-based ordinal among",
          "whole matches of quotedNumber in the original owner utterance.",
          "Never guess an occurrence or reuse a different number's unit.",
          "For fractional nonmoney quantities (e.g. 1.5",
          "hours), use quantityScale hundredth and value 150 to retain exact units.",
          "For money nodes use integer cents. Default quoted money is in dollars.",
          "When and ONLY when owner explicitly wrote cents/centavos/¢, include",
          "quotedDenomination cents and use the quoted integer amount in cents.",
          "Never reinterpret cents as dollars or invent a denomination.",
          "For loaded_labor push canonical wages in USD_cents, then an authorized employer",
           "cost rate in ratio_bps; this primitive uses the tested payroll engine.",
           "If employer burden is missing, do NOT assume 12 percent or claim loaded cost.",
           "Never claim observed sales, actual wages, source revisions, approvals or effects.",
          "Never use SQL, JavaScript, executors, hidden reads or new domain capabilities.",
          "For a request to SHOW or LIST already authorized record fields with no arithmetic,",
          "choose planJson null and reason read_only ONLY for a clause in readableSourceClauses.",
          "This renders a provisional bounded source sample, never a complete count or effect.",
          "Never classify a request for a business change/approval as a completed read.",
          "If a requested calculation lacks necessary operands, choose null and missing_input.",
          "Writes or approvals are unsupported_action. Do not present a partial subtraction",
          "of revenue and wages as verified profit when ingredients/fees are missing.",
        ].join(" "),
        input:[{role:"user",content:JSON.stringify({
          goal:input.goal,clauses:input.clauses,
          recentConversationContext:input.history.slice(-6).map(h=>({
            role:h.role,text:h.text.slice(0,450),
          })),
          authorizedOperandChoices:input.operands,
          readableSourceClauses:input.readableSourceClauses,
        })}],
        text:{format:{type:"json_schema",name:"p3_expression_plans",strict:true,
          schema:OUTPUT_SCHEMA}},
      }),
    });
    if(!response.ok)return null;
    const data:unknown=await response.json();
    const raw=responseText(data);
    if(!raw)return null;
    const result=coverage.safeParse(JSON.parse(raw));
    if(!result.success)return null;
    const usage=(data as {usage?:{input_tokens?:unknown;output_tokens?:unknown}}).usage;
    const n=(v:unknown)=>Number.isSafeInteger(v)&&typeof v==="number"&&v>=0?v:0;
    return {plan:result.data,tokens:{input:n(usage?.input_tokens),
      output:n(usage?.output_tokens)}};
  }catch{return null;}
  finally{clearTimeout(timer);}
}
function exactCoverage(clauses:string[],plans:{coveredClauses:string[]}[]):boolean{
  const expected=new Map<string,number>();
  for(const clause of clauses)expected.set(clause,(expected.get(clause)??0)+1);
  for(const item of plans)for(const clause of item.coveredClauses){
    const n=expected.get(clause);
    if(!n)return false;
    expected.set(clause,n-1);
  }
  return [...expected.values()].every(v=>v===0);
}
/** A model may choose a canonical read, but may NOT choose its time range.
 * Preserve only date windows directly established by the owner. Ambiguous
 * natural-language ranges fail closed instead of silently displaying wrong days.
 */
function quotedPeriod(text:string,asOf:string):{from:string;to:string}|null{
  // Preserve P3's existing ISO envelope needed by independently scoped
  // P2 clauses; each individual source still must match its own quoted date.
  const dates=[...text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu)].map(x=>x[0]);
  if(dates.length===1)return {from:dates[0],to:dates[0]};
  if(dates.length===2&&dates[0]<=dates[1])return {from:dates[0],to:dates[1]};
  if(dates.length>2)return null;
  const parsed=parseOwnerDateWindows(text,asOf);
  if(parsed.length===1)return parsed[0];
  if(parsed.length>1)return null;
  const normalized=text.normalize("NFKC").toLocaleLowerCase();
  if(/\b(?:today|hoy)\b|اليوم/u.test(normalized))
    return {from:asOf,to:asOf};
  if(/\b(?:yesterday|ayer)\b|أمس/u.test(normalized)){
    const day=new Date(asOf+"T12:00:00Z");
    if(Number.isNaN(day.getTime()))return null;
    day.setUTCDate(day.getUTCDate()-1);
    const date=day.toISOString().slice(0,10);
    return {from:date,to:date};
  }
  return null;
}
export function verifiedReaderPeriods(evidence:readonly {clause:string;result:unknown}[],
  request:string,asOf:string):boolean{
  const goal=quotedPeriod(request,asOf);
  for(const item of evidence){
    const envelope=item.result;
    if(!envelope||typeof envelope!=="object"||Array.isArray(envelope))continue;
    const q=(envelope as {query?:unknown}).query;
    if(!q||typeof q!=="object"||Array.isArray(q))continue;
    const p=(q as {period?:unknown}).period;
    if(p===undefined)continue;
    if(!p||typeof p!=="object"||Array.isArray(p))return false;
    const chosen=p as {from?:unknown;to?:unknown};
    const expected=quotedPeriod(item.clause,asOf)??goal;
    if(!expected||chosen.from!==expected.from||chosen.to!==expected.to)
      return false;
  }
  return true;
}
const labels={
  en:{conditional:"Conditional what-if, not a demand forecast or verified profit.",
    incomplete:"Some source records are missing, provisional or lack a stable revision.",
    money:"Conditional scenario change",number:"Calculated scenario result",
    unsupported:"This request needs additional authorized data or later-stage approval.",
    baseline:"Baseline totals and source revisions are not independently established.",
    assumptions:"Owner-stated hypothetical quantities",
    formula:"Vetted calculation steps",
    missing:"Some input evidence still needs review."},
  es:{conditional:"Escenario condicional, no pronóstico de demanda ni beneficio verificado.",
    incomplete:"Faltan datos, son provisionales o no tienen revisión verificable.",
    money:"Cambio condicional del escenario",number:"Resultado calculado del escenario",
    unsupported:"Se necesitan más datos autorizados o aprobación en una fase posterior.",
    baseline:"No se han verificado los totales de referencia ni las revisiones de origen.",
    assumptions:"Cantidades hipotéticas dadas por el propietario",
    formula:"Pasos del cálculo validado",
    missing:"Datos pendientes de verificación"},
  ar:{conditional:"سيناريو مشروط، وليس توقعًا للطلب أو ربحًا مؤكّدًا.",
    incomplete:"بعض السجلات مفقودة أو مؤقتة أو دون مراجعة موثوقة.",
    money:"التغيّر المشروط في السيناريو",number:"نتيجة السيناريو المحسوبة",
    unsupported:"يلزم توفر بيانات مأذون بها أو موافقة في مرحلة لاحقة.",
    baseline:"لم يتم التحقق من القيم الأساسية أو مراجعات المصادر.",
    assumptions:"الكميات الافتراضية التي ذكرها المالك",
    formula:"خطوات الحساب المعتمدة",
    missing:"مدخلات لم يتم التحقق منها"},
};
/** A server-authenticated owner read path only, off by default at its caller. */
export async function tryP3SupervisorReadOnly(input:{
  text:string;locale:"en"|"es"|"ar";asOf:string;timezone:string;
  apiKey:string;model:string;transport:Transport;
  history?:ConversationalTurn[];
  onUsage?:(usage:P3Usage)=>void;
}):Promise<P3Result|null>{
  // P3 scalar reads currently validate one contiguous owner date window.
  // Disjoint days belong to the registered multi-read Supervisor path; skip
  // P3 *before* spending a provider/read budget rather than widening dates.
  const directDates=parseOwnerDateWindows(input.text,input.asOf);
  const contextualDates=ownerDateWindowsFromContext(input.text,input.asOf,input.history);
  // Existing P3 multi-clause ISO dates are already checked independently by
  // verifiedReaderPeriods; only newer conversational month-name/deictic multi-
  // day references need the legacy independent-date reader path.
  const isoDates=[...input.text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu)].length;
  if((contextualDates.length>1 && isoDates===0) ||
    (!directDates.length && contextualDates.length>0))return null;
  const {tools,identity}=await authorizedOwnerP1();
  const allowed=(process.env.SUPERVISOR_P3_ALLOWED_BUSINESS_IDS??"")
    .split(",").map(id=>id.trim()).filter(Boolean);
  // Compatibility requires BOTH the default-off feature flag at the caller
  // and an explicit authenticated selected-business allowlist.
  if(!identity.businessId||!allowed.includes(identity.businessId)||
    !input.apiKey||identity.currency!=="USD")return null;
  const scope={role:"owner" as const,businessId:identity.businessId,
    identity:{...identity},tools,shadowEnabled:true};
  const capabilityRegistry=createP3ReadRegistry([
    ...buildAlexP3Registrations(),...buildOliviaP3Registrations(),
  ]);
  if(!capabilityRegistry.discoverSimulations(scope).some(x=>x.id===EXPRESSION_ID))
    return null;
  // Bracket independently fetched P1 selectors by an authoritative epoch.
  // Taking only a post-read snapshot misses updates between selection and
  // the initial snapshot, even if the final epoch check is unchanged.
  const reported:P3Usage={model:input.model,modelCallCount:0,
    toolCallCount:0,inputTokens:0,outputTokens:0};
  const sourceIntegrityFailure=()=>({
    kind:"p3_read_only_conditional" as const,executedEffects:0 as const,
    reply:{intent:"profitability" as const,status:"unavailable" as const,
      evidence:[],blocks:[{type:"warning" as const,code:"P3_SOURCE_INTEGRITY",
        text:labels[input.locale].unsupported}]},
    usage:{...reported},
  });
  const atomic=await readAuthorizedAtomicP1SourceSnapshot();
  if(atomic.status==="unavailable"&&atomic.reason!=="rpc_not_installed")
    return sourceIntegrityFailure();
  if(atomic.status==="available"&&
    (atomic.snapshot.businessId!==identity.businessId||
      atomic.snapshot.currency!==identity.currency||
      atomic.snapshot.timezone!==identity.timezone))
    return sourceIntegrityFailure();
  const shadow=await runP2ShadowWithScope({
    goal:input.text,scope,registry:capabilityRegistry,
    apiKey:input.apiKey,model:input.model,transport:input.transport,
    allowSourceFree:true,allowMultipleReadsPerClause:true,
    history:(input.history??[]).slice(-6).map(h=>({
      role:h.role==="owner"?"owner" as const:"assistant" as const,
      text:h.text.slice(0,450),
    })),
  });
  reported.modelCallCount=shadow.usage.modelCalls;
  reported.toolCallCount=shadow.attemptedReads;
  reported.inputTokens=shadow.usage.inputTokens;
  reported.outputTokens=shadow.usage.outputTokens;
  input.onUsage?.({...reported});
  if(!shadow.evidence.length)return null;
  // A syntactically valid model-selected date range is not owner authorization.
  if(!verifiedReaderPeriods(shadow.evidence,input.text,input.asOf))return null;
  // The read limit counts failed and rejected reader invocations too.
  const invokedReads=shadow.attemptedReads;
  const ownerHistory=(input.history??[]).filter(h=>h.role==="owner")
    .slice(-3).map(h=>h.text.slice(0,650));
  const expanded=await enrichResolvedProductEconomics({
    goal:input.text,scope,registry:capabilityRegistry,evidence:shadow.evidence,
    remainingReads:Math.max(0,4-invokedReads),ownerHistory,
  });
  reported.toolCallCount+=expanded.readCount;
  input.onUsage?.({...reported});
  // Every P1 selector was fetched inside the epoch bracket. A final
  // authoritative reread must match this revision before any response.
  const projection=projectP1Evidence(expanded.evidence,identity.businessId,input.text,
    null,ownerHistory,atomic.status==="available"?atomic.snapshot:undefined);
  // Validated pure owner-hypothetical arithmetic may need no café source.
  // It must declare no_external_sources; it can never be labeled observed.
  // P3 permits multiple independently authorized readers for ONE semantic
  // clause. Composition completeness counts owner goals, not reader count.
  const clauses=[...new Set(shadow.evidence.map(x=>x.clause))];
  // Count even provider failures/invalid JSON as consumed model attempts;
  // the caller never restarts a fresh full-budget legacy turn after P3.
  reported.modelCallCount++;
  input.onUsage?.({...reported});
  const completion=await modelComposition({
    goal:input.text,clauses,
    history:(input.history??[]).slice(-6).map(h=>({
      role:h.role==="owner"?"owner" as const:"assistant" as const,
      text:h.text.slice(0,450),
    })),
    model:input.model,apiKey:input.apiKey,
    transport:input.transport,
    readableSourceClauses:[...new Set(shadow.evidence.filter(read=>
      ["verified","estimated","partial"].includes(read.status) &&
      read.capabilityId!==null && read.result!==null &&
      !shadow.evidence.some(sibling=>sibling.clause===read.clause &&
        sibling.capabilityId!==null && sibling.status==="unavailable"))
      .map(read=>read.clause))],
    operands:projection.choices.map(choice=>{
      const v=projection.operands.find(o=>o.handle===choice.handle)!;
      return {...choice,unit:v.unit,
        sourceQuality:v.status+(v.sourceRevision?"":"_revision_unavailable")};
    }),
  });
  if(completion){
    reported.inputTokens+=completion.tokens.input;
    reported.outputTokens+=completion.tokens.output;
    input.onUsage?.({...reported});
  }
  if(!completion?.plan.complete||
    !exactCoverage(clauses,completion.plan.plans))return null;
  const outcomes:ExpressionOutcome[]=[];
  const calculationInputs:unknown[]=[];
  let unsupportedGoals=0;
  const unsupportedReasons=new Set<"unsupported"|"missing_input"|"unsupported_action">();
  const incompleteReadClauses=new Set<string>();
  const plainReadClauses=new Set<string>();
  const plannedSimulations=completion.plan.plans.filter(p=>p.planJson!==null).length;
  if(reported.toolCallCount+plannedSimulations>5)return null;
  for(const item of completion.plan.plans){
    if(!item.planJson){
      if(!item.reason)return null;
      unsupportedGoals+=item.coveredClauses.length;
      if(item.reason==="read_only"){
        for(const clause of item.coveredClauses){
          plainReadClauses.add(clause);
          // A source-backed preview of one successful sibling must not hide
          // that another owner-requested source for the same clause failed.
          if(shadow.evidence.some(read=>read.clause===clause &&
            read.capabilityId!==null && read.status==="unavailable"))
            unsupportedReasons.add("missing_input");
        }
      }else unsupportedReasons.add(item.reason);
      continue;
    }
    // A multi-read clause may require more than one canonical source (e.g.
    // wage AND employer burden). The model cannot turn its one successful
    // source into a "complete" scenario after a second requested read fails.
    // Keep other independent clauses eligible for separate, partial answers.
    if(item.coveredClauses.some(clause=>shadow.evidence.some(read=>
      read.clause===clause && read.capabilityId!==null &&
      read.status==="unavailable"))){
      unsupportedGoals+=item.coveredClauses.length;
      unsupportedReasons.add("missing_input");
      for(const clause of item.coveredClauses)if(shadow.evidence.some(read=>
        read.clause===clause&&read.capabilityId!==null&&
        read.status==="unavailable"&&
        shadow.evidence.some(sibling=>sibling.clause===clause&&
          ["verified","estimated","partial"].includes(sibling.status))))
        incompleteReadClauses.add(clause);
      continue;
    }
    let raw:unknown;
    try{raw=JSON.parse(item.planJson);}catch{return null;}
    const plan=planSchema.safeParse(raw);
    if(!plan.success)return null;
    // Model-supplied numeric occurrences refer to the ORIGINAL owner utterance.
    // Rebase each value to precisely the covered audited clauses, denying any
    // number whose original occurrence was in a different request clause.
    const coveredOrdered=clauses.filter(clause=>
      item.coveredClauses.includes(clause));
    const scopedNodes:typeof plan.data.nodes=[];
    for(const node of plan.data.nodes){
      if(node.op==="hypothetical"&&node.occurrence!==undefined){
        const local=rebaseQuotedOccurrence({
          goal:input.text,allClauses:clauses,coveredClauses:coveredOrdered,
          quotedNumber:node.quotedNumber,occurrence:node.occurrence,
        });
        if(local===null)return null;
        scopedNodes.push({...node,occurrence:local});
      }else scopedNodes.push(node);
    }
    const scopedPlan={...plan.data,nodes:scopedNodes};
    const pure=plan.data.purpose==="no_external_sources";
    // Source-free classification is PER CLAUSE, not per overall turn:
    // a café-backed clause may coexist with a pure quoted arithmetic clause.
    // The pure expression still receives EMPTY bindings and operands below.
    if(pure && !item.coveredClauses.every(clause=>shadow.evidence.some(e=>
      e.clause===clause&&e.reason==="source_free")))return null;
    if(!pure && item.coveredClauses.some(clause=>shadow.evidence.some(e=>
      e.clause===clause&&e.reason==="source_free")))return null;
    // A source handle is authorized only for the actual clause that names its
    // record. Never apply Ahmed's wage to Sophie's clause just because both
    // names appear elsewhere in the same utterance. A multi-clause plan can
    // intentionally combine the union of its own covered clauses.
    const allowedHandles=new Set(projection.choices.filter(choice=>
      item.coveredClauses.includes(choice.matchedClause)).map(choice=>choice.handle));
    const requestedHandles=plan.data.nodes.flatMap(node=>
      node.op==="source"?[node.handle]:[]);
    if(!pure&&requestedHandles.some(handle=>!allowedHandles.has(handle)))return null;
    const allowedOperands=pure?[]:projection.operands.filter(operand=>
      allowedHandles.has(operand.handle));
    const allowedBindings=pure?[]:projection.bindings.filter(binding=>
      allowedOperands.some(operand=>operand.capabilityId===binding.capabilityId));
    // All registered simulations consume the same five-tool turn budget.
    if(reported.toolCallCount>=5)return null;
    reported.toolCallCount++;
    input.onUsage?.({...reported});
    const simulated=await capabilityRegistry.invokeSimulation(scope,EXPRESSION_ID,scopedPlan,{
      // A hypothetical belongs to the clauses covered by THIS plan. Checking
      // the full owner turn would let a plan borrow another clause's number.
      businessId:identity.businessId,locationId:null,
      ownerMessage:coveredOrdered.join(" "),
      currency:"USD",bindings:allowedBindings,
      operands:allowedOperands,
    });
    const checked=simulationOutputSchema.safeParse(simulated);
    if(!checked.success||checked.data.status==="unavailable")return null;
    const outcome=checked.data as ExpressionOutcome;
    outcomes.push(outcome);
    calculationInputs.push({
      plan:scopedPlan,
      // Actual source values and revisions enter the opaque digest; no private
      // records or unverified values are exposed in the response identifier.
      sources:pure?[]:projection.operands.filter(o=>
        outcome.sourceHandles.includes(o.handle)),
    });
  }
  const locale=labels[input.locale];
  // Each read comes from the existing model-selected, server-registered P1
  // source. A read-only clause can show bounded provisional source evidence
  // even when it cannot be represented by the expression engine. Keep this
  // separate from canonical atomic financial/scheduling calculations.
  const presentedReads=presentRegisteredReads({
    evidence:shadow.evidence,
    includedClauses:[...completion.plan.plans.filter(p=>
      p.planJson===null&&p.reason==="unsupported")
      .flatMap(p=>p.coveredClauses),...incompleteReadClauses,...plainReadClauses],
    businessId:identity.businessId,asOf:identity.asOf,locale:input.locale,
  });
  if(plainReadClauses.size && !presentedReads.blocks.length)
    unsupportedReasons.add("missing_input");
  // A complete audit of an unsupported or incomplete request is an honest
  // answer, not a reason to exhaust the legacy model budget and hallucinate.
  // A request with no successful computation must never claim a scenario result.
  if(!outcomes.length){
    if(unsupportedGoals!==clauses.length)return null;
    // Do not show a stale earlier read when the PostgreSQL source epoch moved.
    if(atomic.status==="available"){
      const latest=await readAuthorizedAtomicP1SourceSnapshot();
      if(latest.status!=="available" ||
        latest.snapshot.businessId!==atomic.snapshot.businessId ||
        latest.snapshot.revision!==atomic.snapshot.revision)
        return sourceIntegrityFailure();
    }
    const warnings=[...unsupportedReasons].map(reason=>({
      type:"warning" as const,code:"P3_"+reason.toUpperCase(),
      text:registeredReadReason(input.locale,reason),
    }));
    return {kind:"p3_read_only_conditional",executedEffects:0,
      reply:{intent:"unknown",status:presentedReads.blocks.length?"partial":"unavailable",
        evidence:presentedReads.evidence,
        blocks:[...presentedReads.blocks,...warnings].slice(0,30)},
      usage:{model:input.model,modelCallCount:shadow.usage.modelCalls+1,
        toolCallCount:reported.toolCallCount,
        inputTokens:shadow.usage.inputTokens+completion.tokens.input,
        outputTokens:shadow.usage.outputTokens+completion.tokens.output},
    };
  }
  const blocks:SupervisorReplyBlock[]=[
    {type:"warning",code:"P3_CONDITIONAL",text:locale.conditional},
    ...presentedReads.blocks,
  ];
  for(const reason of unsupportedReasons)blocks.push({
    type:"warning",code:"P3_"+reason.toUpperCase(),
    text:registeredReadReason(input.locale,reason),
  });
  const refs:EvidenceReference[]=[...presentedReads.evidence];
  for(let i=0;i<outcomes.length;i++){
    const v=outcomes[i],id=createHash("sha256").update(
      JSON.stringify({goal:input.text,inputs:calculationInputs[i],
        output:{value:v.value,unit:v.unit,sourceHandles:v.sourceHandles}}),
    ).digest("hex").slice(0,32);
    const evidence:EvidenceReference={source:"cafe_state",identifier:"p3:"+id,
      asOf:input.asOf};
    // A pure owner-only hypothetical is not a café-state observation.
    // Never attach a business-evidence reference to source-free arithmetic.
    const usesCafeSource=v.sourceHandles.length>0;
    // An observed period is part of the source selection, not a display-only
    // attribute. Expose the trusted read window beside each calculated value
    // so multi-period requests cannot confuse one period's result for another.
    const periodKeys=[...new Set(projection.operands.filter(o=>
      v.sourceHandles.includes(o.handle)&&o.period).map(o=>
        o.period!.from+" / "+o.period!.to))];
    const periodLabel=periodKeys.length===1?" ("+periodKeys[0]+")":"";
    if(usesCafeSource)refs.push(evidence);
    if(usesCafeSource&&v.unit==="USD_cents"&&v.value!==null)
      blocks.push({type:"metric",label:locale.money+periodLabel,
        valueCents:v.value,source:evidence});
    else if(v.value!==null&&v.unit)
      blocks.push({type:"text",text:locale.number+periodLabel+": "+
        formatScenarioValue(v.value,v.unit,input.locale)});
    // Server-created explanation: no model-authored labels or untrusted
    // source-record prose is rendered as a verified business fact.
    const formula=v.formula.map(step=>formatScenarioFormula(step,input.locale))
      .join(" → ");
    blocks.push({type:"text",text:(locale.formula+": "+formula).slice(0,1100)});
    if(v.assumptions.length)blocks.push({type:"text",
      text:(locale.assumptions+": "+v.assumptions.slice(0,6)
        .map(s=>formatScenarioAssumption(s,input.locale)).filter(Boolean)
        .join("; ")).slice(0,1100)});
    if(v.missingInputs.length){
      // Missing-input identifiers and source handles are private implementation
      // metadata. Only trusted localized explanations reach the owner.
      blocks.push({type:"warning",code:"P3_SOURCE_LIMITATIONS",
        text:locale.incomplete+" "+locale.missing});
      blocks.push({type:"warning",code:"P3_BASELINE",text:locale.baseline});
    }
  }
  if(blocks.length>30)return null;
  if(atomic.status==="available"){
    // Concurrent owner/import updates must not silently make this answer
    // appear current. A second single-statement RPC checks the epoch only;
    // no facts from that later statement are mixed with the first snapshot.
    const latest=await readAuthorizedAtomicP1SourceSnapshot();
    if(latest.status!=="available"||
      latest.snapshot.businessId!==atomic.snapshot.businessId||
      latest.snapshot.revision!==atomic.snapshot.revision)return sourceIntegrityFailure();
  }
  return {kind:"p3_read_only_conditional",executedEffects:0,
    reply:{intent:"profitability",status:"partial",evidence:refs,blocks},
    usage:{model:input.model,modelCallCount:shadow.usage.modelCalls+1,
      toolCallCount:reported.toolCallCount,
      inputTokens:shadow.usage.inputTokens+completion.tokens.input,
      outputTokens:shadow.usage.outputTokens+completion.tokens.output},
  };
}
