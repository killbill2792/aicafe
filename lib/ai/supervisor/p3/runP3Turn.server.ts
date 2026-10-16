import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GroundedSupervisorReply,EvidenceReference,SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";
import { SUPERVISOR_ENDPOINT,supervisorModelProfile } from
  "@/lib/ai/conversations/supervisorRequest.mjs";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";
import { runP2ShadowWithScope } from "@/lib/ai/supervisor/p2/shadow.server";
import { createP3ReadRegistry } from "./sourceRegistry.server";
import { projectP1Evidence } from "./operandProjection.server";
import { enrichResolvedProductEconomics } from "./productEconomicsAdapter.server";
import { EXPRESSION_ID,planSchema,type ExpressionOutcome } from "./expression";
import { simulationOutputSchema } from "./simulateRegistration.server";
import { formatScenarioValue,formatScenarioAssumption,formatScenarioFormula } from "./formatScenario";
import type { ConversationalTurn } from "@/lib/ai/conversations/context";

type Transport=(url:string,init:RequestInit)=>Promise<Response>;
const coverage=z.strictObject({
  complete:z.boolean(),
  plans:z.array(z.strictObject({
    coveredClauses:z.array(z.string().min(2).max(1000)).min(1).max(5),
    planJson:z.string().max(6000).nullable(),reason:z.enum([
      "unsupported","missing_input","unsupported_action"]).nullable(),
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
          "unsupported","missing_input","unsupported_action",null]},
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
  }>;model:string;apiKey:string;transport:Transport;
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
          "ratio, scenario_delta, compare, convert. Use handles ONLY from authorized list.",
          "Use units exactly as supplied for sources; do not make up source values.",
          "Each opaque source handle is bound to a verified entityName, entityId,",
          "field and matchedClause. Match requested names to these bindings,",
          "never guess employee/product identity from a UUID or reverse records.",
          "For hypothetical nodes copy the exact owner-quoted substring as quotedNumber",
          "and provide an integer value. For fractional nonmoney quantities (e.g. 1.5",
          "hours), use quantityScale hundredth and value 150 to retain exact units.",
          "For money nodes use integer cents. Default quoted money is in dollars.",
          "When and ONLY when owner explicitly wrote cents/centavos/¢, include",
          "quotedDenomination cents and use the quoted integer amount in cents.",
          "Never reinterpret cents as dollars or invent a denomination.",
          "Never claim observed sales, actual wages, source revisions, approvals or effects.",
          "Never use SQL, JavaScript, executors, hidden reads or new domain capabilities.",
          "If the requested outcome lacks the necessary operands, choose null and missing_input.",
          "Writes or approvals are unsupported_action. Do not present a partial subtraction",
          "of revenue and wages as verified profit when ingredients/fees are missing.",
        ].join(" "),
        input:[{role:"user",content:JSON.stringify({
          goal:input.goal,clauses:input.clauses,
          recentConversationContext:input.history.slice(-6).map(h=>({
            role:h.role,text:h.text.slice(0,450),
          })),
          authorizedOperandChoices:input.operands,
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
  const dates=[...text.matchAll(/(?<![\\d])\\d{4}-\\d{2}-\\d{2}(?![\\d])/gu)].map(x=>x[0]);
  if(dates.length===1)return {from:dates[0],to:dates[0]};
  if(dates.length===2&&dates[0]<=dates[1])return {from:dates[0],to:dates[1]};
  if(dates.length>2)return null;
  const normalized=text.normalize("NFKC").toLocaleLowerCase();
  if(/\\b(?:today|hoy)\\b|اليوم/u.test(normalized))
    return {from:asOf,to:asOf};
  if(/\\b(?:yesterday|ayer)\\b|أمس/u.test(normalized)){
    const day=new Date(asOf+"T12:00:00Z");
    if(Number.isNaN(day.getTime()))return null;
    day.setUTCDate(day.getUTCDate()-1);
    const date=day.toISOString().slice(0,10);
    return {from:date,to:date};
  }
  return null;
}
function verifiedReaderPeriods(evidence:readonly {clause:string;result:unknown}[],
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
  const {tools,identity}=await authorizedOwnerP1();
  const allowed=(process.env.SUPERVISOR_P3_ALLOWED_BUSINESS_IDS??"")
    .split(",").map(id=>id.trim()).filter(Boolean);
  // Compatibility requires BOTH the default-off feature flag at the caller
  // and an explicit authenticated selected-business allowlist.
  if(!identity.businessId||!allowed.includes(identity.businessId)||
    !input.apiKey||identity.currency!=="USD")return null;
  const scope={role:"owner" as const,businessId:identity.businessId,
    identity:{...identity},tools,shadowEnabled:true};
  const capabilityRegistry=createP3ReadRegistry();
  if(!capabilityRegistry.discoverSimulations(scope).some(x=>x.id===EXPRESSION_ID))
    return null;
  const shadow=await runP2ShadowWithScope({
    goal:input.text,scope,registry:capabilityRegistry,
    apiKey:input.apiKey,model:input.model,transport:input.transport,
    allowSourceFree:true,history:(input.history??[]).slice(-6).map(h=>({
      role:h.role==="owner"?"owner" as const:"assistant" as const,
      text:h.text.slice(0,450),
    })),
  });
  const reported={
    model:input.model,modelCallCount:shadow.usage.modelCalls,
    toolCallCount:shadow.attemptedReads,
    inputTokens:shadow.usage.inputTokens,outputTokens:shadow.usage.outputTokens,
  };
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
  const projection=projectP1Evidence(expanded.evidence,identity.businessId,input.text,
    null,ownerHistory);
  // Validated pure owner-hypothetical arithmetic may need no café source.
  // It must declare no_external_sources; it can never be labeled observed.
  const clauses=shadow.evidence.map(x=>x.clause);
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
  const plannedSimulations=completion.plan.plans.filter(p=>p.planJson!==null).length;
  if(reported.toolCallCount+plannedSimulations>5)return null;
  for(const item of completion.plan.plans){
    if(!item.planJson){
      if(!item.reason)return null;
      unsupportedGoals+=item.coveredClauses.length;
      unsupportedReasons.add(item.reason);
      continue;
    }
    let raw:unknown;
    try{raw=JSON.parse(item.planJson);}catch{return null;}
    const plan=planSchema.safeParse(raw);
    if(!plan.success)return null;
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
    const simulated=await capabilityRegistry.invokeSimulation(scope,EXPRESSION_ID,raw,{
      businessId:identity.businessId,locationId:null,ownerMessage:input.text,
      currency:"USD",bindings:allowedBindings,
      operands:allowedOperands,
    });
    const checked=simulationOutputSchema.safeParse(simulated);
    if(!checked.success||checked.data.status==="unavailable")return null;
    const outcome=checked.data as ExpressionOutcome;
    outcomes.push(outcome);
    calculationInputs.push({
      plan:plan.data,
      // Actual source values and revisions enter the opaque digest; no private
      // records or unverified values are exposed in the response identifier.
      sources:pure?[]:projection.operands.filter(o=>
        outcome.sourceHandles.includes(o.handle)),
    });
  }
  const locale=labels[input.locale];
  const reasonText={
    en:{unsupported:"The requested information is not supported by a registered read capability.",
      missing_input:"Required records or inputs are missing; I cannot calculate a reliable result.",
      unsupported_action:"This action requires an authorized, separate approval workflow; nothing was changed."},
    es:{unsupported:"No existe una capacidad de lectura registrada para esta información.",
      missing_input:"Faltan registros o datos necesarios para un cálculo fiable.",
      unsupported_action:"Esta acción requiere un flujo separado de aprobación; no se ha cambiado nada."},
    ar:{unsupported:"لا توجد قدرة قراءة مسجلة لهذه المعلومات.",
      missing_input:"البيانات أو السجلات المطلوبة ناقصة، ولا يمكن حساب نتيجة موثوقة.",
      unsupported_action:"يتطلب هذا الإجراء مسار موافقة منفصلًا؛ لم يتم تغيير أي شيء."},
  }[input.locale];
  // A complete audit of an unsupported or incomplete request is an honest
  // answer, not a reason to exhaust the legacy model budget and hallucinate.
  // A request with no successful computation must never claim a scenario result.
  if(!outcomes.length){
    if(unsupportedGoals!==clauses.length)return null;
    return {kind:"p3_read_only_conditional",executedEffects:0,
      reply:{intent:"unknown",status:"unavailable",evidence:[],
        blocks:[...unsupportedReasons].map(reason=>({
          type:"warning" as const,code:"P3_"+reason.toUpperCase(),
          text:reasonText[reason],
        }))},
      usage:{model:input.model,modelCallCount:shadow.usage.modelCalls+1,
        toolCallCount:reported.toolCallCount,
        inputTokens:shadow.usage.inputTokens+completion.tokens.input,
        outputTokens:shadow.usage.outputTokens+completion.tokens.output},
    };
  }
  const blocks:SupervisorReplyBlock[]=[
    {type:"warning",code:"P3_CONDITIONAL",text:locale.conditional},
  ];
  for(const reason of unsupportedReasons)blocks.push({
    type:"warning",code:"P3_"+reason.toUpperCase(),text:reasonText[reason],
  });
  const refs:EvidenceReference[]=[];
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
    if(usesCafeSource)refs.push(evidence);
    if(usesCafeSource&&v.unit==="USD_cents"&&v.value!==null)
      blocks.push({type:"metric",label:locale.money,valueCents:v.value,source:evidence});
    else if(v.value!==null&&v.unit)
      blocks.push({type:"text",text:locale.number+": "+
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
  return {kind:"p3_read_only_conditional",executedEffects:0,
    reply:{intent:"profitability",status:"partial",evidence:refs,blocks},
    usage:{model:input.model,modelCallCount:shadow.usage.modelCalls+1,
      toolCallCount:reported.toolCallCount,
      inputTokens:shadow.usage.inputTokens+completion.tokens.input,
      outputTokens:shadow.usage.outputTokens+completion.tokens.output},
  };
}
