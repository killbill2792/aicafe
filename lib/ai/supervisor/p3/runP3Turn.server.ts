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
import { evaluateExpression,planSchema,type ExpressionOutcome } from "./expression";

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
  goal:string;clauses:string[];operands:Array<{
    handle:string;unit:string;sourceQuality:string;
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
          "For hypothetical nodes include exact owner-quoted numeric substring as quotedNumber",
          "and integer value; money source-unit hypothetical values are integer cents.",
          "Never claim observed sales, actual wages, source revisions, approvals or effects.",
          "Never use SQL, JavaScript, executors, hidden reads or new domain capabilities.",
          "If the requested outcome lacks the necessary operands, choose null and missing_input.",
          "Writes or approvals are unsupported_action. Do not present a partial subtraction",
          "of revenue and wages as verified profit when ingredients/fees are missing.",
        ].join(" "),
        input:[{role:"user",content:JSON.stringify({
          goal:input.goal,clauses:input.clauses,
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
const labels={
  en:{conditional:"Conditional what-if, not a demand forecast or verified profit.",
    incomplete:"Some source records are missing, provisional or lack a stable revision.",
    money:"Conditional scenario change",number:"Calculated scenario result",
    unsupported:"This request needs additional authorized data or later-stage approval."},
  es:{conditional:"Escenario condicional, no pronóstico de demanda ni beneficio verificado.",
    incomplete:"Faltan datos, son provisionales o no tienen revisión verificable.",
    money:"Cambio condicional del escenario",number:"Resultado calculado del escenario",
    unsupported:"Se necesitan más datos autorizados o aprobación en una fase posterior."},
  ar:{conditional:"سيناريو مشروط، وليس توقعًا للطلب أو ربحًا مؤكّدًا.",
    incomplete:"بعض السجلات مفقودة أو مؤقتة أو دون مراجعة موثوقة.",
    money:"التغيّر المشروط في السيناريو",number:"نتيجة السيناريو المحسوبة",
    unsupported:"يلزم توفر بيانات مأذون بها أو موافقة في مرحلة لاحقة."},
};
/** A server-authenticated owner read path only, off by default at its caller. */
export async function tryP3SupervisorReadOnly(input:{
  text:string;locale:"en"|"es"|"ar";asOf:string;timezone:string;
  apiKey:string;model:string;transport:Transport;
}):Promise<P3Result|null>{
  const {tools,identity}=await authorizedOwnerP1();
  if(!identity.businessId||!input.apiKey||identity.currency!=="USD")return null;
  const scope={role:"owner" as const,businessId:identity.businessId,
    identity:{...identity},tools,shadowEnabled:true};
  const shadow=await runP2ShadowWithScope({
    goal:input.text,scope,registry:createP3ReadRegistry(),
    apiKey:input.apiKey,model:input.model,transport:input.transport,
  });
  if(!shadow.evidence.length)return null;
  const projection=projectP1Evidence(shadow.evidence,identity.businessId,input.text);
  if(!projection.operands.length)return null;
  const clauses=shadow.evidence.map(x=>x.clause);
  const completion=await modelComposition({
    goal:input.text,clauses,model:input.model,apiKey:input.apiKey,
    transport:input.transport,
    operands:projection.operands.map(v=>({
      handle:v.handle,unit:v.unit,
      sourceQuality:v.status+(v.sourceRevision?"":"_revision_unavailable"),
    })),
  });
  if(!completion?.plan.complete||
    !exactCoverage(clauses,completion.plan.plans))return null;
  const outcomes:ExpressionOutcome[]=[];
  for(const item of completion.plan.plans){
    if(!item.planJson)return null;
    let raw:unknown;
    try{raw=JSON.parse(item.planJson);}catch{return null;}
    if(!planSchema.safeParse(raw).success)return null;
    const value=evaluateExpression(raw,{
      businessId:identity.businessId,locationId:null,ownerMessage:input.text,
      currency:"USD",bindings:projection.bindings,operands:projection.operands,
    });
    if(value.status==="unavailable")return null;
    outcomes.push(value);
  }
  const locale=labels[input.locale],blocks:SupervisorReplyBlock[]=[
    {type:"warning",code:"P3_CONDITIONAL",text:locale.conditional},
  ];
  const refs:EvidenceReference[]=[];
  for(let i=0;i<outcomes.length;i++){
    const v=outcomes[i],id=createHash("sha256").update(
      JSON.stringify({source:v.sourceHandles,formula:v.formula,goal:input.text}),
    ).digest("hex").slice(0,32);
    const evidence:EvidenceReference={source:"cafe_state",identifier:"p3:"+id,
      asOf:input.asOf};
    refs.push(evidence);
    if(v.unit==="USD_cents"&&v.value!==null)
      blocks.push({type:"metric",label:locale.money,valueCents:v.value,source:evidence});
    else if(v.value!==null&&v.unit)
      blocks.push({type:"text",text:locale.number+": "+String(v.value)+" "+v.unit});
    if(v.missingInputs.length)blocks.push({
      type:"warning",code:"P3_SOURCE_LIMITATIONS",text:locale.incomplete,
    });
  }
  if(blocks.length>30)return null;
  return {kind:"p3_read_only_conditional",executedEffects:0,
    reply:{intent:"profitability",status:"partial",evidence:refs,blocks},
    usage:{model:input.model,modelCallCount:shadow.usage.modelCalls+1,
      toolCallCount:shadow.evidence.filter(x=>x.result!==null).length,
      inputTokens:shadow.usage.inputTokens+completion.tokens.input,
      outputTokens:shadow.usage.outputTokens+completion.tokens.output},
  };
}
