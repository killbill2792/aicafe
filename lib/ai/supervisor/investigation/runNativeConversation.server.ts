import "server-only";
import {randomUUID,createHash} from "node:crypto";
import {z} from "zod";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {createP3ReadRegistry,isRedundantModelRead} from "@/lib/ai/supervisor/p3/sourceRegistry.server";
import {buildAlexP3Registrations} from "@/lib/pricing/alexP3Capabilities.server";
import {buildOliviaP3Registrations} from "@/lib/scheduling/oliviaP3Capabilities.server";
import {buildAlexPricingRegistrations} from "@/lib/pricing/alexCapabilities.server";
import {buildOliviaInvestigationRegistration} from "@/lib/scheduling/oliviaInvestigation.server";
import {buildDatasetRegistration,datasetFor,type StoredDataset} from "./datasets.server";
import {buildRecordsRegistration,recordCollections} from "./records.server";
import {buildResearchRegistration} from "./research.server";
import {datasetOperands} from "./calculations.server";
import {projectP1Evidence} from "@/lib/ai/supervisor/p3/operandProjection.server";
import {EXPRESSION_ID,planSchema} from "@/lib/ai/supervisor/p3/expression";
import {simulationOutputSchema} from "@/lib/ai/supervisor/p3/simulateRegistration.server";
import {formatScenarioValue} from "@/lib/ai/supervisor/p3/formatScenario";
import {groundedNaturalProse} from "./naturalConversationProse";
import {publicResearchOnly} from "./publicResearchBoundary";
import {investigationReadDatesMatch,investigationCalendarScope,rememberInvestigationReads,rememberCalendarScopes,authenticatedReadCalendarText} from "./readDates";
import {INVESTIGATION_LIMITS} from "./protocol";
import {presentInvestigatedTasks} from "./taskPresentation";
import {modelVisibleIds} from "./canonicalCapabilities";
import {observationDisplay,observationReference,citationCautionWarnings,type Observation} from "./evidence";
import type {ShadowEvidence} from "@/lib/ai/supervisor/p2/shadow.server";
import {buildOwnerQuestionReply} from "@/lib/ai/supervisor/ownerInput/response";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {catalogIdentityFingerprint} from "@/lib/pricing/alexOwnerInput.server";
import {ownerResolutionRequest} from "@/lib/ai/supervisor/ownerInput/resolution";
import {investigationOwnerStatements,investigationMemorySchema,type InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
import {calculateSimple,parseQuotedOperand,quoteAppearsInOwnerText,type SimpleOperand,type SimpleOperation} from "@/lib/calc/supervisorSimpleMath";
import {SUPERVISOR_ENDPOINT,supervisorModelProfile} from "@/lib/ai/conversations/supervisorRequest.mjs";
import type {GroundedSupervisorReply,SupervisorReplyBlock,EvidenceReference} from "@/lib/ai/conversations/contracts";
import type {InvestigationInput} from "./runInvestigation.server";
import type {InvestigationTransport,InvestigationUsage} from "./model.server";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

type Data=Record<string,unknown>;
const isRecord=(x:unknown):x is Data=>typeof x==="object"&&x!==null&&!Array.isArray(x);
const choice=z.strictObject({mode:z.enum(["answer","clarify"]),text:z.string(),factIds:z.array(z.string()),
  optionIds:z.array(z.string())});
const responseSchema={type:"object",additionalProperties:false,required:["mode","text","factIds","optionIds"],
  properties:{mode:{type:"string",enum:["answer","clarify"]},text:{type:"string"},
    factIds:{type:"array",items:{type:"string"}},optionIds:{type:"array",items:{type:"string"}}}};
const tools=[
  {type:"function",name:"discover_tools",description:"Search the authenticated available business tools by purpose. Call before read_cafe. Discover only the tools needed for the current goal.",
    parameters:{type:"object",additionalProperties:false,properties:{query:{type:"string"}},required:["query"]}},
  {type:"function",name:"read_cafe",description:"Read one discovered, authorized business capability using its exact schema. Never invent record identifiers.",
    parameters:{type:"object",additionalProperties:false,properties:{id:{type:"string"},input:{type:"object"}},required:["id","input"]}},
  {type:"function",name:"search_observation",description:"Filter a prior authoritative array observation by text. Use for menu variants and larger rosters; never guess a record ID.",
    parameters:{type:"object",additionalProperties:false,properties:{observationId:{type:"string"},query:{type:"string"}},required:["observationId","query"]}},
  {type:"function",name:"calculate_verified",description:"Exact-cents server calculator: pass verified fact IDs or exact owner-authored quotes for both operands. Percent operand must have a % sign.",
    parameters:{type:"object",additionalProperties:false,properties:{
      operation:{type:"string",enum:["add","subtract","multiply","divide","percent_increase","percent_decrease"]},
      leftFactId:{type:["string","null"]},leftOwnerQuote:{type:["string","null"]},
      rightFactId:{type:["string","null"]},rightOwnerQuote:{type:["string","null"]}},
      required:["operation","leftFactId","leftOwnerQuote","rightFactId","rightOwnerQuote"]}},
  {type:"function",name:"simulate_cafe",description:"Run an existing registered unit-checked scenario simulation using server-authorized operand handles; cannot perform writes.",
    parameters:{type:"object",additionalProperties:false,properties:{id:{type:"string"},input:{type:"object"}},required:["id","input"]}},
  {type:"function",name:"prepare_action",description:"Create only a registered inert owner-approval proposal; never approve, commit, publish, send or change POS prices.",
    parameters:{type:"object",additionalProperties:false,properties:{name:{type:"string"},input:{type:"object"}},required:["name","input"]}},
] as const;
type Fact={id:string;label:string;value:string;raw:SimpleOperand|null;
 source:EvidenceReference|null;sources?:EvidenceReference[];observationIds?:string[];
 conditional?:boolean;estimated?:boolean;period?:string;};
const LIMITS={rounds:INVESTIGATION_LIMITS.modelCalls,
 operations:INVESTIGATION_LIMITS.operations,elapsedMs:INVESTIGATION_LIMITS.elapsedMs,
 previewRows:8,maxFacts:500};
const localeCopy={
 en:{fallback:"I couldn't finish that request. Here's what I could verify.",gap:"I couldn't verify the requested records.",source:"Verified",hint:"Your answer",estimate:"Estimated or incomplete source",conditional:"Conditional calculation using numbers supplied by the owner; not verified café records."},
 es:{fallback:"No pude terminar la solicitud. Esto es lo que pude verificar.",gap:"No pude verificar los datos solicitados.",source:"Verificado",hint:"Tu respuesta",estimate:"Fuente estimada o incompleta",conditional:"Cálculo condicional con cifras del propietario; no son datos verificados del negocio."},
 ar:{fallback:"لم أتمكن من إكمال الطلب. إليك ما تمكنت من التحقق منه.",gap:"تعذّر التحقق من البيانات المطلوبة.",source:"موثق",hint:"إجابتك",estimate:"مصدر تقديري أو غير مكتمل",conditional:"حساب مشروط بأرقام قدّمها المالك، وليس بيانات مقهى موثّقة."},
};
const normalize=(s:string)=>s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
function preview(value:unknown):unknown{
  if(Array.isArray(value))return value.slice(0,LIMITS.previewRows).map(preview);
  if(isRecord(value))return Object.fromEntries(Object.entries(value).slice(0,35)
    .map(([k,v])=>[k,preview(v)]));
  return typeof value==="string"?value.slice(0,300):value;
}
function pickIds<T extends {id:string}>(ids:readonly string[],map:Map<string,T>):T[]{
 return [...new Set(ids)].slice(0,12).flatMap(id=>map.has(id)?[map.get(id)!]:[]);
}
function fieldLabel(field:string,locale:"en"|"es"|"ar"):string{
 const catalog={en,es,ar}[locale].SupervisorRegisteredRead as Record<string,string>;
 return catalog["field_"+field]??catalog.field_label;
}
function factBlocks(selected:Fact[]):{blocks:SupervisorReplyBlock[];evidence:EvidenceReference[]}{
 const evidence:EvidenceReference[]=[],blocks:SupervisorReplyBlock[]=[];
 for(const fact of selected){
  const sources=fact.sources??(fact.source?[fact.source]:[]);
  for(const source of sources)if(!evidence.some(r=>r.identifier===source.identifier))evidence.push(source);
  if(!fact.source)continue;
  if(fact.raw?.unit==="USD_cents")
    blocks.push({type:"metric",label:fact.label,valueCents:fact.raw.value,source:fact.source});
  else if(fact.raw?.unit==="count"&&fact.raw.value>=0)
    blocks.push({type:"count",label:fact.label,value:fact.raw.value,source:fact.source});
  else blocks.push({type:"text",text:(fact.label+": "+fact.value).slice(0,1200)});
 }
 return {blocks,evidence};
}

/** OpenAI owns investigation/clarification; the server owns facts, values and effects.
 * No independent model reviewer and no model-authored numeric citation grammar.
 * Stored model output never authorizes an action or money value.
 */
export async function runNativeConversationTurn(input:InvestigationInput,transport:InvestigationTransport=fetch):
 Promise<{reply:GroundedSupervisorReply;usage:InvestigationUsage}>{
 const usage:InvestigationUsage={model:input.model,modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0};
 const copy=localeCopy[input.locale];
 const deadline=Date.now()+LIMITS.elapsedMs;
 const {identity,tools:cafeTools}=await authorizedOwnerP1();
 if(identity.asOf!==input.asOf||identity.timezone!==input.timezone)throw new Error("Supervisor source identity changed");
 const snapshot=await readAuthorizedAtomicP1SourceSnapshot();
 if(snapshot.status==="available"&&(snapshot.snapshot.businessId!==identity.businessId||
    snapshot.snapshot.currency!==identity.currency||
    snapshot.snapshot.timezone!==identity.timezone))
    throw new Error("Supervisor source snapshot does not match authorized café");
 const financialReadsAvailable=snapshot.status==="available"||snapshot.reason==="rpc_not_installed";
 const sourceStillCurrent=async()=>{
   const latest=await authorizedOwnerP1();
   if(latest.identity.businessId!==identity.businessId||
     latest.identity.asOf!==identity.asOf||latest.identity.timezone!==identity.timezone||
     latest.identity.currency!==identity.currency)return false;
   if(snapshot.status==="available"){
     const current=await readAuthorizedAtomicP1SourceSnapshot();
     if(current.status!=="available"||current.snapshot.businessId!==identity.businessId||
       current.snapshot.revision!==snapshot.snapshot.revision)return false;
   }
   return true;
 };
 const staleReply=():GroundedSupervisorReply=>({intent:"unknown",status:"unavailable",
   evidence:[],blocks:[{type:"text",text:copy.gap}]});
 const old=investigationMemorySchema.safeParse(input.investigationMemory);
 const memory=old.success&&old.data.businessId===identity.businessId?old.data:undefined;
 const statements=investigationOwnerStatements(memory,input.history,input.text);
 if(input.ownerClarification)statements.push(input.ownerClarification);
 const scope={role:"owner" as const,businessId:identity.businessId,identity,tools:cafeTools,
   shadowEnabled:true,financialReadsAvailable,durableOwnerInput:true,
   ownerClause:input.text,ownerContext:statements.slice(-6).join("\n")};
 const datasets=new Map<string,StoredDataset>(),observations:Observation[]=[];
 const shadowEvidence:ShadowEvidence[]=[];
 const remembered:InvestigationMemory["reads"]=[];
 const scopes:NonNullable<InvestigationMemory["calendarScopes"]>=[];
 const requestKey=input.replayedOwnerRequest&&memory?.requestKey?memory.requestKey:
   createHash("sha256").update(randomUUID()).digest("hex");
 const registry=createP3ReadRegistry([...buildAlexP3Registrations(),...buildOliviaP3Registrations(),
   buildAlexPricingRegistrations()[0],buildOliviaInvestigationRegistration(),
   buildDatasetRegistration(datasets,identity.businessId),buildRecordsRegistration(()=>observations,identity.businessId),
   buildResearchRegistration(()=>"",async(clause,query,context)=>
     publicResearchOnly(input.text,clause,query,context))]);
 const manifest=registry.discover(scope).filter(d=>!isRedundantModelRead(d.id));
 const visibleIds=new Set(modelVisibleIds(manifest.map(x=>x.id)));
 const descriptions=manifest.filter(d=>visibleIds.has(d.id));
 const simulations=registry.discoverSimulations?.(scope)??[];
 const discovered=new Set<string>();
 const sourceContractFor=(result:Data,capabilityId:string):string=>{
   if(result.id==="platform.records.inspect"&&typeof result.sourceReadId==="string"){
     const parent=datasets.get(result.sourceReadId)?.sourceId??
       observations.find(o=>o.id===result.sourceReadId)?.result.id;
     if(typeof parent==="string")return parent;
   }
   return typeof result.id==="string"?result.id:
     capabilityId.replace(/^p3\./u,"").replace(/\.v1$/u,"");
 };
 const facts=new Map<string,Fact>(),optionRows=new Map<string,{id:string;label:string}>();
 let hadUnavailable=false;
 const messages:unknown[]=[{role:"user",content:JSON.stringify({
   ownerRequest:input.text,locale:input.locale,calendarDay:input.asOf,timezone:input.timezone,
   priorTurns:input.history.slice(-6),savedSelectorContext:memory?.reads?.slice(-3)??[],
   clarification:input.ownerClarification??null,
   selectedProductId:input.trustedCatalogProductId??null,
   possibleActions:input.inertProposal?.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))??[],
 })}];
 const factView=()=>[...facts.values()].slice(-LIMITS.maxFacts).map(f=>({id:f.id,label:f.label,value:f.value}));
 const memoryState=():InvestigationMemory=>({version:1,businessId:identity.businessId,
   ownerStatements:statements.slice(-6),requestKey,
   reads:rememberInvestigationReads(memory?.reads??[],remembered),
   calendarScopes:rememberCalendarScopes(memory?.calendarScopes??[],scopes),
   calendarScopeOrigins:[...(memory?.calendarScopeOrigins??[]),
     ...scopes.map(x=>({domain:x.domain,kind:x.kind,requestKey,
       capabilityId:remembered.find(r=>r.capabilityId.startsWith("p3."+x.domain))?.capabilityId??"platform.read.v1"}))].slice(-5)});
 const reply=(modelText:string,ids:string[],requestedStatus:"partial"|"verified"|"unavailable"="partial"):GroundedSupervisorReply=>{
   const selected=pickIds(ids,facts),structured=factBlocks(selected);
   const cited=observations.filter(o=>selected.some(f=>f.observationIds?.includes(o.id)));
   const conditional=selected.filter(f=>f.conditional||!f.source&&f.raw!==null);
   const cards=cited.flatMap(o=>o.reference?
      presentInvestigatedTasks(o.sourceContract,o.result.value,o.reference,input.locale):[])
     .filter((b,i,all)=>b.type!=="task_card"||
       all.findIndex(c=>c.type==="task_card"&&c.taskId===b.taskId)===i).slice(0,3);
   for(const card of cards)if(card.type==="task_card"&&!structured.evidence.some(r=>r.identifier===card.source.identifier))
      structured.evidence.push(card.source);
   // OpenAI owns wording; the server checks numeric spans using selected
   // authorized facts and authentic owner statements, without citation syntax.
   const known=[...statements,...selected.flatMap(f=>[f.value,f.label])];
   const prose=groundedNaturalProse(modelText,known,input.locale);
   const citedComplete=cited.length>0&&cited.every(o=>{
     const quality=isRecord(o.result.quality)?o.result.quality:null;
     return o.result.status==="verified"&&
       (!quality||["missingInputs","estimatedInputs","staleInputs"].every(k=>
         !Array.isArray(quality[k])||quality[k].length===0));
   });
   const complete=selected.length>0&&ids.every(id=>facts.has(id))&&
     selected.every(f=>!f.conditional&&!f.estimated)&&
     citedComplete&&!hadUnavailable&&!prose.redacted;
   const warnings:SupervisorReplyBlock[]=[
     ...(conditional.length?[{type:"warning" as const,code:"P3_CONDITIONAL",text:copy.conditional}]:[]),
     ...citationCautionWarnings(cited,input.locale),
   ];
   if(prose.redacted)warnings.push({type:"warning",code:"UNVERIFIED_CLAIM",
     text:{en,es,ar}[input.locale].SupervisorInvestigation.unverifiedWarning});
   if(!selected.length&&prose.text&&cited.length===0)warnings.push({
     type:"warning",code:"SUPERVISOR_ADVICE",
     text:{en,es,ar}[input.locale].SupervisorInvestigation.advice});
   const blocks:SupervisorReplyBlock[]=[...warnings];
   if(prose.text)blocks.push({type:"text",text:prose.text});
   blocks.push(...structured.blocks,...cards);
   for(const fact of conditional.filter(f=>!f.source))
     blocks.push({type:"text",text:(fact.label+": "+fact.value).slice(0,1200)});
   if(!blocks.length)blocks.push({type:"text",text:copy.gap});
   const status=complete?"verified":
     hadUnavailable&&!structured.evidence.length?"unavailable":
     structured.evidence.length||conditional.length||prose.text?"partial":"unavailable";
   return {intent:"unknown",status:requestedStatus==="unavailable"?
     structured.evidence.length?"partial":"unavailable":status,
     evidence:structured.evidence,blocks:blocks.slice(0,30),investigationMemory:memoryState()};
 };
 const addFacts=(observation:Observation)=>{
   const output=observation.result;
   if(!["verified","partial","estimated","conditional"].includes(String(output.status)))return;
   const value=output.value;
   const rows=Array.isArray(value)?value:isRecord(value)&&Array.isArray(value.items)?value.items:isRecord(value)?[value]:[];
   const flat=rows.filter(isRecord);
   for(const row of flat){
     const id=typeof row.id==="string"?row.id:null;
     const label=String(row.name??row.productName??row.displayName??row.employeeName??row.base_name??"").slice(0,140);
     if(id&&label)optionRows.set(id,{id,label});
   }
   const resultId=sourceContractFor(output,observation.capabilityId);
   const quality=isRecord(output.quality)?output.quality:null;
   const allowedQuality=quality&&Array.isArray(quality.missingInputs)&&
     Array.isArray(quality.estimatedInputs)&&Array.isArray(quality.staleInputs)?
     quality as {missingInputs:string[];estimatedInputs:string[];staleInputs:string[]}:null;
   const approved=allowedQuality?datasetFor(resultId,value,allowedQuality):null;
   const authoritativeUnits=new Map(approved?.fields.map(field=>[field.key,field.unit])??[]);
   const displayed=observationDisplay(output,input.locale);
   for(const [path,formatted] of Object.entries(displayed.display)){
     // Model-chosen query selectors and provenance metadata are not business
     // facts. Only fields returned inside the validated value are publishable.
     if(path!=="value"&&!path.startsWith("value."))continue;
     if(facts.size>=LIMITS.maxFacts)break;
     const raw=displayed.raw[path],segments=path.split(".");
     const rowIndex=segments.findIndex((v,i)=>i>0&&/^\d+$/u.test(v));
     const row=rowIndex>=0?flat[Number(segments[rowIndex])]:flat[0];
     const item=String(row?.name??row?.productName??row?.employeeName??row?.base_name??"").slice(0,110);
     const field=segments.at(-1)??path,unit=authoritativeUnits.get(field);
     // Only a declared USD amount is a valid operand. Wage rates,
     // dimensional quantities, percentages and unknown numeric fields are
     // for display but cannot be silently treated as ordinary cents/counts.
     const numeric:SimpleOperand|null=typeof raw==="number"&&Number.isSafeInteger(raw)&&
       unit==="USD_cents"&&identity.currency==="USD"?{value:raw,unit:"USD_cents"}:null;
     const factId="f"+(facts.size+1);
     facts.set(factId,{id:factId,label:(item?item+" · ":"")+fieldLabel(field,input.locale),
       value:formatted,raw:numeric,source:observation.reference,
       observationIds:[observation.id],period:JSON.stringify(
         isRecord(observation.input)?observation.input.period??observation.input.week??null:null),
       estimated:output.status!=="verified"||
         Boolean(allowedQuality?.estimatedInputs.length||allowedQuality?.missingInputs.length)});
   }
 };
 const instructions=[
   "You are the AI CAFE owner-facing Supervisor. Own the conversation in the owner's language.",
   "Investigate by discovering registered business tools, invoking exact schema inputs, then inspecting outputs. Never invent a café fact, ID or data.",
   "Do not ask the owner for information a relevant tool can retrieve. A full array is kept server-side; use search_observation to find missing rows.",
   "Tool errors are NOT clarification requests; explain the exact limitation and preserve any answerable facts.",
   "Speak directly and naturally to the café owner. Explain verified findings, partial coverage, specific unavailable inputs, recommendations and next steps. Never replace an explanation with a generic source-status sentence.",
   "For business facts and numerical results, choose the relevant returned fact IDs; you may repeat a number in ordinary prose if it is present in those selected facts or in an authenticated owner quote. Do not invent quantities, records, dates or unsupported claims. The server verifies displayed numbers and shows the actual values.",
   "For clarifications, ask the exact meaningful question you want the owner to see. You may mention sizes, dates and prices when supplied by the verified options or the owner. The UI renders real choices from their record IDs. Do not ask a vague generic clarification.",
   "Do not claim you published, sent, approved, changed or completed an action unless a trusted execution tool actually returned that completion. Preparing a proposal is never committing it.",
   "For computations call calculate_verified with exact owner quotes or authorized facts. Never do business arithmetic yourself.",
   "For advanced cross-domain what-if scenarios discover platform scenario expression, use registered source handles and simulate_cafe. Never invent a calculated result.",
   "Only ask a clarification if distinct interpretations materially change the request. For possible multiple variants, inspect the catalog and then select real option IDs.",
   "For a genuine clarification set mode=clarify, text=one precise question, optionIds=matching known record IDs or [] for free text; factIds=[]. No second model reviewer exists.",
   "For answer mode, select the most relevant available fact IDs (maximum 12); if partial state so explicitly. Do not re-request the same failed tool indefinitely.",
   "Owner-approved business changes must go through prepare_action and subsequent owner approval/commit workflows. No POS writes are available.",
   "If the task requires calculation or effects not supported by current tools, explain what is unavailable rather than claim success.",
 ].join(" ");
 let failures=0;
 for(let round=0;round<LIMITS.rounds&&Date.now()<deadline;round++){
  const remaining=deadline-Date.now();
  if(remaining<=250)break;
  usage.modelCallCount++;
  input.onUsage?.({...usage});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.min(18000,remaining));
  let response:Response;
  try{
   response=await transport(SUPERVISOR_ENDPOINT,{method:"POST",signal:controller.signal,
    headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
    body:JSON.stringify({model:usage.model,...supervisorModelProfile(usage.model),store:false,
     max_output_tokens:2400,instructions,input:messages,
     tools:tools.map(tool=>({...tool,strict:false})),parallel_tool_calls:false,
     text:{format:{type:"json_schema",name:"supervisor_conversation",strict:true,schema:responseSchema}}})});
  }catch{
    // The owner should still receive already verified facts when a provider
    // times out or disconnects. Do not make the route fail with an HTTP error.
    failures++;break;
  }finally{clearTimeout(timer);}
  if(!response.ok){
    let code="",message="";
    try{
      const err=await response.json() as {error?:{code?:unknown;message?:unknown}};
      code=String(err.error?.code??"").slice(0,80);
      message=String(err.error?.message??"").slice(0,300);
    }catch{/* Missing error details do not allow arbitrary retries. */}
    const configured=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
    const accessError=["model_not_found","model_not_allowed","model_access_denied",
      "model_not_available","model_not_accessible","invalid_model"].includes(code)||
      ([400,403,404].includes(response.status)&&/\bmodel\b/iu.test(message));
    if(accessError&&configured&&configured!==usage.model&&
       usage.modelCallCount<LIMITS.rounds){
      input.onDiagnostic?.({stage:"provider_fallback",fromModel:usage.model,
        toModel:configured,triggerHttpStatus:response.status,triggerProviderErrorCode:code});
      usage.model=configured;
      continue;
    }
    failures++;if(failures>1)break;continue;
  }
  const payload=await response.json() as Data;
  const u=isRecord(payload.usage)?payload.usage:{};
  usage.inputTokens+=typeof u.input_tokens==="number"?u.input_tokens:0;
  usage.outputTokens+=typeof u.output_tokens==="number"?u.output_tokens:0;
  input.onUsage?.({...usage});
  const output=Array.isArray(payload.output)?payload.output.filter(isRecord):[];
  if(payload.status!=="completed"||!output.length)break;
  messages.push(...output);
  const calls=output.filter(o=>o.type==="function_call");
  if(!calls.length){
   const text=output.flatMap(o=>Array.isArray(o.content)?o.content:[])
     .filter(isRecord).filter(x=>x.type==="output_text").map(x=>String(x.text??"")).join("");
   const parsed=choice.safeParse((()=>{try{return JSON.parse(text);}catch{return null;}})());
   if(!parsed.success)break;
   const result=parsed.data;
   // Snapshot and owner scope must remain authoritative at publication time.
   if(!(await sourceStillCurrent()))return {reply:staleReply(),usage};
   if(result.mode==="clarify"){
    const requestedQuestion=result.text.trim().slice(0,220);
    if(!requestedQuestion)break;
    const resolved=pickIds(result.optionIds,optionRows);
    // Preserve the model's genuine question. Numeric sizes from the verified
    // option IDs and owner-stated prices are permitted, not blanket-rejected.
    const question=groundedNaturalProse(requestedQuestion,
      [...statements,...resolved.map(o=>o.label)],input.locale).text;
    const loc={en:question,es:question,ar:question};
    // A selected menu variant must survive the owner reply as an authenticated
    // catalog identity; a generic option label is never a product ID or a money quote.
    const catalog=resolved.length>=2?await getMenuControlCenter():[];
    const matched=resolved.length>=2?resolved.map(o=>catalog.find(row=>row.id===o.id&&row.active)):[];
    const menuOptions=matched.length>=2&&matched.every(Boolean);
    const priorContext=input.inertProposal?.knownClarificationContext?.()??{};
    const rememberedProduct=priorContext.selectedProductId??input.trustedCatalogProductId;
    const savedItem=rememberedProduct?await getMenuControlCenter().then(items=>
      items.find(row=>row.id===rememberedProduct&&row.active)):undefined;
    const context:Record<string,string>|undefined=menuOptions?{
      domain:"menu_proposal",
      ...Object.fromEntries(matched.map(row=>[
        "catalogIdentity:"+row!.id,
        catalogIdentityFingerprint({id:row!.id,name:row!.name,
          base_name:row!.baseName,size_label:row!.sizeLabel}),
      ])),
    }:savedItem?{
      domain:"menu_proposal",selectedProductId:savedItem.id,
      ["catalogIdentity:"+savedItem.id]:catalogIdentityFingerprint({
        id:savedItem.id,name:savedItem.name,
        base_name:savedItem.baseName,size_label:savedItem.sizeLabel}),
    }:undefined;
    const request=ownerResolutionRequest({question:loc,input:resolved.length>=2?
      {kind:"options",options:resolved.map(o=>({id:o.id,label:{en:o.label,es:o.label,ar:o.label}}))}:
      {kind:"free_text",hint:{en:localeCopy.en.hint,es:localeCopy.es.hint,ar:localeCopy.ar.hint}},
      context});
    const checked=await authorizedOwnerP1();
    if(checked.identity.businessId!==identity.businessId)throw new Error("Owner scope changed");
    // A clarification after one authenticated source read belongs to that
    // source's calendar domain. Retain the issued reader identity so an
    // owner-supplied date correction cannot be applied to a different domain.
    const sourced=observations.filter(o=>o.reference&&descriptions.some(d=>d.id===o.capabilityId));
    const issuing=sourced.length&&sourced.every(o=>o.capabilityId===sourced[0].capabilityId)?
      sourced[0]:null;
    const pending=buildOwnerQuestionReply({businessId:identity.businessId,originalText:input.text,
      readCapabilityId:issuing?.capabilityId??"platform.owner_input.resolve.v1",
      readInput:issuing?.input??{},request});
    return {reply:{...pending,investigationMemory:memoryState()},usage};
   }
   // Model explanations are retained. Facts themselves still come from
   // server-controlled values, identities and calculations.
   return {reply:reply(result.text.trim(),result.factIds),usage};
  }
  if(usage.toolCallCount>=LIMITS.operations||Date.now()>=deadline)break;
  const c=calls[0],name=String(c.name??""),callId=String(c.call_id??"");
  let args:Data={};
  try{const decoded=JSON.parse(String(c.arguments??"{}"));if(isRecord(decoded))args=decoded;}
  catch{/* Invalid tool input is a tool result, not an owner clarification. */}
  let result:unknown={status:"unavailable",reason:"invalid_tool_request"};
  const describe=(d:typeof descriptions[number])=>({id:d.id,purpose:d.purpose,parameters:d.inputJsonSchema});
  if(name==="discover_tools"){
   const q=normalize(String(args.query??"")).split(" ").filter(w=>w.length>2);
   const ranked=[...descriptions,...simulations].map(d=>{
     const hay=normalize(d.id+" "+d.purpose);
     return {d,score:q.reduce((n,w)=>n+(hay.includes(w)?1:0),0)};
   }).sort((a,b)=>b.score-a.score);
   const chosen=ranked.filter(x=>x.score>0).slice(0,9);
   for(const match of chosen)discovered.add(match.d.id);
   result={tools:chosen.map(x=>describe(x.d)),
     message:chosen.length?"Use read_cafe with the discovered id and exact input schema.":"Try a broader tool-purpose search."};
  }else if(name==="read_cafe"){
   const id=String(args.id??"");
   const d=descriptions.find(d=>d.id===id);
   const ownerText=authenticatedReadCalendarText(input.text,input.ownerClarification,
     input.ownerClarificationReadCapabilityId,d?.owner??"",identity.asOf,
     capabilityId=>descriptions.find(r=>r.id===capabilityId)?.owner);
   const datesMatch=d&&investigationReadDatesMatch(args.input,ownerText,
     identity.asOf,memory,statements,d.owner,id=>descriptions.find(r=>r.id===id)?.owner);
   // P1 may report that the authoritative snapshot is invalid or revoked.
   // A schema-valid read is never enough to override an integrity failure.
   const financialBlocked=!financialReadsAvailable&&Boolean(d)&&
     (d!.sensitivity==="financial"||
       /^p3\.(?:money|sales|labor|alex|pricing)\./u.test(id));
   if(d&&Date.now()+d.budgets.timeoutMs>=deadline)break;
   if(d&&discovered.has(id)&&isRecord(args.input)&&datesMatch&&!financialBlocked&&
     registry.preflightRead({...scope,ownerClause:ownerText},id,args.input)){
    const value=await registry.invoke({...scope,ownerClause:ownerText},id,args.input,
      ()=>{usage.toolCallCount++;input.onUsage?.({...usage});});
    if(isRecord(value)){
     if(value.status==="requires_owner_input"&&isRecord(value.ownerInput)){
       // Domain-authorized missing inputs are handled by the existing durable card path.
       const requestFromDomain=z.any().safeParse(value.ownerInput);
       const prepared=requestFromDomain.success?value.ownerInput:null;
       const domainInput=z.object({question:z.object({en:z.string(),es:z.string(),ar:z.string()}),
         input:z.any()}).safeParse(prepared);
       if(domainInput.success){
         if(!(await sourceStillCurrent()))return {reply:staleReply(),usage};
       const pending=buildOwnerQuestionReply({businessId:identity.businessId,originalText:input.text,
           readCapabilityId:id,readInput:args.input,
           request:prepared as Parameters<typeof buildOwnerQuestionReply>[0]["request"]});
         return {reply:{...pending,investigationMemory:memoryState()},usage};
       }
       result={status:"unavailable",reason:"invalid_owner_input"};
     }else{
       if(value.status==="unavailable")hadUnavailable=true;
       const displayed=observationDisplay(value,input.locale);
       const observation:Observation={id:"r"+(observations.length+1),capabilityId:id,input:args.input,
         result:value,sourceContract:typeof value.id==="string"?value.id:undefined,
         reference:["verified","estimated","partial"].includes(String(value.status))?
           observationReference(identity.businessId,input.asOf,id,value):null,
         display:displayed.display,displayKind:displayed.kind,displayRaw:displayed.raw};
       observations.push(observation);
       addFacts(observation);
       // Keep the prior trusted dataset analysis engine available for
       // aggregating this observed source without resending the full array.
       const q=isRecord(value.quality)?value.quality:null;
       const completeQuality=q&&Array.isArray(q.missingInputs)&&
         Array.isArray(q.estimatedInputs)&&Array.isArray(q.staleInputs);
       const sourceId=sourceContractFor(value,id);
       const dataset=completeQuality?datasetFor(sourceId,value.value,q as {
         missingInputs:string[];estimatedInputs:string[];staleInputs:string[]}):null;
       if(dataset)datasets.set(observation.id,{sourceId,dataset,revision:null});
       if(observation.reference){
         shadowEvidence.push({clause:input.text,capabilityId:id,
           status:value.status as "verified"|"partial"|"estimated",result:value,reason:null});
         if(!id.startsWith("p3.platform.")&&!id.startsWith("p3.public."))
           remembered.push({capabilityId:id,inputJson:JSON.stringify(args.input)});
         const calendar=investigationCalendarScope(args.input,d.owner);
         if(calendar)scopes.push(calendar);
       }
       const projection=projectP1Evidence(shadowEvidence,identity.businessId,input.text,
         null,statements.slice(-6),snapshot.status==="available"?snapshot.snapshot:undefined);
       const combinedOperands=[...projection.operands,...datasetOperands(observations,scope).operands];
       result={observationId:observation.id,status:value.status,values:preview(value.value),
         quality:preview(value.quality),reason:value.reason??null,facts:factView().slice(-25),
         authorizedOperands:combinedOperands.slice(0,12).map(o=>({
           handle:o.handle,unit:o.unit,period:o.period,sourceId:o.sourceId,
           missingInputs:o.missingInputs})),
         datasetFields:dataset?.fields??null,collections:recordCollections(value.value),
         totalRows:Array.isArray(value.value)?value.value.length:null,
         hint:"For more array rows call search_observation with this observation ID."};
     }
    }
   }else {
     hadUnavailable=true;
     result={status:"unavailable",reason:financialBlocked?"invalid_financial_snapshot":datesMatch===false?"owner_date_mismatch":"unknown_or_invalid_read",
       hint:"Discover tools and follow their exact schema; never substitute a different owner period."};
   }
  }else if(name==="search_observation"){
   const obs=observations.find(o=>o.id===args.observationId);
   const query=normalize(String(args.query??""));
   if(obs&&query&&Array.isArray(obs.result.value)){
    const matching=obs.result.value.filter(row=>normalize(JSON.stringify(row)).includes(query));
    const view=matching.slice(0,15);
    for(const item of view)if(isRecord(item)&&typeof item.id==="string"){
      const label=String(item.name??item.productName??item.displayName??item.employeeName??"").slice(0,120);
      if(label)optionRows.set(item.id,{id:item.id,label});
    }
    // A search result is a filtered projection of the already-authorized
    // source. Give its matching rows their own source-backed fact IDs.
    if(view.length){
      const projected:Observation={...obs,id:"r"+(observations.length+1),
        result:{...obs.result,value:view},reference:obs.reference};
      observations.push(projected);
      addFacts(projected);
    }
    result={count:matching.length,rows:view,sourceObservationId:obs.id,
      facts:factView().slice(-35)};
   }else result={status:"unavailable",reason:"no_matching_observation"};
  }else if(name==="simulate_cafe"){
   const id=String(args.id??"");
   const simulation=simulations.find(m=>m.id===id);
   const plan=planSchema.safeParse(args.input);
   if(!simulation||!discovered.has(id)||!plan.success||id!==EXPRESSION_ID||
      identity.currency!=="USD"){
     result={status:"unavailable",reason:"unknown_or_invalid_simulation"};
   }else{
     if(Date.now()+simulation.budgets.timeoutMs>=deadline)break;
     const projection=projectP1Evidence(shadowEvidence,identity.businessId,input.text,
       null,statements.slice(-6),snapshot.status==="available"?snapshot.snapshot:undefined);
     const derived=datasetOperands(observations,scope);
     const available=[...projection.operands,...derived.operands];
     const handles=new Set(plan.data.nodes.flatMap(n=>n.op==="source"?[n.handle]:[]));
     const selected=available.filter(o=>handles.has(o.handle));
     if(selected.length!==handles.size||selected.length>12){
       result={status:"unavailable",reason:"missing_or_unapproved_operand",
         authorizedOperands:available.slice(0,12).map(o=>({handle:o.handle,unit:o.unit}))};
     }else{
       const bindings=[...projection.bindings,...derived.bindings].filter(b=>
         selected.some(o=>o.capabilityId===b.capabilityId));
       const checked=await registry.invokeSimulation(scope,EXPRESSION_ID,plan.data,{
         businessId:identity.businessId,locationId:null,currency:"USD",
         ownerMessage:statements.join("\n").slice(-4000),
         operands:plan.data.purpose==="no_external_sources"?[]:selected,bindings,
       },()=>{usage.toolCallCount++;input.onUsage?.({...usage});});
       const valid=simulationOutputSchema.safeParse(checked);
       if(!valid.success||valid.data.status==="unavailable"){
         result={status:"unavailable",reason:"simulation_unavailable",
           authorizedOperands:available.slice(0,12).map(o=>({handle:o.handle,unit:o.unit}))};
       }else{
         const computed=valid.data;
         const sourceObservations=observations.filter(o=>o.reference&&selected.some(a=>{
           if(a.capabilityId!==o.capabilityId)return false;
           if(a.handle.startsWith("dataset:"))return a.handle.startsWith("dataset:"+o.id+":");
           const period=isRecord(o.input)&&isRecord(o.input.period)?o.input.period:null;
           return !a.period||Boolean(period&&period.from===a.period.from&&period.to===a.period.to);
         }));
         const refs=[...new Map(sourceObservations.flatMap(o=>o.reference?[o.reference]:[])
           .map(r=>[r.identifier,r])).values()];
         const periods=new Set(selected.flatMap(o=>o.period?
           [JSON.stringify({from:o.period.from,to:o.period.to})]:[]));
         const period=periods.size===1?[...periods][0]:
           periods.size>1?"incompatible_source_periods":undefined;
         const calculatedId="f"+(facts.size+1);
         const currency=computed.unit==="USD_cents"&&typeof computed.value==="number";
         const formatted=typeof computed.value==="number"?
           formatScenarioValue(computed.value,computed.unit,input.locale):"";
         facts.set(calculatedId,{
           id:calculatedId,
           label:currency?{en,es,ar}[input.locale].SupervisorInvestigation.factAmount:
             {en,es,ar}[input.locale].SupervisorInvestigation.factPercent,
           value:formatted,raw:currency?{value:computed.value as number,unit:"USD_cents"}:null,
           source:refs[0]??null,sources:refs,
           observationIds:sourceObservations.map(o=>o.id),conditional:true,estimated:true,
           period,
         });
         result={status:computed.status,factId:calculatedId,unit:computed.unit,
           value:formatted,sourceHandles:computed.sourceHandles,assumptions:computed.assumptions,
           missingInputs:computed.missingInputs,
           authorizedOperands:available.slice(0,12).map(o=>({handle:o.handle,unit:o.unit}))};
       }
     }
   }
  }else if(name==="calculate_verified"){
   const resolve=(factId:unknown,ownerQuote:unknown):{operand:SimpleOperand;fact:Fact|null;owner:boolean}|null=>{
     if(typeof factId==="string"){
       const fact=facts.get(factId);
       return fact?.raw?{operand:fact.raw,fact,owner:false}:null;
     }
     if(typeof ownerQuote==="string"&&quoteAppearsInOwnerText(ownerQuote,statements.join("\n"))){
       const operand=parseQuotedOperand(ownerQuote);
       return operand?{operand,fact:null,owner:true}:null;
     }
     return null;
   };
   const left=resolve(args.leftFactId,args.leftOwnerQuote);
   const right=resolve(args.rightFactId,args.rightOwnerQuote);
   const operation=String(args.operation??"");
   const allowed=["add","subtract","multiply","divide","percent_increase","percent_decrease"];
   const differentPeriods=Boolean(
     left?.fact?.period==="incompatible_source_periods"||
     right?.fact?.period==="incompatible_source_periods"||
     (left?.fact?.period&&right?.fact?.period&&
       left.fact.period!==right.fact.period));
   const calculated=left&&right&&!differentPeriods&&identity.currency==="USD"&&
     allowed.includes(operation)?calculateSimple(operation as SimpleOperation,
       left.operand,right.operand):null;
   if(calculated){
     const id="f"+(facts.size+1);
     const linked=[left!.fact,right!.fact].filter((f):f is Fact=>f!==null);
     const sources=[...new Map(linked.flatMap(f=>f.sources??(f.source?[f.source]:[]))
       .map(v=>[v.identifier,v])).values()];
     const conditional=left!.owner||right!.owner||linked.some(f=>f.conditional||f.estimated);
     const value=calculated.unit==="USD_cents"?
       formatScenarioValue(calculated.value,"USD_cents",input.locale):
       String(calculated.value);
     facts.set(id,{id,label:calculated.unit==="USD_cents"?
         {en,es,ar}[input.locale].SupervisorInvestigation.factAmount:
         {en,es,ar}[input.locale].SupervisorInvestigation.factPercent,
       raw:calculated,value,source:sources[0]??null,sources,conditional,
       estimated:conditional,
       observationIds:[...new Set(linked.flatMap(f=>f.observationIds??[]))],
       period:linked[0]?.period});
     result={status:conditional?"partial":"verified",factId:id,unit:calculated.unit,
       value,assumptions:conditional?["Owner input and/or estimated source used."]:[]};
     usage.toolCallCount++;input.onUsage?.({...usage});
   }else result={status:"unavailable",reason:differentPeriods?
     "incompatible_source_periods":"unsupported_units_or_unverified_operands"};
  }else if(name==="prepare_action"){
   const registered=input.inertProposal?.tools.find(t=>t.name===args.name);
   if(registered&&isRecord(args.input)){
     // Proposal preparation can involve a DB simulation. Refuse to initiate
     // it in the final seconds of the shared turn deadline.
     if(Date.now()+10000>=deadline)break;
     let prepared:{id:string;text:string}|null=null;
     let proposalFailure:string|null=null;
     try{
       prepared=await input.inertProposal?.create(registered.name,args.input)??null;
     }catch{
       // An unavailable recipe or POS baseline must not abort the conversation,
       // discard verified reads, or pretend a proposal was created.
       proposalFailure="proposal_requires_verified_baseline";
       hadUnavailable=true;
     }
     if(prepared){
       usage.toolCallCount++;
       const source:EvidenceReference={source:"cafe_state",identifier:"proposal:"+prepared.id,asOf:input.asOf};
       if(!(await sourceStillCurrent()))return {reply:staleReply(),usage};
       return {reply:{intent:"menu_pricing",status:"verified",evidence:[source],
         blocks:[{type:"text",text:prepared.text.slice(0,1200)}],investigationMemory:memoryState()},usage};
     }
     const known=input.inertProposal?.knownClarificationOptions?.()??[];
     for(const x of known)optionRows.set(x.id,{id:x.id,label:x.label[input.locale]});
     result={status:"unavailable",reason:proposalFailure??"action_needs_unique_product_or_verified_baseline",
       availableOptions:known.map(o=>({id:o.id,label:o.label[input.locale]}))};
   }else result={status:"unavailable",reason:"unregistered_action"};
  }
  messages.push({type:"function_call_output",call_id:callId,output:JSON.stringify(result).slice(0,14000)});
  input.onDiagnostic?.({stage:"capability_selected",advertisedToolNames:[name],
    modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
 }
 if(!(await sourceStillCurrent()))return {reply:staleReply(),usage};
 return {reply:reply(copy.fallback,[...facts.keys()].slice(-8),"unavailable"),usage};
}
