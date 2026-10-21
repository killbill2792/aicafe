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
const noDigits=(s:string)=>!/[\p{Nd}$€£¥%٪]|https?:\/\//iu.test(s);
const localeCopy={
 en:{fallback:"I couldn't finish that request. Here's what I could verify.",gap:"I couldn't verify the requested records.",source:"Verified",ask:"Please clarify one detail.",hint:"Your answer",estimate:"Estimated or incomplete source",conditional:"Conditional calculation using numbers supplied by the owner; not verified café records."},
 es:{fallback:"No pude terminar la solicitud. Esto es lo que pude verificar.",gap:"No pude verificar los datos solicitados.",source:"Verificado",ask:"Aclara un detalle, por favor.",hint:"Tu respuesta",estimate:"Fuente estimada o incompleta",conditional:"Cálculo condicional con cifras del propietario; no son datos verificados del negocio."},
 ar:{fallback:"لم أتمكن من إكمال الطلب. إليك ما تمكنت من التحقق منه.",gap:"تعذّر التحقق من البيانات المطلوبة.",source:"موثق",ask:"يرجى توضيح تفصيل واحد.",hint:"إجابتك",estimate:"مصدر تقديري أو غير مكتمل",conditional:"حساب مشروط بأرقام قدّمها المالك، وليس بيانات مقهى موثّقة."},
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
function factBlocks(selected:Fact[]):{blocks:SupervisorReplyBlock[];evidence:EvidenceReference[]}{
 const evidence:EvidenceReference[]=[],blocks:SupervisorReplyBlock[]=[];
 for(const fact of selected){
  if(!fact.source)continue;
  if(!evidence.some(r=>r.identifier===fact.source!.identifier))evidence.push(fact.source);
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
 const registry=createP3ReadRegistry([...buildAlexP3Registrations(),...buildOliviaP3Registrations(),
   buildAlexPricingRegistrations()[0],buildOliviaInvestigationRegistration(),
   buildDatasetRegistration(datasets,identity.businessId),buildRecordsRegistration(()=>observations,identity.businessId)]);
 const manifest=registry.discover(scope).filter(d=>!isRedundantModelRead(d.id));
 const visibleIds=new Set(modelVisibleIds(manifest.map(x=>x.id)));
 const descriptions=manifest.filter(d=>visibleIds.has(d.id));
 const discovered=new Set<string>();
 const facts=new Map<string,Fact>(),optionRows=new Map<string,{id:string;label:string}>();
 const messages:unknown[]=[{role:"user",content:JSON.stringify({
   ownerRequest:input.text,locale:input.locale,calendarDay:input.asOf,timezone:input.timezone,
   priorTurns:input.history.slice(-6),savedSelectorContext:memory?.reads?.slice(-3)??[],
   clarification:input.ownerClarification??null,
   selectedProductId:input.trustedCatalogProductId??null,
   possibleActions:input.inertProposal?.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))??[],
 })}];
 const factView=()=>[...facts.values()].slice(-LIMITS.maxFacts).map(f=>({id:f.id,label:f.label,value:f.value}));
 const memoryState=()=>({version:1 as const,businessId:identity.businessId,ownerStatements:statements.slice(-6),
   reads:[] as {capabilityId:string;inputJson:string}[]});
 const reply=(text:string,ids:string[],status:"partial"|"verified"|"unavailable"="partial"):GroundedSupervisorReply=>{
   const selected=pickIds(ids,facts);const structured=factBlocks(selected);
   const conditional=selected.filter(f=>!f.source&&f.raw!==null);
   const blocks:SupervisorReplyBlock[]=structured.blocks;
   const intro=text.trim().slice(0,1000);
   if(intro)blocks.unshift({type:"text",text:intro});
   if(conditional.length){
     if(!structured.evidence.length)blocks.unshift({type:"warning",code:"P3_CONDITIONAL",text:copy.conditional});
     for(const fact of conditional)blocks.push({type:"text",text:(fact.label+": "+fact.value).slice(0,1200)});
   }
   if(!blocks.length)blocks.push({type:"text",text:copy.gap});
   if(!structured.evidence.length&&conditional.length)return {intent:"profitability",status:"partial",
     evidence:[],blocks:blocks.slice(0,30),investigationMemory:memoryState()};
   return {intent:"unknown",status:structured.evidence.length?status:"unavailable",
     evidence:structured.evidence,blocks:blocks.slice(0,30),investigationMemory:memoryState()};
 };
 const addFacts=(observation:Observation)=>{
   const output=observation.result;
   if(!["verified","partial","estimated","conditional"].includes(String(output.status)))return;
   const result=output.value;
   const recordRows=Array.isArray(result)?result:isRecord(result)?[result]:[];
   const flat=recordRows.filter(isRecord);
   for(const row of flat){
     const id=typeof row.id==="string"?row.id:null;
     const label=String(row.name??row.productName??row.displayName??row.employeeName??row.base_name??"").slice(0,140);
     if(id&&label)optionRows.set(id,{id,label});
   }
   const displayed=observationDisplay(output,input.locale);
   for(const [path,value] of Object.entries(displayed.display)){
     if(facts.size>=LIMITS.maxFacts)break;
     const raw=displayed.raw[path],kind=displayed.kind[path];
     const segments=path.split(".");
     const rowIndex=segments[0]==="value"&&/^\d+$/u.test(segments[1]??"")?Number(segments[1]):-1;
     const row=rowIndex>=0?flat[rowIndex]:flat[0];
     const item=String(row?.name??row?.productName??row?.employeeName??row?.base_name??"").slice(0,110);
     const field=segments.at(-1)??path;
     const label=(item?item+" · ":"")+field;
     const numeric:SimpleOperand|null=typeof raw==="number"&&Number.isSafeInteger(raw)?
       kind==="money"?{value:raw,unit:"USD_cents"}:
       (field.toLowerCase().includes("count")||field.toLowerCase().includes("units")||
         field.toLowerCase().includes("quantity"))&&raw>=0?{value:raw,unit:"count"}:null:null;
     const factId="f"+(facts.size+1);
     facts.set(factId,{id:factId,label,value,raw:numeric,source:observation.reference});
   }
 };
 const instructions=[
   "You are the AI CAFE owner-facing Supervisor. Own the conversation in the owner's language.",
   "Investigate by discovering registered business tools, invoking exact schema inputs, then inspecting outputs. Never invent a café fact, ID or data.",
   "Do not ask the owner for information a relevant tool can retrieve. A full array is kept server-side; use search_observation to find missing rows.",
   "Tool errors are NOT clarification requests; explain the exact limitation and preserve any answerable facts.",
   "For any factual price, wage, cost, quantity, time, percentage or date from business records, select fact IDs returned by the server. Do not write these values into your own text.",
   "The server displays fact IDs as verified rendered values. Your text is short natural connecting prose without numbers, monetary symbols, factual action-completion claims, URLs or unsupported café assertions.",
   "For computations call calculate_verified with exact owner quotes or authorized facts. Never do business arithmetic yourself.",
   "Only ask a clarification if distinct interpretations materially change the request. For possible multiple variants, inspect the catalog and then select real option IDs.",
   "For a genuine clarification set mode=clarify, text=one precise question, optionIds=matching known record IDs or [] for free text; factIds=[]. No second model reviewer exists.",
   "For answer mode, select the most relevant available fact IDs (maximum 12); if partial state so explicitly. Do not re-request the same failed tool indefinitely.",
   "Owner-approved business changes must go through prepare_action and subsequent owner approval/commit workflows. No POS writes are available.",
   "If the task requires calculation or effects not supported by current tools, explain what is unavailable rather than claim success.",
 ].join(" ");
 let failures=0;
 for(let round=0;round<LIMITS.rounds&&Date.now()<deadline;round++){
  usage.modelCallCount++;
  input.onUsage?.({...usage});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),18000);
  let response:Response;
  try{
   response=await transport(SUPERVISOR_ENDPOINT,{method:"POST",signal:controller.signal,
    headers:{"content-type":"application/json",authorization:"Bearer "+input.apiKey},
    body:JSON.stringify({model:input.model,...supervisorModelProfile(input.model),store:false,
     max_output_tokens:2400,instructions,input:messages,
     tools:tools.map(tool=>({...tool,strict:false})),parallel_tool_calls:false,
     text:{format:{type:"json_schema",name:"supervisor_conversation",strict:true,schema:responseSchema}}})});
  }finally{clearTimeout(timer);}
  if(!response.ok){failures++;if(failures>1)break;continue;}
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
    // Clarification prose cannot smuggle record facts or unverified numbers.
    const question=result.text.trim().slice(0,220);
    if(!question||!noDigits(question))break;
    const resolved=pickIds(result.optionIds,optionRows);
    const loc={en:question,es:question,ar:question};
    // A selected menu variant must survive the owner reply as an authenticated
    // catalog identity; a generic option label is never a product ID or a money quote.
    const catalog=resolved.length>=2?await getMenuControlCenter():[];
    const matched=resolved.length>=2?resolved.map(o=>catalog.find(row=>row.id===o.id&&row.active)):[];
    const menuOptions=matched.length>=2&&matched.every(Boolean);
    const context=menuOptions?{
      domain:"menu_proposal",
      ...Object.fromEntries(matched.map(row=>[
        "catalogIdentity:"+row!.id,
        catalogIdentityFingerprint({id:row!.id,name:row!.name,
          base_name:row!.baseName,size_label:row!.sizeLabel}),
      ])),
    }:undefined;
    const request=ownerResolutionRequest({question:loc,input:resolved.length>=2?
      {kind:"options",options:resolved.map(o=>({id:o.id,label:{en:o.label,es:o.label,ar:o.label}}))}:
      {kind:"free_text",hint:{en:localeCopy.en.hint,es:localeCopy.es.hint,ar:localeCopy.ar.hint}},
      context});
    const checked=await authorizedOwnerP1();
    if(checked.identity.businessId!==identity.businessId)throw new Error("Owner scope changed");
    const pending=buildOwnerQuestionReply({businessId:identity.businessId,originalText:input.text,
      readCapabilityId:"platform.owner_input.resolve.v1",readInput:{},request});
    return {reply:{...pending,investigationMemory:memoryState()},usage};
   }
   // Only the server's fact renderers are authorized to display business figures.
   const clean=result.text.trim();
   return {reply:reply(noDigits(clean)?clean:copy.fallback,result.factIds),usage};
  }
  if(usage.toolCallCount>=LIMITS.operations)break;
  const c=calls[0],name=String(c.name??""),callId=String(c.call_id??"");
  let args:Data={};
  try{const decoded=JSON.parse(String(c.arguments??"{}"));if(isRecord(decoded))args=decoded;}
  catch{/* Invalid tool input is a tool result, not an owner clarification. */}
  let result:unknown={status:"unavailable",reason:"invalid_tool_request"};
  const describe=(d:typeof descriptions[number])=>({id:d.id,purpose:d.purpose,parameters:d.inputJsonSchema});
  if(name==="discover_tools"){
   const q=normalize(String(args.query??"")).split(" ").filter(w=>w.length>2);
   const ranked=descriptions.map(d=>{
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
   if(d&&discovered.has(id)&&isRecord(args.input)&&registry.preflightRead(scope,id,args.input)){
    const value=await registry.invoke(scope,id,args.input,()=>{usage.toolCallCount++;input.onUsage?.({...usage});});
    if(isRecord(value)){
     if(value.status==="requires_owner_input"&&isRecord(value.ownerInput)){
       const request=ownerResolutionRequest({question:{
         en:copy.ask,es:copy.ask,ar:copy.ask},input:{kind:"free_text",hint:{
         en:localeCopy.en.hint,es:localeCopy.es.hint,ar:localeCopy.ar.hint}}});
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
       const observation:Observation={id:"r"+(observations.length+1),capabilityId:id,input:args.input,
         result:value,reference:["verified","estimated","partial"].includes(String(value.status))?
           observationReference(identity.businessId,input.asOf,id,value):null,display:{}};
       observations.push(observation);
       addFacts(observation);
       // Keep the prior trusted dataset analysis engine available for
       // aggregating this observed source without resending the full array.
       const q=isRecord(value.quality)?value.quality:null;
       const completeQuality=q&&Array.isArray(q.missingInputs)&&
         Array.isArray(q.estimatedInputs)&&Array.isArray(q.staleInputs);
       const sourceId=typeof value.id==="string"?value.id:id;
       const dataset=completeQuality?datasetFor(sourceId,value.value,q as {
         missingInputs:string[];estimatedInputs:string[];staleInputs:string[]}):null;
       if(dataset)datasets.set(observation.id,{sourceId,dataset,revision:null});
       result={observationId:observation.id,status:value.status,values:preview(value.value),
         quality:preview(value.quality),reason:value.reason??null,facts:factView().slice(-25),
         datasetFields:dataset?.fields??null,totalRows:Array.isArray(value.value)?value.value.length:null,
         hint:"For more array rows call search_observation with this observation ID."};
     }
    }
   }else result={status:"unavailable",reason:"unknown_or_invalid_read",hint:"Discover tools and follow their exact schema."};
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
  }else if(name==="calculate_verified"){
   const resolve=(factId:unknown,ownerQuote:unknown):SimpleOperand|null=>{
     if(typeof factId==="string"&&facts.get(factId)?.raw)return facts.get(factId)!.raw;
     if(typeof ownerQuote==="string"&&quoteAppearsInOwnerText(ownerQuote,statements.join("\n")))
       return parseQuotedOperand(ownerQuote);
     return null;
   };
   const left=resolve(args.leftFactId,args.leftOwnerQuote),right=resolve(args.rightFactId,args.rightOwnerQuote);
   const allowed=["add","subtract","multiply","divide","percent_increase","percent_decrease"];
   const operation=String(args.operation??"");
   const calculated=left&&right&&allowed.includes(operation)?
     calculateSimple(operation as SimpleOperation,left,right):null;
   if(calculated){
     const id="f"+(facts.size+1),source=typeof args.leftFactId==="string"?
       facts.get(args.leftFactId)?.source??null:null;
     const value=calculated.unit==="USD_cents"?
       new Intl.NumberFormat(input.locale,{style:"currency",currency:"USD"}).format(calculated.value/100):
       String(calculated.value);
     facts.set(id,{id,label:"Calculated "+operation.replaceAll("_"," "),raw:calculated,value,source});
     result={status:"verified",factId:id,unit:calculated.unit,value};
     usage.toolCallCount++;
   }else result={status:"unavailable",reason:"unsupported_units_or_unverified_operands"};
  }else if(name==="prepare_action"){
   const registered=input.inertProposal?.tools.find(t=>t.name===args.name);
   if(registered&&isRecord(args.input)){
     const prepared=await input.inertProposal?.create(registered.name,args.input)??null;
     if(prepared){
       usage.toolCallCount++;
       const source:EvidenceReference={source:"cafe_state",identifier:"proposal:"+prepared.id,asOf:input.asOf};
       return {reply:{intent:"menu_pricing",status:"verified",evidence:[source],
         blocks:[{type:"text",text:prepared.text.slice(0,1200)}],investigationMemory:memoryState()},usage};
     }
     const known=input.inertProposal?.knownClarificationOptions?.()??[];
     for(const x of known)optionRows.set(x.id,{id:x.id,label:x.label[input.locale]});
     result={status:"unavailable",reason:"action_needs_unique_product_or_verified_baseline",
       availableOptions:known.map(o=>({id:o.id,label:o.label[input.locale]}))};
   }else result={status:"unavailable",reason:"unregistered_action"};
  }
  messages.push({type:"function_call_output",call_id:callId,output:JSON.stringify(result).slice(0,14000)});
  input.onDiagnostic?.({stage:"capability_selected",advertisedToolNames:[name],
    modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
 }
 return {reply:reply(copy.fallback,[...facts.keys()].slice(-8)),usage};
}
