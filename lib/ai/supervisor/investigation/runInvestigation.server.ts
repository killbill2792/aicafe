import "server-only";
import {z} from "zod";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {buildAlexPricingRegistrations} from "@/lib/pricing/alexCapabilities.server";
import {buildOliviaInvestigationRegistration} from "@/lib/scheduling/oliviaInvestigation.server";
import {buildAlexP3Registrations} from "@/lib/pricing/alexP3Capabilities.server";
import {buildOliviaP3Registrations} from "@/lib/scheduling/oliviaP3Capabilities.server";
import {investigationReadDatesMatch,rememberInvestigationReads} from "./readDates";
import {investigationMemorySchema,investigationOwnerStatements,type InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
import type {ConversationalTurn} from "@/lib/ai/conversations/context";
import type {GroundedSupervisorReply} from "@/lib/ai/conversations/contracts";
import {createP3ReadRegistry} from "../p3/sourceRegistry.server";
import {projectP1Evidence} from "../p3/operandProjection.server";
import {EXPRESSION_ID,planSchema} from "../p3/expression";
import {simulationOutputSchema} from "../p3/simulateRegistration.server";
import {formatScenarioValue} from "../p3/formatScenario";
import type {ShadowEvidence} from "../p2/shadow.server";
import {buildDatasetRegistration,datasetFor,type StoredDataset} from "./datasets.server";
import {datasetOperands} from "./calculations.server";
import {buildRecordsRegistration,recordCollections,RECORDS_ID} from "./records.server";
import {buildResearchRegistration} from "./research.server";
import {observationDisplay,observationReference,investigationLabels,investigationReply,
  renderInvestigationAnswer,type Observation,type Locale} from "./evidence";
import {stepSchema,answerSchema,reviewSchema,INVESTIGATION_LIMITS} from "./protocol";
import {requestInvestigation,type InvestigationTransport,type InvestigationUsage} from "./model.server";
import {investigationInstructions,reviewInstructions} from "./instructions";

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** Bound the MODEL preview, not the authoritative dataset used by calculators.
 * Full source results remain server-side and are hashed in evidence references. */
function preview(v:unknown,depth=0):unknown{
  if(depth>7)return "[nested data omitted]";
  if(Array.isArray(v))return v.slice(0,12).map(x=>preview(x,depth+1));
  if(record(v))return Object.fromEntries(Object.entries(v).slice(0,50).map(([k,x])=>[k,preview(x,depth+1)]));
  return typeof v==="string"?v.slice(0,600):v;
}
function calendar(asOf:string){
  const add=(n:number)=>new Date(Date.parse(asOf+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
  const monday=add(-((new Date(asOf+"T12:00:00Z").getUTCDay()+6)%7));
  const nextMonday=new Date(Date.parse(monday+"T12:00:00Z")+7*86400000).toISOString().slice(0,10);
  return {today:asOf,yesterday:add(-1),thisMonday:monday,nextMonday,
    monthToDate:{from:asOf.slice(0,8)+"01",to:asOf},lastSevenDays:{from:add(-6),to:asOf}};
}
export type InvestigationInput={text:string;locale:Locale;asOf:string;timezone:string;
  history:ConversationalTurn[];investigationMemory?:InvestigationMemory;
  apiKey:string;model:string;onUsage?:(usage:InvestigationUsage)=>void};
export async function runInvestigationTurn(input:InvestigationInput,transport:InvestigationTransport):
  Promise<{reply:GroundedSupervisorReply;usage:InvestigationUsage}>{
  const deadline=Date.now()+INVESTIGATION_LIMITS.elapsedMs;
  const usage:InvestigationUsage={model:input.model,modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0};
  const labels=investigationLabels(input.locale);
  const failure=(budget=false)=>({reply:{intent:"unknown" as const,status:"unavailable" as const,evidence:[],
    blocks:[{type:"warning" as const,code:budget?"SUPERVISOR_INVESTIGATION_LIMIT":"SUPERVISOR_INVESTIGATION_UNAVAILABLE",
      text:budget?labels.budget:labels.unavailable}]},usage:{...usage}});
  const {identity,tools}=await authorizedOwnerP1();
  if(!identity.businessId||identity.asOf!==input.asOf||identity.timezone!==input.timezone||!input.apiKey)return failure();
  const parsedMemory=investigationMemorySchema.safeParse(input.investigationMemory);
  const memory=parsedMemory.success&&parsedMemory.data.businessId===identity.businessId?parsedMemory.data:undefined;
  // Only authenticated same-thread owner statements can ground referents or hypotheticals.
  const ownerStatements=investigationOwnerStatements(memory,input.history,input.text);
  const scope={role:"owner" as const,businessId:identity.businessId,identity,tools,shadowEnabled:true,
    ownerClause:input.text,ownerContext:ownerStatements.join("\n")};
  const datasets=new Map<string,StoredDataset>();
  const registry=createP3ReadRegistry([...buildAlexP3Registrations(),...buildOliviaP3Registrations(),
    buildAlexPricingRegistrations()[0],buildOliviaInvestigationRegistration(),
    buildDatasetRegistration(datasets,identity.businessId),buildRecordsRegistration(()=>observations,identity.businessId),buildResearchRegistration(()=>[
      input.text,
      ...observations.filter(o=>o.result.id==="business.profile").flatMap(o=>{
        const value=o.result.value;
        return record(value)&&Array.isArray(value.locations)?value.locations.filter(record)
          .flatMap(l=>[l.city,l.region,l.countryCode].filter((v):v is string=>typeof v==="string")):[];
      }),
    ].join(" "))]);
  const manifest=registry.discover(scope);
  const observations:Observation[]=[],evidence:ShadowEvidence[]=[],remembered:InvestigationMemory["reads"]=[];
  const attempted=new Set<string>();
  let feedback:string|null=null;
  const atomic=await readAuthorizedAtomicP1SourceSnapshot();
  if(atomic.status==="unavailable"&&atomic.reason!=="rpc_not_installed")return failure();
  if(atomic.status==="available"&&(atomic.snapshot.businessId!==identity.businessId||
    atomic.snapshot.currency!==identity.currency||atomic.snapshot.timezone!==identity.timezone))return failure();
  for(let round=0;usage.modelCallCount<INVESTIGATION_LIMITS.modelCalls-1&&Date.now()<deadline;round++){
    const projection=projectP1Evidence(evidence,identity.businessId,input.text,null,ownerStatements,undefined,"authorized_selection",120);
    const aggregates=datasetOperands(observations,scope);
    const operands=[...projection.operands,...aggregates.operands];
    const bindings=[...projection.bindings,...aggregates.bindings];
    const views=observations.map(o=>({id:o.id,capabilityId:o.capabilityId,input:o.input,
      result:preview(o.result),displayTokens:Object.fromEntries(Object.entries(o.display).slice(0,100)),
      datasetFields:o.datasetFields,collections:recordCollections(o.result.value),previewOnly:true}));
    if(Buffer.byteLength(JSON.stringify(views))>INVESTIGATION_LIMITS.observationsBytes)return failure(true);
    const step=await requestInvestigation({name:"supervisor_investigation_step",schema:stepSchema,
      instructions:investigationInstructions,context:{ownerRequest:input.text,locale:input.locale,
        calendar:calendar(identity.asOf),timezone:identity.timezone,currency:identity.currency,
        ownerStatements,previousConversation:input.history.slice(-6),rememberedSelectors:memory?.reads??[],
        capabilities:manifest.map(m=>({id:m.id,purpose:m.purpose,inputSchema:m.inputJsonSchema})),
        capabilityLimitations:{inventory:"No verified stock count or inventory feed is connected.",
          writes:"Business mutations and publication are not executable in this read/simulation conversation."},
        observations:views,authorizedOperands:operands.map(o=>({handle:o.handle,unit:o.unit,period:o.period,
          sourceId:o.sourceId,sourceQuality:o.status,entity:projection.choices.find(c=>c.handle===o.handle)?.entityName})),
        remainingOperations:INVESTIGATION_LIMITS.operations-usage.toolCallCount,feedback},
      apiKey:input.apiKey,model:input.model,transport,usage,deadline,onUsage:input.onUsage});
    if(!step)return failure();
    feedback=null;
    if(step.action==="answer"){
      if(step.capabilityId!==null||step.argumentsJson!==null||!step.responseJson){feedback="Invalid answer envelope; use responseJson only.";continue;}
      let raw:unknown;try{raw=JSON.parse(step.responseJson);}catch{feedback="Answer JSON could not be read.";continue;}
      const answer=answerSchema.safeParse(raw);
      if(!answer.success){feedback="Answer paragraphs did not match the typed contract.";continue;}
      const rendered=renderInvestigationAnswer(answer.data,observations,input.locale);
      const reply=investigationReply(answer.data,observations,input.locale);
      if(!rendered||!reply){feedback="Use exact supplied display tokens for numbers/dates/URLs and valid evidence citations. Advice is not a café observation.";continue;}
      const review=await requestInvestigation({name:"supervisor_investigation_review",schema:reviewSchema,
        instructions:reviewInstructions,context:{ownerRequest:input.text,ownerStatements,observations:views,
          proposedAnswer:answer.data,renderedAnswer:rendered.blocks},apiKey:input.apiKey,model:input.model,
        transport,usage,deadline,onUsage:input.onUsage});
      if(!review?.supported||!review.complete){feedback="The answer failed independent evidence or full-goal coverage review. Correct it or ask the specific unresolved question.";continue;}
      // Reauthorize at publication time. A changed café or epoch invalidates the
      // investigation; no data from the later snapshot is mixed with earlier reads.
      const latestOwner=await authorizedOwnerP1();
      if(latestOwner.identity.businessId!==identity.businessId||latestOwner.identity.timezone!==identity.timezone||
        latestOwner.identity.currency!==identity.currency||latestOwner.identity.asOf!==identity.asOf)return failure();
      if(atomic.status==="available"&&observations.some(o=>o.reference)){
        const latest=await readAuthorizedAtomicP1SourceSnapshot();
        if(latest.status!=="available"||latest.snapshot.businessId!==identity.businessId||
          latest.snapshot.revision!==atomic.snapshot.revision)return failure();
      }
      const state:InvestigationMemory={version:1,businessId:identity.businessId,ownerStatements,
        reads:rememberInvestigationReads(memory?.reads??[],remembered)};
      return {reply:{...reply,investigationMemory:state},usage:{...usage}};
    }
    if(usage.toolCallCount>=INVESTIGATION_LIMITS.operations){feedback="No operations remain. Give a partial answer or the specific missing input from observations.";continue;}
    usage.toolCallCount++;
    input.onUsage?.({...usage});
    let args:unknown;try{args=JSON.parse(step.argumentsJson??"");}catch{feedback="Tool arguments must be valid JSON.";continue;}
    if(!step.capabilityId||step.responseJson!==null){feedback="Tool steps require a capability and argumentsJson, not a response.";continue;}
    const signature=JSON.stringify([step.action,step.capabilityId,args]);
    if(attempted.has(signature)){feedback="That exact operation has already been attempted. Use its result or a different investigation step.";continue;}
    attempted.add(signature);
    let result:unknown;
    let calculation=false;
    if(step.action==="calculate"){
      if(identity.currency!=="USD"){
        feedback="The registered expression calculator supports USD only. Explain the currency limitation without relabeling local amounts or inventing conversions.";continue;
      }
      const plan=planSchema.safeParse(args);
      if(step.capabilityId!==EXPRESSION_ID||!plan.success){feedback="Select the registered expression contract and its typed nodes.";continue;}
      const handles=new Set(plan.data.nodes.flatMap(n=>n.op==="source"?[n.handle]:[]));
      const selected=operands.filter(o=>handles.has(o.handle));
      if(selected.length!==handles.size||selected.length>12){feedback="One or more operand handles were not authorized, or the expression is too large.";continue;}
      result=await registry.invokeSimulation(scope,EXPRESSION_ID,plan.data,{businessId:identity.businessId,
        locationId:null,ownerMessage:ownerStatements.join("\n").slice(-4000),currency:identity.currency,
        operands:plan.data.purpose==="no_external_sources"?[]:selected,
        bindings:bindings.filter(b=>selected.some(o=>o.capabilityId===b.capabilityId))});
      const checked=simulationOutputSchema.safeParse(result);
      if(!checked.success){feedback="The calculator could not validate its result.";continue;}
      result=checked.data;
      calculation=true;
    }else{
      if(!manifest.some(m=>m.id===step.capabilityId)){feedback="Unknown or non-read capability. No effects are permitted.";continue;}
      // Preserve validated period/week selectors across date-free follow-ups,
      // including nested domain requests. Explicit new owner dates supersede them.
      if(!investigationReadDatesMatch(args,input.text,identity.asOf,memory,ownerStatements)){
        feedback="That period differs from the owner's explicit or remembered calendar window. Keep the prior validated period unless the owner changes it.";continue;
      }
      if(identity.currency!=="USD"&&!['p3.business.profile.v1','p3.public.research.v1'].includes(step.capabilityId)){
        feedback="The currently registered monetary source contracts support USD only. Explain the scope limit without inventing conversions.";continue;
      }
      result=await registry.invoke(scope,step.capabilityId,args);
    }
    if(!record(result)){feedback="The tool result was invalid.";continue;}
    const id="r"+(observations.length+1);
    const successful=["partial","verified","estimated","conditional"].includes(String(result.status));
    const pure=calculation&&Array.isArray(result.sourceHandles)&&result.sourceHandles.length===0;
    const parentObservation=step.capabilityId===RECORDS_ID&&typeof result.sourceReadId==="string"
      ?observations.find(o=>o.id===result.sourceReadId):undefined;
    const observation:Observation={id,capabilityId:step.capabilityId,input:args,result,
      sourceContract:parentObservation?.sourceContract??(typeof result.id==="string"?result.id:undefined),
      reference:successful&&!pure?observationReference(identity.businessId,identity.asOf,step.capabilityId,result):null,
      display:successful?observationDisplay(result,input.locale):{},calculation};
    if(calculation&&typeof result.value==="number"&&typeof result.unit==="string")
      observation.display.value=formatScenarioValue(result.value,result.unit as z.infer<typeof import("../p3/expression").unit>,input.locale);
    if(successful&&!calculation){
      const quality=record(result.quality)?result.quality:null;
      if(quality&&Array.isArray(quality.missingInputs)&&Array.isArray(quality.estimatedInputs)&&Array.isArray(quality.staleInputs)){
        const parent=step.capabilityId===RECORDS_ID&&typeof result.sourceReadId==="string"
          ?datasets.get(result.sourceReadId):undefined;
        const sourceId=parent?.sourceId??(typeof result.id==="string"?result.id:step.capabilityId);
        const dataset=datasetFor(sourceId,result.value,quality as {missingInputs:string[];estimatedInputs:string[];staleInputs:string[]});
        if(dataset){datasets.set(id,{sourceId,dataset,revision:null});observation.datasetFields=dataset.fields;}
      }
      evidence.push({clause:input.text,capabilityId:step.capabilityId,status:result.status as "partial"|"verified"|"estimated",result,reason:null});
      if(!step.capabilityId.startsWith("p3.platform.")&&!step.capabilityId.startsWith("p3.public."))
        remembered.push({capabilityId:step.capabilityId,inputJson:JSON.stringify(args)});
    }
    observations.push(observation);
  }
  return failure(true);
}
