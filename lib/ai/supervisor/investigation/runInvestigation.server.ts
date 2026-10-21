import "server-only";
import {modelVisibleIds,describeSourceFields} from "./canonicalCapabilities";
import {outputFor} from "@/lib/metrics/p1Readers.server";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {buildAlexPricingRegistrations} from "@/lib/pricing/alexCapabilities.server";
import {buildOliviaInvestigationRegistration} from "@/lib/scheduling/oliviaInvestigation.server";
import {buildAlexP3Registrations} from "@/lib/pricing/alexP3Capabilities.server";
import {ownerInputRequestSchema} from "@/lib/ai/supervisor/ownerInput/contracts";
import {buildOwnerQuestionReply} from "@/lib/ai/supervisor/ownerInput/response";
import type {KnownClarificationOption} from "@/lib/ai/supervisor/ownerInput/clarifications";
import {ownerResolutionRequest} from "@/lib/ai/supervisor/ownerInput/resolution";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {buildOliviaP3Registrations} from "@/lib/scheduling/oliviaP3Capabilities.server";
import {investigationReadDatesMatch,rememberInvestigationReads,investigationCalendarScope,rememberCalendarScopes,pendingOwnerCalendarCorrection,hasInvestigationOwnerCalendarDate} from "./readDates";
import {investigationMemorySchema,investigationOwnerStatements,type InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
import type {ConversationalTurn} from "@/lib/ai/conversations/context";
import type {GroundedSupervisorReply,SupervisorReplyBlock,EvidenceReference} from "@/lib/ai/conversations/contracts";
import {createP3ReadRegistry,isRedundantModelRead} from "../p3/sourceRegistry.server";
import {values,type SupportedId} from "@/lib/metrics/p1Catalog";
import {projectP1Evidence} from "../p3/operandProjection.server";
import {EXPRESSION_ID,planSchema} from "../p3/expression";
import {simulationOutputSchema} from "../p3/simulateRegistration.server";
import {formatScenarioValue} from "../p3/formatScenario";
import type {ShadowEvidence} from "../p2/shadow.server";
import {buildDatasetRegistration,datasetFor,DATASET_ID,type StoredDataset} from "./datasets.server";
import {datasetOperands} from "./calculations.server";
import {buildRecordsRegistration,recordCollections,RECORDS_ID} from "./records.server";
import {buildResearchRegistration} from "./research.server";
import {observationDisplay,observationReference,investigationLabels,investigationReply,
  renderInvestigationAnswer,renderUnverifiedAnswer,citationCautionWarnings,buildClaimFeedback,
  type Observation,type Locale,type ClaimIssue} from "./evidence";
import {verifyFormulaEntry,observationPeriod,resolvedPeriod} from "./formulaVerification";
import {answerSchema,reviewSchema,formulaExtractionSchema,INVESTIGATION_LIMITS,
  type InvestigationAnswer,type ReviewVerdict} from "./protocol";
import {requestInvestigation,isToolCallSignal,type InvestigationTransport,type InvestigationUsage,
  type ToolDef,type ToolCallSignal} from "./model.server";
import {SupervisorStageError,logSupervisorDebugPayload,type SupervisorDiagnostic} from "@/lib/ai/conversations/diagnostics.server";
import {investigationInstructions,reviewInstructions,publicQueryReviewInstructions,
  calendarContextReviewInstructions,formulaExtractionInstructions} from "./instructions";

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** Bound the MODEL preview, not the authoritative dataset used by calculators.
 * Full source results remain server-side and are hashed in evidence references. */
function preview(v:unknown,depth=0):unknown{
  if(depth>7)return "[nested data omitted]";
  if(Array.isArray(v))return v.slice(0,12).map(x=>preview(x,depth+1));
  if(record(v))return Object.fromEntries(Object.entries(v).slice(0,50).map(([k,x])=>[k,preview(x,depth+1)]));
  return typeof v==="string"?v.slice(0,600):v;
}
/** Native function-calling tool names must match OpenAI's ^[a-zA-Z0-9_-]+$
 * (max 64 chars); capability ids use dots/colons the API rejects in a tool
 * name. Exported so tests build mock tool-call responses with the exact
 * same mapping production uses, instead of a second hand-maintained copy. */
export function capabilityToolName(capabilityId:string):string{
  return capabilityId.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64);
}
export const CALCULATE_TOOL_NAME="calculate";
/** Owner-safe "which AI Team member" label for a diagnostic/progress event.
 * A registration's internal `owner` field is a domain prefix, not always a
 * persona name; this is presentation only and never changes which capability
 * actually runs. */
export function friendlyAgent(owner:string|undefined):"alex"|"olivia"|"leo"|"maya"|"supervisor"{
  switch(owner){
    case "alex":case "menu":case "pricing":return "alex";
    case "olivia":case "labor":return "olivia";
    case "money":case "sales":return "leo";
    case "maya":case "team":case "supplies":return "maya";
    default:return "supervisor";
  }
}
/** Resolves the actual record a display path points into (not just the raw
 * numeric leaf), by walking the SAME observation's underlying value -- e.g.
 * "value.0.priceCents" resolves to `value[0]`, the one menu item this price
 * actually belongs to. `recordLocator` is the path with its last segment
 * (the field name itself) dropped, and always starts with "value" (see
 * `observationDisplay`'s walk). */
function recordAt(value:unknown,recordLocator:string):unknown{
  let cur=value;
  for(const seg of recordLocator.split(".").slice(1)){
    if(Array.isArray(cur))cur=cur[Number(seg)];
    else if(record(cur))cur=cur[seg];
    else return undefined;
  }
  return cur;
}
/** A record's own identity (its id, or the closest thing to one) and the
 * period/scope it covers, when either is actually present in the data --
 * used ONLY to tell apart genuinely different entities/periods that happen
 * to share a field name (Codex finding #5), never to invent an identity the
 * data doesn't actually carry. */
function recordScope(node:unknown):string{
  if(!record(node))return "";
  const id=["id","productId","employeeId","ingredientId"].map(k=>node[k])
    .find((v):v is string|number=>typeof v==="string"||typeof v==="number");
  const scope=["spentOn","effectiveFrom","effective_from","period","wagePeriod"].map(k=>node[k])
    .find((v):v is string=>typeof v==="string");
  return (id===undefined?"":"id:"+id)+"|"+(scope??"");
}
/** Stable selector identity for derived data: order of JSON object keys must not
 * turn the same analysis into two different facts. Arrays retain their order. */
function canonicalSelector(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonicalSelector);
  if(record(value))return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>[k,canonicalSelector(v)]));
  return value;
}
/** A new failure category (§8): when the SAME field name (e.g. an hourly
 * wage) comes back with more than one distinct value for the SAME entity
 * and period across different observations produced this turn, that is a
 * genuine conflict for one fact the owner's request treats as singular --
 * surfaced to the model as context so it is nudged toward a clarification
 * question instead of silently resolving it itself (averaging, picking
 * one). Grouping by field name ALONE is not enough: a menu catalog with
 * several different products, or an employee roster with several different
 * wages, must never look like "several conflicting values for one fact"
 * merely because they share a field name -- the entity (which record this
 * value belongs to, via its own id or its position in the result) and its
 * period/scope are part of the grouping key too. Purely additive context;
 * never blocks or changes the loop's own control flow. */
export function detectConflictingFacts(observations:readonly Observation[]):
  {field:string;values:{id:string;display:string}[]}[]{
  const groups=new Map<string,{field:string;id:string;display:string;raw:number}[]>();
  for(const o of observations){
    if(!o.displayKind)continue;
    const inputPeriod=observationPeriod(o,observations)??"unresolved:"+o.id;
    for(const [path,kind] of Object.entries(o.displayKind)){
      if(kind!=="money"&&kind!=="percent")continue;
      const raw=o.displayRaw?.[path];
      if(typeof raw!=="number")continue;
      const field=o.capabilityId.split(".").slice(0,2).join(".")+":"+(path.split(".").at(-1)??path);
      const recordLocator=path.split(".").slice(0,-1).join(".");
      const scope=recordScope(recordAt(o.result.value,recordLocator));
      // A record with its own stable identity (an id/employeeId/etc -- a
      // non-empty "id:" prefix from recordScope) is grouped by THAT identity
      // alone, never also by its array position: the same entity read at
      // value.0 in one call and value.1 in a reordered/filtered call must
      // land in the SAME group so a genuine conflict between them is still
      // caught. Only a record with no identity to key on at all falls back
      // to position (recordLocator) to keep its distinct records apart.
      // A dataset total represents a particular query over a particular
      // authorized source, not every other aggregate for the same month.
      // Group only matching source-read ID + complete analysis selector.
      const datasetValue=record(o.result.value)?o.result.value:null;
      const analysisInput=record(o.input)?o.input:null;
      // Dataset filters are conjunctive, so their order has no meaning.
      // Canonicalizing each predicate first preserves genuine same-analysis
      // conflicts even when a model supplies filters in a different order.
      const analysisSelector=analysisInput?{...analysisInput,
        filters:Array.isArray(analysisInput.filters)?analysisInput.filters.map(canonicalSelector)
          .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):analysisInput.filters}:o.input;
      const analysisIdentity=o.capabilityId===DATASET_ID?JSON.stringify({
        source:datasetValue?.sourceReadId,
        selector:canonicalSelector(analysisSelector),
      }):"";
      // A grouped analysis can return rows in a different order on a
      // subsequent read. The group label, not array position, identifies
      // the measured entity. Distinct group labels must never conflict.
      const measuredRecord=recordAt(o.result.value,recordLocator);
      const groupIdentity=o.capabilityId===DATASET_ID&&record(measuredRecord)&&
        Object.hasOwn(measuredRecord,"group")?"group:"+JSON.stringify(measuredRecord.group):null;
      // Dataset group labels REPLACE positional array indices, otherwise
      // reordering the same groups hides a real disagreement on one label.
      const recordIdentity=groupIdentity??(scope.startsWith("id:")?scope:recordLocator+"|"+scope);
      const key=field+"@"+recordIdentity+"|"+inputPeriod+"|"+analysisIdentity;
      const list=groups.get(key)??[];
      list.push({field,id:o.id,display:o.display[path]??String(raw),raw});
      groups.set(key,list);
    }
  }
  const conflicts:{field:string;values:{id:string;display:string}[]}[]=[];
  for(const entries of groups.values()){
    if(entries.length>1&&new Set(entries.map(e=>e.raw)).size>1)
      conflicts.push({field:entries[0].field,values:entries.map(({id,display})=>({id,display}))});
  }
  return conflicts.slice(0,5);
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
  /** Server-validated answer to a durable owner question, separate from full original text. */
  ownerClarification?:string;
  apiKey:string;model:string;onUsage?:(usage:InvestigationUsage)=>void;
  onDiagnostic?:(event:SupervisorDiagnostic)=>void;
  // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload. When the
  // caller (the API route) already generated a per-turn correlation id for its
  // own lifecycle debug points, it is passed in here so the WHOLE turn --
  // route-level points and every investigation round -- shares exactly one id,
  // instead of this loop minting a second, disconnected one.
  debugRequestId?:string;
  /** Registered, typed, INERT proposals only. No approval or effect authority. */
  inertProposal?:{tools:readonly ToolDef[];
    create:(name:string,args:unknown)=>Promise<{id:string;text:string}|null>;
    knownClarificationOptions?:()=>readonly KnownClarificationOption[];
    knownClarificationContext?:()=>Record<string,string>};
};
export async function runInvestigationTurn(input:InvestigationInput,transport:InvestigationTransport):
  Promise<{reply:GroundedSupervisorReply;usage:InvestigationUsage}>{
  const deadline=Date.now()+INVESTIGATION_LIMITS.elapsedMs;
  const usage:InvestigationUsage={model:input.model,modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0};
  const labels=investigationLabels(input.locale);
  // Surface precisely which owner goal remains unanswered, in the owner's
  // language, rather than silently publishing an incomplete candidate.
  // Reviewer prose is untrusted diagnostic detail, not localized owner copy.
  // Emit only the bounded reason's PRESENCE to the sanitized diagnostic stream.
  const missingGoalWarning=(_reason:string,
    domain?:ReviewVerdict["missingGoalDomain"]):SupervisorReplyBlock=>{
    const copy=({en,es,ar} as const)[input.locale].SupervisorOwnerHelp;
    const text=domain?copy.incompleteByDomain.replace("{domain}",copy.domains[domain]):
      copy.incomplete;
    return {type:"warning",code:"SUPERVISOR_INCOMPLETE",text};
  };
  // TEMPORARY, TEST-ENVIRONMENT-ONLY correlation id -- see
  // logSupervisorDebugPayload. Shares no identifier with the sanitized
  // production diagnostics logger; only ties this one turn's raw debug
  // points together so its whole round-by-round trace can be reconstructed.
  // Reuses the caller's id (the API route's own turn-level debugRequestId)
  // when supplied, so the round-by-round trace joins up with the rest of the
  // request lifecycle instead of getting a second, unrelated id.
  const debugRequestId=input.debugRequestId??randomUUID().slice(0,12);
  // The model's own last attempt at a direct answer, kept only as a safety
  // net for when the turn is about to exhaust anyway. Never a substitute for
  // a grounded answer: it only ever reaches the owner tagged "unverified",
  // with no metric/count/percent blocks and no evidence citations. Only ever
  // set from a round that failed mechanical rendering -- never from a round
  // that reached the independent review, whose negative verdict is an
  // actual finding, not a formatting slip, and must never be rescued.
  let lastUnverifiedAnswer:{text:string;citedIds:string[];missingGoalReason?:string}|null=null;
  // §7: the best claim-level-masked candidate seen across the WHOLE loop,
  // never just the final attempt. "Best" = fewest unresolved claim issues,
  // ties broken by most surviving content. Reused only when exhaustion
  // leaves nothing cleaner to show (failure() below).
  let bestAccumulated:{issueCount:number;score:number;blocks:SupervisorReplyBlock[];
    evidence:EvidenceReference[];citedIds:string[];status:GroundedSupervisorReply["status"];
    intent:GroundedSupervisorReply["intent"];answer:InvestigationAnswer}|null=null;
  // Shared by every place that records a §7 candidate: both the pre-extraction
  // candidate recorded on every issue-bearing round, and a same-round,
  // post-extraction candidate that strictly improves on it. Comparing on
  // issueCount FIRST (fewer unresolved claims always wins), block count only
  // as a tie-break, fixes two opposite failures a bare block-count compare
  // had (Codex findings): a `>` compare kept a stale, more-masked candidate
  // when extraction fixed one claim without changing the block count (same
  // round, issueCount strictly drops -- now correctly wins); a later `>=`
  // fix then let a WORSE, unrelated later round with strictly MORE unresolved
  // issues overwrite a cleaner earlier one merely because both happened to
  // render the same number of blocks (now correctly rejected, since a higher
  // issueCount never replaces a lower one regardless of block count).
  const updateBestAccumulated=(candidate:GroundedSupervisorReply,issueCount:number,
    answer:InvestigationAnswer)=>{
    const score=candidate.blocks.length;
    if(!bestAccumulated||issueCount<bestAccumulated.issueCount||
      (issueCount===bestAccumulated.issueCount&&score>=bestAccumulated.score))
      bestAccumulated={issueCount,score,blocks:candidate.blocks,
        evidence:candidate.evidence,status:candidate.status,intent:candidate.intent,answer,
        citedIds:observations.filter(o=>o.reference&&candidate.evidence.some(e=>e.identifier===o.reference!.identifier)).map(o=>o.id)};
  };
  const failure=async(budget=false,exhaustionReason?:SupervisorDiagnostic["exhaustionReason"]):
    Promise<{reply:GroundedSupervisorReply;usage:InvestigationUsage}>=>{
    let rescue=budget&&!!lastUnverifiedAnswer;
    if(rescue&&lastUnverifiedAnswer){
      // A rescued answer can still describe real café data through its
      // cited observations, so it must pass the exact same publication-time
      // authorization/snapshot checks as a fully grounded answer -- never
      // less scrutiny just because it is a safety net.
      const latestOwner=await authorizedOwnerP1();
      if(latestOwner.identity.businessId!==identity.businessId||latestOwner.identity.timezone!==identity.timezone||
        latestOwner.identity.currency!==identity.currency||latestOwner.identity.asOf!==identity.asOf){
        rescue=false;
      }else if(atomic.status==="available"&&observations.some(o=>
        lastUnverifiedAnswer!.citedIds.includes(o.id)&&o.requiresSnapshot)){
        const latest=await readAuthorizedAtomicP1SourceSnapshot();
        if(latest.status!=="available"||latest.snapshot.businessId!==identity.businessId||
          latest.snapshot.revision!==atomic.snapshot.revision)rescue=false;
      }
    }
    // §7 fallback: only considered when the cleaner (zero-masking)
    // lastUnverifiedAnswer rescue above is unavailable. Carries its own
    // independent review (never shown unreviewed) and the same
    // publication-time reauthorization as every other path.
    let accumulatedRescue=!rescue&&budget&&!!bestAccumulated;
    if(accumulatedRescue&&bestAccumulated){
      const latestOwner=await authorizedOwnerP1();
      if(latestOwner.identity.businessId!==identity.businessId||latestOwner.identity.timezone!==identity.timezone||
        latestOwner.identity.currency!==identity.currency||latestOwner.identity.asOf!==identity.asOf){
        accumulatedRescue=false;
      }else if(atomic.status==="available"&&observations.some(o=>
        bestAccumulated!.citedIds.includes(o.id)&&o.requiresSnapshot)){
        const latest=await readAuthorizedAtomicP1SourceSnapshot();
        if(latest.status!=="available"||latest.snapshot.businessId!==identity.businessId||
          latest.snapshot.revision!==atomic.snapshot.revision)accumulatedRescue=false;
      }
      if(accumulatedRescue){
        const accReview:ReviewVerdict|ToolCallSignal|null=await requestInvestigation({name:"supervisor_investigation_review",schema:reviewSchema,
          instructions:reviewInstructions,context:{ownerRequest:input.text,ownerLocale:input.locale,ownerStatements,
            observations:observations.map(o=>({id:o.id,capabilityId:o.capabilityId,result:preview(o.result)})),
            proposedAnswer:bestAccumulated.answer,renderedAnswer:bestAccumulated.blocks},
          apiKey:input.apiKey,model:input.model,transport,usage,deadline,onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
        // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
        logSupervisorDebugPayload({point:"accumulated_rescue_review_verdict",requestId:debugRequestId,
          supported:accReview&&!isToolCallSignal(accReview)?accReview.supported:null,
          complete:accReview&&!isToolCallSignal(accReview)?accReview.complete:null,
          reason:accReview&&!isToolCallSignal(accReview)?accReview.reason:null});
        if(!accReview||isToolCallSignal(accReview)){
          // An unavailable reviewer is not evidence of semantic support.
          accumulatedRescue=false;
        }else if(!accReview.supported){
          // Only independently supported original paragraphs survive. The
          // renderer rechecks every paragraph and its actual citations;
          // a source-backed value in one cannot certify another's actions.
          const safeBlocks:SupervisorReplyBlock[]=[];
          const safeEvidence:EvidenceReference[]=[];
          const safeCitedIds=new Set<string>();
          const selected=new Set(accReview.supportedParagraphIndices??[]);
          bestAccumulated.answer.paragraphs.forEach((paragraph,index)=>{
            if(!selected.has(index)||paragraph.kind!=="evidence")return;
            const checked=renderInvestigationAnswer({paragraphs:[paragraph]},
              observations,input.locale,{ownerText:input.text});
            if(!checked||checked.issues.length||checked.evidence.length===0)return;
            safeBlocks.push(...checked.blocks);
            for(const ref of checked.evidence)
              if(!safeEvidence.some(prev=>prev.identifier===ref.identifier))safeEvidence.push(ref);
            for(const id of checked.citedIds)safeCitedIds.add(id);
          });
          if(!safeBlocks.length){
            accumulatedRescue=false;
            input.onDiagnostic?.({stage:"investigation_round",failureCategory:"reviewer_hard_fail"});
          }else{
            bestAccumulated={...bestAccumulated,status:"partial",
              blocks:[...bestAccumulated.blocks.filter(block=>block.type==="warning"),
                ...safeBlocks,missingGoalWarning(accReview.reason,accReview.missingGoalDomain)],
              evidence:safeEvidence,citedIds:[...safeCitedIds]};
            input.onDiagnostic?.({stage:"grounded_answer",groundedStatus:"partial",
              failureCategory:"reviewer_downgraded_to_partial"});
          }
        }else if(!accReview.complete){
          bestAccumulated={...bestAccumulated,status:"partial",
            blocks:bestAccumulated.blocks.length<30?
              [...bestAccumulated.blocks,missingGoalWarning(accReview.reason,accReview.missingGoalDomain)]:
              bestAccumulated.blocks};
        }
      }
    }
    input.onDiagnostic?.({stage:"investigation_exhausted",exhaustionReason,
      failureCategory:budget?"budget_exhausted":undefined,
      modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,rescuedUnverified:rescue||accumulatedRescue});
    // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
    logSupervisorDebugPayload({point:"investigation_exhausted",requestId:debugRequestId,ownerQuestion:input.text,
      budget,exhaustionReason,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,
      rescuedUnverified:rescue||accumulatedRescue,rescuedText:rescue&&lastUnverifiedAnswer?lastUnverifiedAnswer.text:null,
      lastUnverifiedCandidate:lastUnverifiedAnswer,accumulatedRescue,
      accumulatedBlocks:accumulatedRescue&&bestAccumulated?bestAccumulated.blocks:null});
    if(accumulatedRescue&&bestAccumulated){
      return {reply:{intent:bestAccumulated.intent,status:bestAccumulated.status,
        evidence:bestAccumulated.evidence,blocks:bestAccumulated.blocks},usage:{...usage}};
    }
    if(rescue&&lastUnverifiedAnswer){
      const citedObservations=observations.filter(o=>lastUnverifiedAnswer!.citedIds.includes(o.id));
      // A pure owner-authored hypothetical (every citation a source-free
      // expression result, never a real café read) must still carry the
      // same conditional-scenario disclaimer the grounded path always
      // attaches, so it can never be mistaken for observed demand or
      // verified profit just because this path flattened it to plain text.
      const pure=citedObservations.length>0&&citedObservations.every(o=>o.calculation&&!o.reference);
      // The unverified warning only speaks to numbers/dates against café
      // records; every other mandatory caution a grounded reply would carry
      // for these same citations (unverified public research, estimated
      // inputs, monetary unavailability, a registered source's own caveat --
      // e.g. a labor-law note on a schedule read) must not be dropped just
      // because this path flattened the answer to plain text.
      const blocks:SupervisorReplyBlock[]=[
        ...(pure?[{type:"warning" as const,code:"P3_CONDITIONAL",text:labels.conditional}]:[]),
        {type:"warning",code:"SUPERVISOR_UNVERIFIED",text:labels.unverifiedWarning},
        ...citationCautionWarnings(citedObservations,input.locale),{type:"text",text:lastUnverifiedAnswer.text}];
      if(lastUnverifiedAnswer.missingGoalReason&&blocks.length<30)
        blocks.push(missingGoalWarning(lastUnverifiedAnswer.missingGoalReason));
      return {reply:{intent:pure?"profitability" as const:"unknown" as const,status:"insufficient_evidence" as const,
        evidence:[],blocks},usage:{...usage}};
    }
    return {reply:{intent:"unknown" as const,status:"unavailable" as const,evidence:[],
      blocks:[{type:"warning" as const,code:budget?"SUPERVISOR_INVESTIGATION_LIMIT":"SUPERVISOR_INVESTIGATION_UNAVAILABLE",
        text:budget?labels.budget:labels.unavailable}]},usage:{...usage}};
  };
  const {identity,tools}=await authorizedOwnerP1();
  if(!identity.businessId||identity.asOf!==input.asOf||identity.timezone!==input.timezone||!input.apiKey)return await failure();
  const parsedMemory=investigationMemorySchema.safeParse(input.investigationMemory);
  const memory=parsedMemory.success&&parsedMemory.data.businessId===identity.businessId?parsedMemory.data:undefined;
  // Only authenticated same-thread owner statements can ground referents or hypotheticals.
  const earlierOwnerStatements=investigationOwnerStatements(memory,input.history,input.text);
  // Preserve the current full request and the newly authenticated clarification
  // within the memory contract's six-statement bound.
  const ownerStatements=input.ownerClarification&&input.ownerClarification.length<=600?
    [...earlierOwnerStatements,input.ownerClarification].slice(-6):earlierOwnerStatements;
  const atomic=await readAuthorizedAtomicP1SourceSnapshot();
  const financialReadsAvailable=atomic.status==="available"||atomic.reason==="rpc_not_installed";
  if(atomic.status==="available"&&(atomic.snapshot.businessId!==identity.businessId||
    atomic.snapshot.currency!==identity.currency||atomic.snapshot.timezone!==identity.timezone))
    return await failure(false,"snapshot_mismatch");
  const scope={financialReadsAvailable,role:"owner" as const,businessId:identity.businessId,identity,tools,shadowEnabled:true,
    ownerClause:input.text,durableOwnerInput:true,ownerContext:ownerStatements.join("\n")};
  // Every domain returns the same typed owner-answerable gap. The shared
  // loop renders/stores it without knowing any specialist's write contract.
  const ownerInputReply=async(capabilityId:string,args:unknown,result:unknown)=>{
    if(!record(result)||result.status!=="requires_owner_input")return null;
    const request=ownerInputRequestSchema.safeParse(result.ownerInput);
    if(!request.success)return null;
    const current=await authorizedOwnerP1();
    if(current.identity.businessId!==identity.businessId||
      current.identity.timezone!==identity.timezone||
      current.identity.currency!==identity.currency||
      current.identity.asOf!==identity.asOf)return null;
    if(atomic.status==="available"){
      const latest=await readAuthorizedAtomicP1SourceSnapshot();
      if(latest.status!=="available"||latest.snapshot.businessId!==atomic.snapshot.businessId||
        latest.snapshot.revision!==atomic.snapshot.revision)return null;
    }
    const reply=buildOwnerQuestionReply({businessId:identity.businessId,
      originalText:input.text,readCapabilityId:capabilityId,readInput:args,
      request:request.data});
    input.onDiagnostic?.({stage:"grounded_answer",agent:"supervisor",
      groundedStatus:"insufficient_evidence",modelCallCount:usage.modelCallCount,
      toolCallCount:usage.toolCallCount});
    return {reply,usage:{...usage}};
  };
  // Same dispatcher is used for domain gaps, reviewed questions and
  // no-progress/calendar ambiguity. Only the producer knows why it is stuck.
  const askForHelp=async(question:Record<"en"|"es"|"ar",string>,
    capabilityId="platform.owner_input.resolve.v1",args:unknown={})=>
    ownerInputReply(capabilityId,args,{
      status:"requires_owner_input",
      ownerInput:ownerResolutionRequest({question,
        input:{kind:"free_text",hint:{
          en:en.SupervisorOwnerHelp.detailHint,
          es:es.SupervisorOwnerHelp.detailHint,
          ar:ar.SupervisorOwnerHelp.detailHint,
        }}}),
    });
  const askWhenStuck=async(question:Record<"en"|"es"|"ar",string>,
    capabilityId?:string,args?:unknown)=>{
    // An adaptive stop must NOT throw away a previously grounded, independently
    // reviewable partial answer or its mandatory source cautions.
    const rescued=await failure(true,"no_progress");
    if(rescued.reply.blocks.some(block=>block.type==="text"))
      return rescued;
    return await askForHelp(question,capabilityId,args)??rescued;
  };
  const datasets=new Map<string,StoredDataset>();
  const registry=createP3ReadRegistry([...buildAlexP3Registrations(),...buildOliviaP3Registrations(),
    buildAlexPricingRegistrations()[0],buildOliviaInvestigationRegistration(),
    buildDatasetRegistration(datasets,identity.businessId),buildRecordsRegistration(()=>observations,identity.businessId),buildResearchRegistration(()=>[
      ...observations.filter(o=>o.result.id==="business.profile").flatMap(o=>{
        const value=o.result.value;
        return record(value)&&Array.isArray(value.locations)?value.locations.filter(record)
          .flatMap(l=>[l.city,l.region,l.countryCode].filter((v):v is string=>typeof v==="string")):[];
      }),
    ].join(" "),async(clause,query,publicLocationContext)=>{
      const checked=await requestInvestigation({name:"supervisor_public_query_review",
        schema:z.strictObject({safe:z.boolean()}),instructions:publicQueryReviewInstructions,
        context:{ownerRequest:input.text,quotedResearchClause:clause,proposedQuery:query,publicLocationContext},
        apiKey:input.apiKey,model:input.model,transport,usage,
        // The public privacy review plus search share a ten-second reader
        // timeout. Never borrow the answer/review's final 36 seconds.
        deadline:Math.min(deadline-INVESTIGATION_LIMITS.providerTimeoutMs*2-10000,
          Date.now()+7000),reserveModelCalls:2,onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
      return !!checked&&!isToolCallSignal(checked)&&checked.safe===true;
    })]);
  const manifest=registry.discover(scope).filter(m=>!isRedundantModelRead(m.id));
  const visibleIds=new Set(modelVisibleIds(manifest.map(m=>m.id)));
  const independentP1Ids=new Set((Object.keys(values) as SupportedId[]).map(k=>"p3."+k+".v1"));
  // Native function-calling tools: one per discovered read capability, plus
  // the registered expression calculator. toolNameToCapabilityId maps a
  // tool call's name back to the real capability/calculate id; the model
  // never sees or invents the dotted capability id directly in a tool name.
  const toolNameToCapabilityId=new Map<string,string>(
    manifest.map(m=>[capabilityToolName(m.id),m.id] as const));
  toolNameToCapabilityId.set(CALCULATE_TOOL_NAME,EXPRESSION_ID);
  for(const tool of input.inertProposal?.tools??[]){
    if(toolNameToCapabilityId.has(tool.name))throw new Error("Duplicate proposal tool name");
    toolNameToCapabilityId.set(tool.name,"inert_proposal:"+tool.name);
  }
  const investigationTools:ToolDef[]=[
    ...manifest.filter(m=>visibleIds.has(m.id)).map(m=>({
      name:capabilityToolName(m.id),
      description:(m.purpose+" "+
        (m.id.startsWith("p3.")&&m.id.endsWith(".v1")?
          (()=>{const key=m.id.slice(3,-3) as Parameters<typeof outputFor>[0];
            try{return describeSourceFields(z.toJSONSchema(outputFor(key),{unrepresentable:"any",reused:"inline"}));}
            catch{return "";}})():"")).slice(0,1000),
      parameters:m.inputJsonSchema})),
    ...(input.inertProposal?.tools??[]),
    {name:CALCULATE_TOOL_NAME,
      description:"Combine already-authorized operand handles (from authorizedOperands) using the "+
        "registered expression engine's typed postfix nodes: source(handle), hypothetical, convert, "+
        "add/subtract/multiply/divide/ratio/scenario_delta/compare/loaded_labor. Never business arithmetic "+
        "outside this calculator.",
      parameters:z.toJSONSchema(planSchema,{unrepresentable:"any",reused:"inline"})},
  ];
  const observations:Observation[]=[],evidence:ShadowEvidence[]=[],remembered:InvestigationMemory["reads"]=[];
  const attempted=new Set<string>();
  const calendarReviews=new Map<string,"applies"|"unrelated"|"ambiguous">();
  const calendarScopes:NonNullable<InvestigationMemory["calendarScopes"]>=[];
  const ownerText=scope.ownerContext;
  let feedback:string|null=null;
  // §1 adaptive budget: a round that repeats a prior attempt verbatim, with
  // no new information, stops the loop immediately rather than waiting out
  // the remaining time/call budget. Tracks the exact unregistered tool name
  // last rejected, and the exact direct-answer draft last rejected.
  let lastUnknownToolName:string|null=null;
  let lastRejectedAnswerSignature:string|null=null;
  let lastDuplicateCapability:string|null=null;
  let lastDuplicateObservationCount=-1;
  let lastDuplicateBatch:string|null=null;
  for(let round=0;usage.modelCallCount<INVESTIGATION_LIMITS.modelCalls-1&&Date.now()<deadline;round++){
    // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
    // Logs whatever specific retry feedback (§5b/§6) the PREVIOUS round's
    // rejection carried into this one -- every feedback-setting site in the
    // loop is captured here in one place, without needing a call at each.
    if(feedback)logSupervisorDebugPayload({point:"retry_feedback",requestId:debugRequestId,round,feedback});
    const projection=projectP1Evidence(evidence,identity.businessId,input.text,null,ownerStatements,undefined,"authorized_selection",120);
    const aggregates=datasetOperands(observations,scope);
    const operands=[...projection.operands,...aggregates.operands];
    const bindings=[...projection.bindings,...aggregates.bindings];
    const views=observations.map(o=>({id:o.id,capabilityId:o.capabilityId,input:o.input,
      result:preview(o.result),displayTokens:Object.fromEntries(Object.entries(o.display).slice(0,100)),
      datasetFields:o.datasetFields,collections:recordCollections(o.result.value),previewOnly:true}));
    logSupervisorDebugPayload({point:"round_context",requestId:debugRequestId,round,
      observations:views,authorizedOperands:operands,bindings,availableCapabilities:manifest.map(m=>m.id),
      previousFeedback:feedback,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
    if(Buffer.byteLength(JSON.stringify(views))>INVESTIGATION_LIMITS.observationsBytes)
      return await failure(true,"observations_too_large");
    // Reserve one model attempt for an answer and one for its independent
    // evidence/coverage review. Provider retries also share this ledger.
    // Five real operations must never crowd out the final answer.
    // In the worst case another selection takes a full provider timeout and
    // the selected registered reader takes ten seconds. Those cannot consume
    // the time reserved for the answer and independent evidence review.
    // A failed-turn owner correction may require an extra calendar-context
    // model review (outside the reader's 10s timeout). This is possible only
    // when a newer owner statement follows the last persisted reply.
    const savedLast=memory?.ownerStatements.at(-1);
    const priorOwnerStatements=ownerStatements.slice(0,-1);
    const savedIndex=savedLast?priorOwnerStatements.lastIndexOf(savedLast):-1;
    // Whether a current phrase is a period or a scheduling week depends on
    // the *selected* typed capability, not a generic string check. Before
    // selection we must conservatively reserve review time if an intervening
    // owner statement contains any recognized dated correction. Undated
    // retries still avoid this extra reservation.
    const mayNeedCalendarReview=savedIndex>=0&&
      priorOwnerStatements.slice(savedIndex+1).some(s=>hasInvestigationOwnerCalendarDate(s,identity.asOf));
    const timeNeededForAnotherOperation=INVESTIGATION_LIMITS.providerTimeoutMs*
      (mayNeedCalendarReview?4:3)+10000;
    const finalizeOnly=usage.toolCallCount>=INVESTIGATION_LIMITS.operations||
      usage.modelCallCount>=INVESTIGATION_LIMITS.modelCalls-2||
      deadline-Date.now()<=timeNeededForAnotherOperation;
    // A malformed selection may be retried by requestInvestigation. Both
    // attempts must SHARE this capped window: never let the retry borrow the
    // reader's 10s or the answer+audit's 36s (plus calendar-gate time).
    // Final drafting itself may retry on a malformed provider response. Give
    // all drafting attempts one shared window, preserving an independent full
    // provider slot to review the answer before publishing.
    const selectionDeadline=finalizeOnly?deadline-INVESTIGATION_LIMITS.providerTimeoutMs:
      deadline-(timeNeededForAnotherOperation-INVESTIGATION_LIMITS.providerTimeoutMs);
    let step:InvestigationAnswer|ToolCallSignal|null;
    try {
      step=await requestInvestigation({name:"supervisor_investigation_step",schema:answerSchema,
      instructions:finalizeOnly?investigationInstructions+
        " This is the FINAL investigation step. Answer now from observations; explain any precise missing source or request a specific essential clarification. Do not choose another tool, invent facts or claim changes.":investigationInstructions,
      // Native function calling: the model either calls one of these registered
      // tools (mapped back to a real capability below) or, with none offered
      // in a finalize-only round, must answer directly in the shape above --
      // never a second hand-written envelope describing which path it took.
      tools:finalizeOnly?undefined:investigationTools,
      context:{ownerRequest:input.text,locale:input.locale,
        calendar:calendar(identity.asOf),timezone:identity.timezone,currency:identity.currency,
        ownerStatements,previousConversation:input.history.slice(-6),rememberedSelectors:memory?.reads??[],
        capabilities:manifest.filter(m=>visibleIds.has(m.id)).map(m=>({
          id:m.id,purpose:m.purpose,currencyPolicy:m.currencyPolicy,inputSchema:m.inputJsonSchema})),
        capabilityLimitations:{financialSnapshot:financialReadsAvailable?"available_or_provisional":"unavailable; financial evidence must not be used",inventory:"No verified stock count or inventory feed is connected.",
          writes:input.inertProposal?
            "Only registered inert proposal drafting is permitted. It needs explicit owner trial intent and exact verified menu/cent input; approval, POS price change and effect commitment require separate owner actions.":
            "Business mutations and publication are not executable in this read/simulation conversation."},
        observations:views,authorizedOperands:operands.map(o=>({handle:o.handle,unit:o.unit,period:o.period,
          sourceId:o.sourceId,sourceQuality:o.status,entity:projection.choices.find(c=>c.handle===o.handle)?.entityName})),
        remainingModelCalls:INVESTIGATION_LIMITS.modelCalls-usage.modelCallCount,
        remainingOperations:INVESTIGATION_LIMITS.operations-usage.toolCallCount,finalizeOnly,feedback,
        // New failure category: push toward a clarification question instead
        // of silently averaging/picking one value, when the same fact has
        // come back with more than one distinct value this turn.
        conflictingFacts:detectConflictingFacts(observations)},
      apiKey:input.apiKey,model:input.model,transport,usage,deadline:selectionDeadline,
      selectionBudgetDeadline:!finalizeOnly,
      // A malformed late planning response must not spend the two calls still
      // required to author and independently verify the final answer.
      reserveModelCalls:finalizeOnly?1:2,onUsage:input.onUsage,
      onDiagnostic:input.onDiagnostic});
    }catch(error){
      // A nonfinal selection that reached ONLY its reserved selection window
      // can still finish with a normal, independently checked partial answer.
      // Genuine transport/provider failures retain their existing error path.
      if(!finalizeOnly&&error instanceof SupervisorStageError&&
        error.category==="provider_timeout"&&
        error.providerErrorCode==="investigation_selection_deadline"){
        feedback="The selection budget was exhausted. Answer from validated observations; explain any missing input.";
        continue;
      }
      throw error;
    }
    if(!step){
      // Earlier malformed outputs already receive their bounded retry.
      // If that retry could not run because finalization slots are reserved,
      // switch to answer-only with the evidence collected so far.
      if(!finalizeOnly&&(usage.modelCallCount>=INVESTIGATION_LIMITS.modelCalls-2||
        Date.now()>=selectionDeadline)){
        feedback="A previous investigation instruction could not be validated. Answer now with verified observations and the specific remaining limitation.";
        continue;
      }
      return await failure(false,"model_calls");
    }
    feedback=null;
    if(isToolCallSignal(step)&&step.calls&&step.calls.length>1){
      // Native multi-call selections may dispatch only independent P1 reads.
      // Domain simulations, calculations, derived dataset/record inspections,
      // and requests that need a previous result stay in the normal serial
      // loop. The entire batch is preflighted BEFORE any reader starts.
      const selected=step.calls.map(call=>{
        const capabilityId=toolNameToCapabilityId.get(call.name);
        const definition=manifest.find(m=>m.id===capabilityId);
        let args:unknown;
        try{args=JSON.parse(call.arguments);}catch{return null;}
        return capabilityId&&definition&&independentP1Ids.has(capabilityId)?
          {call,capabilityId,definition,args}:null;
      });
      const requests=selected.filter((v):v is NonNullable<typeof v>=>v!==null);
      // JSON object-key order is not part of an authorized selector. Compare
      // normalized selectors before dispatch so two equivalent period reads
      // cannot run concurrently and consume separate operation slots.
      const signatures=requests.map(v=>JSON.stringify(
        canonicalSelector(["read",v.capabilityId,v.args])));
      const sourceSelections=requests.map(v=>JSON.stringify(canonicalSelector([
        v.definition.canonicalReaderIds,
        record(v.args)&&record(v.args.period)?v.args.period:null,
        record(v.args)?v.args.productId??null:null,
        record(v.args)?v.args.page??null:null,
      ])));
      const canDispatch=requests.length===step.calls.length&&
        usage.toolCallCount+requests.length<=INVESTIGATION_LIMITS.operations&&
        new Set(signatures).size===signatures.length&&
        new Set(sourceSelections).size===sourceSelections.length&&
        signatures.every(sig=>!attempted.has(sig))&&
        // All-or-nothing registered input validation before starting any
        // sibling: schema, unknown fields, role, purpose, byte/range limits.
        requests.every(v=>registry.preflightRead(scope,v.capabilityId,v.args))&&
        requests.every(v=>
          (v.definition.currencyPolicy==="independent"||
            identity.currency==="USD"&&financialReadsAvailable)&&
          investigationReadDatesMatch(v.args,input.text,identity.asOf,memory,ownerStatements,
            v.definition.owner,id=>manifest.find(m=>m.id===id)?.owner)&&
          !pendingOwnerCalendarCorrection(v.args,input.text,identity.asOf,memory,ownerStatements));
      if(!canDispatch){
        // An identical rejected selection without new observations cannot make progress,
        // even when only one sibling was previously attempted.
        const duplicateBatch=JSON.stringify({
          calls:step.calls.map(call=>{
            let parsed:unknown=call.arguments;
            try{parsed=JSON.parse(call.arguments);}catch{/* malformed JSON is still a stable signature */}
            return JSON.stringify([call.name,canonicalSelector(parsed)]);
          }).sort(),
          observationCount:observations.length,
          rejection:"parallel_preflight",
        });
        if(duplicateBatch&&duplicateBatch===lastDuplicateBatch)
          return await askWhenStuck({
            en:en.SupervisorOwnerHelp.stuckDetail,
            es:es.SupervisorOwnerHelp.stuckDetail,
            ar:ar.SupervisorOwnerHelp.stuckDetail,
          });
        lastDuplicateBatch=duplicateBatch;
        feedback="This multi-tool selection is dependent, redundant, out of scope, or over budget. Choose independent authorized source reads only; use a canonical structured source once, then calculate from its returned operands. Otherwise make one sequential request.";
        logSupervisorDebugPayload({point:"parallel_batch",requestId:debugRequestId,round,
          outcome:"rejected_preflight",requested:step.calls.map(c=>({name:c.name,arguments:c.arguments,callId:c.callId})),
          preflight:{allCallsSupported:requests.length===step.calls.length,
            withinOperationBudget:usage.toolCallCount+requests.length<=INVESTIGATION_LIMITS.operations,
            canonicalSelectorsUnique:new Set(signatures).size===signatures.length,
            canonicalSourcesUnique:new Set(sourceSelections).size===sourceSelections.length,
            neverAttemptedBefore:signatures.every(sig=>!attempted.has(sig)),
            registeredInputsValid:requests.every(v=>registry.preflightRead(scope,v.capabilityId,v.args)),
            perCall:requests.map(v=>({
              callId:v.call.callId,capabilityId:v.capabilityId,
              currencyAndSnapshotPermitted:v.definition.currencyPolicy==="independent"||
                (identity.currency==="USD"&&financialReadsAvailable),
              datesMatch:investigationReadDatesMatch(v.args,input.text,identity.asOf,memory,
                ownerStatements,v.definition.owner,id=>manifest.find(m=>m.id===id)?.owner),
              noPendingCalendarCorrection:!pendingOwnerCalendarCorrection(v.args,input.text,
                identity.asOf,memory,ownerStatements),
              registryPreflight:registry.preflightRead(scope,v.capabilityId,v.args),
            }))}});
        continue;
      }
      lastDuplicateBatch=null;
      for(const signature of signatures)attempted.add(signature);
      logSupervisorDebugPayload({point:"parallel_batch",requestId:debugRequestId,round,
        outcome:"concurrent",requested:requests.map(v=>v.capabilityId)});
      // Each registry invocation validates its own typed parameters, scope
      // and time budget. Promise.all preserves the model's requested order
      // for stable r1/r2 citation IDs even if a later reader finishes first.
      const completed=await Promise.all(requests.map(async selectedRead=>{
        let dispatched=false;
        const operationStartedAt=Date.now();
        const result=await registry.invoke(scope,selectedRead.capabilityId,selectedRead.args,()=>{
          dispatched=true;
          usage.toolCallCount++;
          input.onUsage?.({...usage});
        });
        return {...selectedRead,result,dispatched,durationMs:Date.now()-operationStartedAt};
      }));
      for(const item of completed){
        const {capabilityId,args,result,dispatched,durationMs,definition,call}=item;
        const awaiting=await ownerInputReply(capabilityId,args,result);
        if(awaiting)return awaiting;
        if(!record(result)){feedback="A parallel source returned an invalid result.";continue;}
        if(dispatched){
          const cal=investigationCalendarScope(args,definition.owner);
          if(cal)calendarScopes.push(cal);
        }
        const id="r"+(observations.length+1);
        const successful=["partial","verified","estimated","conditional"].includes(String(result.status));
        const rendered=successful?observationDisplay(result,input.locale):{display:{},kind:{},raw:{}};
        const observation:Observation={id,capabilityId,input:args,result,
          sourceContract:typeof result.id==="string"?result.id:undefined,
          reference:successful?observationReference(identity.businessId,identity.asOf,capabilityId,result):null,
          requiresSnapshot:definition.currencyPolicy!=="independent",
          display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw,calculation:false};
        if(successful){
          const quality=record(result.quality)?result.quality:null;
          if(quality&&Array.isArray(quality.missingInputs)&&Array.isArray(quality.estimatedInputs)&&
            Array.isArray(quality.staleInputs)){
            const sourceId=typeof result.id==="string"?result.id:capabilityId;
            const dataset=datasetFor(sourceId,result.value,quality as {
              missingInputs:string[];estimatedInputs:string[];staleInputs:string[]});
            if(dataset){datasets.set(id,{sourceId,dataset,revision:null});observation.datasetFields=dataset.fields;}
          }
          evidence.push({clause:input.text,capabilityId,
            status:result.status as "partial"|"verified"|"estimated",result,reason:null});
          remembered.push({capabilityId,inputJson:JSON.stringify(args)});
        }
        observations.push(observation);
        logSupervisorDebugPayload({point:"tool_result",requestId:debugRequestId,round,
          callId:call.callId,capabilityId,toolArguments:args,result,observationId:id,
          dispatched,parallel:true,durationMs});
        input.onDiagnostic?.({stage:"investigation_round",agent:friendlyAgent(definition.owner),
          capabilityId,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
      }
      continue;
    }
    if(!isToolCallSignal(step)){
      // The model answered directly (no tool call) -- already schema-valid
      // against answerSchema, with no second hand-written envelope around it.
      input.onDiagnostic?.({stage:"investigation_round",agent:"supervisor",
        modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
      let answer:InvestigationAnswer=step;
      // Adaptive budget (section 1): an EXACT repeat of a previously-rejected
      // draft, with no new information, stops the loop immediately rather
      // than waiting out the remaining budget. "No new information" is tied
      // to the OBSERVATION STATE at the time of that earlier rejection
      // (Codex finding #2): if round N's draft cited an observation that
      // didn't exist yet (rejected), and a later round's read actually
      // produces it, resubmitting the identical draft is potential progress,
      // not a repeat, even though the draft text itself is byte-identical.
      const answerSignature=JSON.stringify({answer,observationCount:observations.length});
      if(answerSignature===lastRejectedAnswerSignature)
        return await askWhenStuck({en:en.SupervisorOwnerHelp.additionalDetail,
          es:es.SupervisorOwnerHelp.additionalDetail,
          ar:ar.SupervisorOwnerHelp.additionalDetail});
      // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
      logSupervisorDebugPayload({point:"direct_answer_attempt",requestId:debugRequestId,round,
        ownerQuestion:input.text,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,
        rawAnswerParagraphs:answer.paragraphs,
        availableObservations:observations.map(o=>({id:o.id,capabilityId:o.capabilityId,
          value:o.result.value,status:o.result.status,displayRaw:o.displayRaw}))});
      let rendered=renderInvestigationAnswer(answer,observations,input.locale,{ownerText});
      let reply=investigationReply(answer,observations,input.locale,{ownerText});
      logSupervisorDebugPayload({point:"answer_rendered",requestId:debugRequestId,round,
        rawAnswer:answer,renderedAnswer:rendered,replyCandidate:reply,
        availableObservationIds:observations.map(o=>o.id)});
      if(!rendered||!reply){
        // Nothing in this draft survived even claim-level masking (section 3)
        // -- e.g. every paragraph was dropped for a structural citation
        // problem. A real citation only proves the id exists, not that the
        // surrounding prose is actually supported by it or covers the
        // owner's goal -- run the exact same independent review a grounded
        // answer must pass before this candidate is ever trusted as a
        // rescue, using the stripped text in place of the rendered blocks
        // the strict renderer never produced. Never cache anything the
        // review could not confirm, and never spend budget on this extra
        // call unless there is a real citation-grounded candidate to check.
        const rescued=renderUnverifiedAnswer(answer,observations,input.locale);
        if(rescued){
          const rescueReview:ReviewVerdict|ToolCallSignal|null=await requestInvestigation({name:"supervisor_investigation_review",schema:reviewSchema,
            instructions:reviewInstructions,context:{ownerRequest:input.text,ownerLocale:input.locale,ownerStatements,observations:views,
              proposedAnswer:answer,renderedAnswer:[{type:"text",text:rescued.text}]},
            apiKey:input.apiKey,model:input.model,transport,usage,deadline,onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
          // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
          logSupervisorDebugPayload({point:"rescue_review_verdict",requestId:debugRequestId,round,
            supported:rescueReview&&!isToolCallSignal(rescueReview)?rescueReview.supported:null,
            complete:rescueReview&&!isToolCallSignal(rescueReview)?rescueReview.complete:null,
            reason:rescueReview&&!isToolCallSignal(rescueReview)?rescueReview.reason:null});
          if(rescueReview&&!isToolCallSignal(rescueReview)&&rescueReview.supported)
            lastUnverifiedAnswer={...rescued,
              missingGoalReason:rescueReview.complete?undefined:rescueReview.reason};
        }
        feedback="Use exact supplied display tokens for numbers/dates/URLs and valid evidence citations. Advice is not a café observation.";
        lastRejectedAnswerSignature=answerSignature;
        input.onDiagnostic?.({stage:"investigation_round",agent:"supervisor",
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,answerRejectedReason:"render_failed"});
        continue;
      }
      if(rendered.issues.length){
        // Section 7: remember the best-surviving candidate across the WHOLE
        // loop, not just the final attempt, in case nothing cleaner ever
        // arrives before the budget runs out.
        updateBestAccumulated(reply,rendered.issues.length,answer);
        // Section 5: one bounded, narrow extraction attempt for the FIRST
        // plain unmatched number that has no cheap direct match (one already
        // matching a real observation gets told to cite it instead, per
        // section 5b -- never routed through this heavier machinery).
        const extractable=!finalizeOnly&&rendered.issues.find(
          (i):i is ClaimIssue&{kind:"unmatched_number"}=>i.kind==="unmatched_number"&&!i.matchedObservation);
        if(extractable){
          const targetParagraph=answer.paragraphs[extractable.paragraphIndex];
          const extraction=await requestInvestigation({name:"supervisor_formula_extraction",schema:formulaExtractionSchema,
            instructions:formulaExtractionInstructions,
            context:{ownerRequest:input.text,ownerLocale:input.locale,ownerStatements,paragraphText:targetParagraph?.text??"",
              targetClaim:extractable.text,observations:views},
            apiKey:input.apiKey,model:input.model,transport,usage,deadline,reserveModelCalls:2,
            onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
          const extracted=extraction&&!isToolCallSignal(extraction)?extraction.extracted:null;
          if(extracted&&verifyFormulaEntry(extracted,ownerText,observations,input.locale).ok){
            const patched:InvestigationAnswer={paragraphs:answer.paragraphs.map((p,i)=>
              i!==extractable.paragraphIndex?p:{...p,formulas:[...(p.formulas??[]),extracted]})};
            const reRendered=renderInvestigationAnswer(patched,observations,input.locale,{ownerText});
            const reReply=investigationReply(patched,observations,input.locale,{ownerText});
            if(reRendered&&reReply&&reRendered.issues.length<rendered.issues.length){
              answer=patched;rendered=reRendered;reply=reReply;
              // The just-improved candidate strictly dominates the one
              // recorded above (fewer masked claims) -- update §7's
              // best-so-far too, or exhaustion later in this same turn could
              // still fall back to the STALE, more-masked pre-extraction
              // version even though a verified, better one now exists.
              updateBestAccumulated(reply,reRendered.issues.length,answer);
            }
          }
        }
      }
      if(rendered.issues.length){
        // Section 5b: ask before you mask. Budget remains (another round is
        // still possible) -- always prefer a precise, specific retry over
        // masking, which is reached only once retries are exhausted (the
        // accumulated fallback inside failure()).
        feedback=buildClaimFeedback(rendered.issues);
        lastRejectedAnswerSignature=answerSignature;
        // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
        logSupervisorDebugPayload({point:"claim_issues_retry",requestId:debugRequestId,round,
          issues:rendered.issues,feedback});
        input.onDiagnostic?.({stage:"investigation_round",agent:"supervisor",
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,answerRejectedReason:"render_failed"});
        continue;
      }
      const review:ReviewVerdict|ToolCallSignal|null=await requestInvestigation({name:"supervisor_investigation_review",schema:reviewSchema,
        instructions:reviewInstructions,context:{ownerRequest:input.text,ownerLocale:input.locale,ownerStatements,observations:views,
          proposedAnswer:answer,renderedAnswer:rendered.blocks},apiKey:input.apiKey,model:input.model,
        transport,usage,deadline,onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
      const reviewReason:string|null=review&&!isToolCallSignal(review)?review.reason:null;
      // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
      logSupervisorDebugPayload({point:"review_verdict",requestId:debugRequestId,round,
        supported:review&&!isToolCallSignal(review)?review.supported:null,
        complete:review&&!isToolCallSignal(review)?review.complete:null,reason:reviewReason});
      // Keep server-produced facts AND source-grounded narrative that passed
      // the claim-by-claim renderer. A valid text-only source description must
      // not vanish just because it has no numeric value suitable for a box.
      // Do not preserve unrelated free-form advice or unsupported action
      // assertions merely because another paragraph cites a real source.
      const safeParagraphBlocks=new Set<string>();
      const safeParagraphSources=new Set<string>();
      // The independent reviewer must positively identify each semantically
      // valid paragraph. A model-authored sentence citing a real field is
      // never sufficient to prove an unrelated effect or completed action.
      const reviewerSafeParagraphs=new Set<number>(
        review&&!isToolCallSignal(review)?review.supportedParagraphIndices??[]:[]);
      answer.paragraphs.forEach((paragraph,index)=>{
        if(!reviewerSafeParagraphs.has(index)||paragraph.kind!=="evidence"||
          rendered.issues.some(issue=>issue.paragraphIndex===index))return;
        const checked=renderInvestigationAnswer({paragraphs:[paragraph]},observations,input.locale,
          {ownerText:input.text});
        if(!checked||checked.issues.length||!checked.evidence.length)return;
        // A boxed metric inside an unsupported "I published..." paragraph
        // is not a license to keep that paragraph OR its box. Both must
        // originate in a paragraph that independently passed these checks.
        for(const block of checked.blocks)
          safeParagraphBlocks.add(JSON.stringify(block));
        for(const source of checked.evidence)
          safeParagraphSources.add(source.identifier);
      });
      const safeReviewBlocks=reply.blocks.filter(block=>{
        if(block.type==="warning")return true;
        if(block.type==="task_card"||block.type==="task_status")
          return safeParagraphSources.has(block.source.identifier);
        return safeParagraphBlocks.has(JSON.stringify(block));
      });
      const hasSafeReviewFacts=safeReviewBlocks.some(block=>block.type!=="warning");
      let downgradedByReview=false;
      if(review&&!isToolCallSignal(review)&&!review.supported&&hasSafeReviewFacts){
        downgradedByReview=true;
        reply={...reply,status:"partial",blocks:[
          ...safeReviewBlocks,
          ...(safeReviewBlocks.length<30?[missingGoalWarning(review.reason,review.missingGoalDomain)]:[]),
        ]};
        input.onDiagnostic?.({stage:"grounded_answer",failureCategory:"reviewer_downgraded_to_partial"});
      }
      if(review&&!isToolCallSignal(review)&&!review.supported&&!downgradedByReview&&review.complete){
        input.onDiagnostic?.({stage:"investigation_round",failureCategory:"reviewer_hard_fail"});
        // An OR-positive verdict must produce a user-visible reply, but the
        // reviewer has NOT certified these factual claims. Never publish
        // the rejected draft, even with a disclaimer about invented numbers.
        return {reply:{intent:"unknown",status:"insufficient_evidence",evidence:[],
          blocks:[{type:"warning",code:"SUPERVISOR_UNVERIFIED",
            text:labels.unverifiedWarning},
            {type:"text",text:labels.unavailable}]},usage:{...usage}};
      }
      if(!review||isToolCallSignal(review)||(!review.supported&&!downgradedByReview)){
        // A valid verdict always carries its own specific reason now (§6):
        // name exactly what the reviewer found, instead of the generic line
        // that used to be the only signal across every retry (production
        // incident: two otherwise-clean, well-cited drafts were rejected
        // with no way to tell why, and exhausted repeating the same
        // unspecific feedback until the call budget ran out).
        input.onDiagnostic?.({stage:"investigation_round",failureCategory:"reviewer_hard_fail"});
        feedback=reviewReason?
          "The independent review found this specific issue: \""+reviewReason+
            "\". Correct exactly that, or ask the specific unresolved question.":
          "The answer failed independent evidence or full-goal coverage review. Correct it or ask the specific unresolved question.";
        lastRejectedAnswerSignature=answerSignature;
        input.onDiagnostic?.({stage:"investigation_round",agent:"supervisor",
          modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount,
          // A valid negative verdict (the reviewer actually judged the answer
          // unsupported/incomplete) is a distinct signal from the review
          // never having run at all (budget exhaustion or an unrecoverable
          // malformed response) -- the latter must not be mistaken for the
          // model repeatedly failing review when no reviewer ever weighed in.
          answerRejectedReason:review&&!isToolCallSignal(review)?"review_failed":"review_unavailable"});
        continue;
      }
      // Reauthorize at publication time. A changed café or epoch invalidates the
      // investigation; no data from the later snapshot is mixed with earlier reads.
      const latestOwner=await authorizedOwnerP1();
      if(latestOwner.identity.businessId!==identity.businessId||latestOwner.identity.timezone!==identity.timezone||
        latestOwner.identity.currency!==identity.currency||latestOwner.identity.asOf!==identity.asOf)
        return await failure(false,"identity_mismatch");
      if(!financialReadsAvailable&&observations.some(o=>o.requiresSnapshot&&reply!.evidence.some(r=>r.identifier===o.reference?.identifier)))
        return await failure(false,"snapshot_mismatch");
      if(atomic.status==="available"&&observations.some(o=>o.reference&&o.requiresSnapshot)){
        const latest=await readAuthorizedAtomicP1SourceSnapshot();
        if(latest.status!=="available"||latest.snapshot.businessId!==identity.businessId||
          latest.snapshot.revision!==atomic.snapshot.revision)return await failure(false,"snapshot_mismatch");
      }
      if(!review.complete&&!downgradedByReview)reply={...reply!,status:"partial",
        blocks:reply!.blocks.length<30?
          [...reply!.blocks,missingGoalWarning(review.reason,review.missingGoalDomain)]:reply!.blocks};
      // Reviewed clarification paragraphs use the SAME ownerInputReply
      // dispatcher, durable pending state, auth and snapshot guards as domain
      // missing-data requests. This path cannot perform a domain write.
      if(review.supported&&!downgradedByReview){
        const clarification=answer.paragraphs.find(p=>p.kind==="clarification"&&p.citations.length===0);
        if(clarification){
          const known=input.inertProposal?.knownClarificationOptions?.()??[];
          const validOptions=known.length>=2&&known.length<=30&&known.every(o=>
            o.id&&o.label.en&&o.label.es&&o.label.ar);
          const hints={en:en.SupervisorChat.ownerInputAnswer,
            es:es.SupervisorChat.ownerInputAnswer,ar:ar.SupervisorChat.ownerInputAnswer};
          const title={en:clarification.text.slice(0,240),es:clarification.text.slice(0,240),
            ar:clarification.text.slice(0,240)};
          const request=ownerResolutionRequest({question:title,
            input:validOptions?{kind:"options",options:[...known]}:
              {kind:"free_text",hint:hints},
            context:validOptions?input.inertProposal?.knownClarificationContext?.():undefined});
          const awaiting=await ownerInputReply("platform.owner_input.resolve.v1",{},
            {status:"requires_owner_input",ownerInput:request});
          if(awaiting){
            if(reply.evidence.length>0&&awaiting.reply.ownerInput){
              // Do not drop separately review-approved facts when another
              // requested goal needs the owner's input. The evidence remains
              // on the durable reply next to a single pending question.
              // The rendered clarification is already an inert text block.
              // Replace that one block with the interactive question while
              // preserving independently reviewed evidence, cards and warnings.
              const renderedQuestion=renderInvestigationAnswer({paragraphs:[clarification]},
                observations,input.locale,{ownerText:input.text});
              const questionText=renderedQuestion?.blocks.find(block=>block.type==="text");
              const index=questionText?reply.blocks.findLastIndex(block=>
                block.type==="text"&&block.text===questionText.text):-1;
              const safeBlocks=reply.blocks.filter((_,i)=>i!==index).slice(0,29);
              return {reply:{...reply,status:"requires_owner_input",
                ownerInput:awaiting.reply.ownerInput,
                blocks:[...safeBlocks,...awaiting.reply.blocks]},usage:awaiting.usage};
            }
            return awaiting;
          }
        }
      }
      const state:InvestigationMemory={version:1,businessId:identity.businessId,ownerStatements,
        reads:rememberInvestigationReads(memory?.reads??[],remembered),
        calendarScopes:rememberCalendarScopes(memory?.calendarScopes??[],calendarScopes)};
      input.onDiagnostic?.({stage:"grounded_answer",groundedStatus:reply.status,
        modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
      return {reply:{...reply,investigationMemory:state},usage:{...usage}};
    }
    if(finalizeOnly){feedback="The last available turn must answer with available evidence, not request another operation.";continue;}
    if(usage.toolCallCount>=INVESTIGATION_LIMITS.operations){feedback="No operations remain. Give a partial answer or the specific missing input from observations.";continue;}
    const capabilityId=toolNameToCapabilityId.get(step.name);
    if(!capabilityId){
      // Adaptive budget (section 1): the exact same unregistered tool name
      // selected again, with no new information, stops the loop immediately
      // -- tied to the observation count at the time (Codex finding,
      // mirroring the rejected-answer-signature fix), since a successful
      // read performed in between genuinely is new information even though
      // this exact unknown name was tried before.
      const unknownToolSignature=step.name+":"+observations.length;
      if(unknownToolSignature===lastUnknownToolName)
        return await askWhenStuck({en:en.SupervisorOwnerHelp.unknownTool,
          es:es.SupervisorOwnerHelp.unknownTool,
          ar:ar.SupervisorOwnerHelp.unknownTool});
      lastUnknownToolName=unknownToolSignature;
      feedback="Unknown tool selection. Choose one of the registered capabilities.";
      logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
        reasonCode:"unknown_tool",toolName:step.name,feedback});continue;
    }
    let args:unknown;try{args=JSON.parse(step.arguments);}catch{
      if(capabilityId===EXPRESSION_ID)
        logSupervisorDebugPayload({point:"calculator_rejected",requestId:debugRequestId,round,
          reasonCode:"invalid_arguments_json",rawArguments:step.arguments});
      feedback="Tool arguments must be valid JSON.";
      logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
        reasonCode:"invalid_arguments_json",toolName:step.name,rawArguments:step.arguments,feedback});
      continue;
    }
    const signature=JSON.stringify(canonicalSelector([
      capabilityId===EXPRESSION_ID?"calculate":capabilityId.startsWith("inert_proposal:")?"propose":"read",capabilityId,args]));
    if(attempted.has(signature)){
      // Two consecutive redundant selections on one registered capability
      // with no intervening observation prove a no-progress loop.
      const duplicateAgain=lastDuplicateCapability===capabilityId&&
        lastDuplicateObservationCount===observations.length;
      lastDuplicateCapability=capabilityId;
      lastDuplicateObservationCount=observations.length;
      if(duplicateAgain)
        return await askWhenStuck({en:en.SupervisorOwnerHelp.repeatedTool,
          es:es.SupervisorOwnerHelp.repeatedTool,
          ar:ar.SupervisorOwnerHelp.repeatedTool},capabilityId,args);
      feedback="That exact operation has already been attempted. Use its result or a different investigation step.";
      logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
        reasonCode:"duplicate_attempt",capabilityId,toolArguments:args,feedback});
      continue;
    }
    lastDuplicateCapability=null;
    attempted.add(signature);
    if(capabilityId.startsWith("inert_proposal:")){
      // The MODEL only selects a typed registered tool. The authenticated
      // callback validates owner-authored cents and exact catalog identity,
      // then persists a draft. No model selection can approve or commit.
      const latestOwner=await authorizedOwnerP1();
      if(latestOwner.identity.businessId!==identity.businessId||
        latestOwner.identity.timezone!==identity.timezone||
        latestOwner.identity.currency!==identity.currency||
        latestOwner.identity.asOf!==identity.asOf)
        return await failure(false,"identity_mismatch");
      let created:{id:string;text:string}|null=null;
      try{created=await input.inertProposal?.create(step.name,args)??null;}
      catch{created=null;}
      if(!created){
        feedback="The requested draft was not grounded in exactly one owner-stated cent amount and one real unambiguous menu variant. Inspect the catalog or ask one clarification; never invent a proposal.";
        continue;
      }
      usage.toolCallCount++;
      input.onUsage?.({...usage});
      input.onDiagnostic?.({stage:"grounded_answer",agent:"alex",
        groundedStatus:"estimated",modelCallCount:usage.modelCallCount,
        toolCallCount:usage.toolCallCount});
      return {reply:{intent:"menu_pricing",status:"estimated",
        evidence:[{source:"pricing_engine",identifier:"supervisor-proposal:"+created.id,asOf:identity.asOf}],
        blocks:[{type:"text",text:created.text}]},usage:{...usage}};
    }
    logSupervisorDebugPayload({point:"tool_request",requestId:debugRequestId,round,
      callId:step.callId,capabilityId,toolArguments:args,parallel:false});
    input.onDiagnostic?.({stage:"investigation_round",
      agent:friendlyAgent(capabilityId===EXPRESSION_ID?"platform":manifest.find(m=>m.id===capabilityId)?.owner),
      capabilityId,modelCallCount:usage.modelCallCount,toolCallCount:usage.toolCallCount});
    let result:unknown;
    const operationStartedAt=Date.now();
    let calculation=false;
    let calculatorDispatched=false;
    let calculationPeriods:string[]=[];
    let readDomain:string|undefined;
    let readDispatched=false;
    if(capabilityId===EXPRESSION_ID){
      if(identity.currency!=="USD"){
        logSupervisorDebugPayload({point:"calculator_rejected",requestId:debugRequestId,round,
          reasonCode:"unsupported_currency",toolArguments:args,authorizedOperands:operands});
        feedback="The registered expression calculator supports USD only. Explain the currency limitation without relabeling local amounts or inventing conversions.";continue;
      }
      const plan=planSchema.safeParse(args);
      if(!plan.success){
        logSupervisorDebugPayload({point:"calculator_rejected",requestId:debugRequestId,round,
          reasonCode:"invalid_plan",toolArguments:args,issues:plan.error.issues});
        feedback="Select the registered expression contract and its typed nodes.";continue;
      }
      const handles=new Set(plan.data.nodes.flatMap(n=>n.op==="source"?[n.handle]:[]));
      const selected=operands.filter(o=>handles.has(o.handle));
      if(selected.length!==handles.size||selected.length>12){
        logSupervisorDebugPayload({point:"calculator_rejected",requestId:debugRequestId,round,
          reasonCode:"unknown_operand",toolArguments:args,requestedHandles:[...handles],
          authorizedHandles:operands.map(o=>o.handle)});
        feedback="One or more operand handles were not authorized, or the expression is too large.";continue;
      }
      calculationPeriods=selected.filter(o=>!o.handle.startsWith("dataset:")&&o.period!=null).map(o=>
        resolvedPeriod({period:{from:o.period!.from,to:o.period!.to}}));
      const selectedBindings=bindings.filter(b=>selected.some(o=>o.capabilityId===b.capabilityId));
      const simulationContext={businessId:identity.businessId,
        locationId:null,ownerMessage:ownerStatements.join("\n").slice(-4000),currency:identity.currency,
        operands:plan.data.purpose==="no_external_sources"?[]:selected,
        bindings:selectedBindings};
      logSupervisorDebugPayload({point:"calculator_input",requestId:debugRequestId,round,
        capabilityId:EXPRESSION_ID,modelPlan:args,validatedPlan:plan.data,
        simulationContext,selectedOperandHandles:[...handles]});
      result=await registry.invokeSimulation(scope,EXPRESSION_ID,plan.data,simulationContext,()=>{
        calculatorDispatched=true;
        usage.toolCallCount++;
        input.onUsage?.({...usage});
      });
      const checked=simulationOutputSchema.safeParse(result);
      if(!checked.success){
        logSupervisorDebugPayload({point:"calculator_rejected",requestId:debugRequestId,round,
          reasonCode:"calculator_invalid_result",toolArguments:args,rawResult:result,
          issues:checked.error.issues});
        feedback="The calculator could not validate its result.";
        logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
          reasonCode:"calculator_invalid_result",capabilityId,toolArguments:args,feedback});
        continue;
      }
      result=checked.data;
      logSupervisorDebugPayload({point:"calculator_result",requestId:debugRequestId,round,
        toolArguments:args,validatedPlan:plan.data,selectedOperands:selected,
        rawResult:result,result:checked.data,
        reasonCode:checked.data.status==="unavailable"?
          (calculatorDispatched?"calculation_unavailable":"simulation_input_rejected"):undefined,
        executed:calculatorDispatched,
        durationMs:Date.now()-operationStartedAt});
      calculation=true;
    }else{
      readDomain=manifest.find(m=>m.id===capabilityId)?.owner;
      if(!readDomain){
        feedback="Unknown or non-read capability. No effects are permitted.";
        logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
          reasonCode:"not_a_read_capability",capabilityId,toolArguments:args,feedback});
        continue;
      }
      // Preserve validated period/week selectors across date-free follow-ups,
      // including nested domain requests. Explicit new owner dates supersede them.
      let calendarText=input.text;
      const pending=pendingOwnerCalendarCorrection(args,input.text,identity.asOf,memory,ownerStatements);
      if(pending){
        const key=readDomain+":"+investigationCalendarScope(args,readDomain)?.kind+":"+pending;
        let verdict=calendarReviews.get(key);
        if(!verdict){
          const reviewed=await requestInvestigation({name:"supervisor_calendar_context_review",
            schema:z.strictObject({verdict:z.enum(["applies","unrelated","ambiguous"])}),
            instructions:calendarContextReviewInstructions,
            context:{currentOwnerRequest:input.text,pendingOwnerStatement:pending,ownerStatements,
              capability:manifest.find(m=>m.id===capabilityId),savedCalendarScopes:memory?.calendarScopes??[]},
            apiKey:input.apiKey,model:input.model,transport,usage,
            deadline:deadline-INVESTIGATION_LIMITS.providerTimeoutMs*2-10000,
            reserveModelCalls:2,onUsage:input.onUsage,onDiagnostic:input.onDiagnostic});
          verdict=(reviewed&&!isToolCallSignal(reviewed)?reviewed.verdict:undefined)??"ambiguous";
          calendarReviews.set(key,verdict);
        }
        if(verdict==="ambiguous"){
          const awaiting=await askForHelp({
            en:en.SupervisorOwnerHelp.dateClarification,
             es:es.SupervisorOwnerHelp.dateClarification,
             ar:ar.SupervisorOwnerHelp.dateClarification,
          },capabilityId,args);
          if(awaiting)return awaiting;
          feedback="The calendar scope is still unclear. Ask the owner to identify the relevant dates.";continue;
        }
        if(verdict==="applies")calendarText=pending;
      }
      if(!investigationReadDatesMatch(args,calendarText,identity.asOf,memory,ownerStatements,readDomain,
        id=>manifest.find(m=>m.id===id)?.owner)){
        feedback="That period differs from the owner's explicit or remembered calendar window. Keep the prior validated period unless the owner changes it.";
        logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
          reasonCode:"calendar_scope_mismatch",capabilityId,toolArguments:args,calendarText,feedback});
        continue;
      }
      const currencyPolicy=manifest.find(m=>m.id===capabilityId)!.currencyPolicy;
      if(currencyPolicy!=="independent"&&(identity.currency!=="USD"||!financialReadsAvailable)){
        feedback="This capability's financial contract is unavailable for the current currency or source snapshot. Use a currency-independent capability, general guidance or an owner-only hypothetical; do not invent conversions or observations.";
        logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
          reasonCode:"financial_scope_unavailable",capabilityId,toolArguments:args,
          currency:identity.currency,financialReadsAvailable,feedback});
        continue;
      }
      result=await registry.invoke(scope,capabilityId,args,()=>{
        // Fired strictly after typed registry preflight, before reader execution.
        // Domain failures still consume a real operation; malformed inputs do not.
        readDispatched=true;
        usage.toolCallCount++;
        input.onUsage?.({...usage});
      });
    }
    const awaiting=await ownerInputReply(capabilityId,args,result);
    if(awaiting)return awaiting;
    if(!record(result)){
      feedback="The tool result was invalid.";
      logSupervisorDebugPayload({point:"tool_rejected",requestId:debugRequestId,round,
        reasonCode:"invalid_result_envelope",capabilityId,toolArguments:args,result,feedback});
      continue;
    }
    // Preserve a typed date/week selector whenever the real domain reader was
    // dispatched, even if it returned an unavailable/unauthorized domain status.
    // A result reason must never be mistaken for a registry preflight verdict.
    if(readDomain&&readDispatched){
      const calendar=investigationCalendarScope(args,readDomain);
      if(calendar)calendarScopes.push(calendar);
    }
    const id="r"+(observations.length+1);
    const successful=["partial","verified","estimated","conditional"].includes(String(result.status));
    const pure=calculation&&Array.isArray(result.sourceHandles)&&result.sourceHandles.length===0;
    const parentReadId=typeof result.sourceReadId==="string"?result.sourceReadId:
      record(result.value)&&typeof result.value.sourceReadId==="string"?result.value.sourceReadId:null;
    const sourceHandles=Array.isArray(result.sourceHandles)?result.sourceHandles:[];
    const parents=calculation?observations.filter(o=>sourceHandles.some(
      handle=>typeof handle==="string"&&handle.startsWith("dataset:"+o.id+":"))):
      observations.filter(o=>o.id===parentReadId);
    // Dataset handles inherit their read's dependency through parents. Direct
    // P1 handles have no dataset parent, but still depend on financial source
    // state and must never bypass the publication-time snapshot reread.
    const directSourceRequiresSnapshot=calculation&&sourceHandles.some(
      handle=>typeof handle==="string"&&!handle.startsWith("dataset:"));
    const parentObservation=parents[0];
    const inheritedSource=parents.some(o=>o.reference?.source==="unverified_external")?"unverified_external":parentObservation?.reference?.source;
    const rendered=successful?observationDisplay(result,input.locale):{display:{},kind:{},raw:{}};
    const observation:Observation={id,capabilityId,input:args,result,
      sourceContract:parentObservation?.sourceContract??(typeof result.id==="string"?result.id:undefined),
      reference:successful&&!pure?observationReference(identity.businessId,identity.asOf,capabilityId,result,inheritedSource):null,
      requiresSnapshot:directSourceRequiresSnapshot||parents.some(o=>o.requiresSnapshot)||!calculation&&
        manifest.find(m=>m.id===capabilityId)?.currencyPolicy!=="independent",
      display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw,calculation,
      sourcePeriods:calculation?calculationPeriods:undefined};
    if(calculation&&typeof result.value==="number"&&typeof result.unit==="string"){
      observation.display.value=formatScenarioValue(result.value,result.unit as z.infer<typeof import("../p3/expression").unit>,input.locale);
      if(result.unit==="USD_cents"){observation.displayKind!.value="money";observation.displayRaw!.value=result.value;}
      else if(result.unit==="ratio_bps"){observation.displayKind!.value="percent";observation.displayRaw!.value=result.value;}
    }
    if(successful&&!calculation){
      const quality=record(result.quality)?result.quality:null;
      if(quality&&Array.isArray(quality.missingInputs)&&Array.isArray(quality.estimatedInputs)&&Array.isArray(quality.staleInputs)){
        const parent=capabilityId===RECORDS_ID&&typeof result.sourceReadId==="string"
          ?datasets.get(result.sourceReadId):undefined;
        const sourceId=parent?.sourceId??(typeof result.id==="string"?result.id:capabilityId);
        const dataset=datasetFor(sourceId,result.value,quality as {missingInputs:string[];estimatedInputs:string[];staleInputs:string[]});
        if(dataset){datasets.set(id,{sourceId,dataset,revision:null});observation.datasetFields=dataset.fields;}
      }
      evidence.push({clause:input.text,capabilityId,status:result.status as "partial"|"verified"|"estimated",result,reason:null});
      if(!capabilityId.startsWith("p3.platform.")&&!capabilityId.startsWith("p3.public."))
        remembered.push({capabilityId,inputJson:JSON.stringify(args)});
    }
    observations.push(observation);
    // TEMPORARY, TEST-ENVIRONMENT-ONLY -- see logSupervisorDebugPayload.
    logSupervisorDebugPayload({point:"capability_round",requestId:debugRequestId,round,
      capabilityId,callId:step.callId,toolArguments:args,rawResult:result,
      observationId:id,status:String(result.status),successful,
      durationMs:Date.now()-operationStartedAt,dispatched:calculatorDispatched||readDispatched});
  }
  return await failure(true,usage.modelCallCount>=INVESTIGATION_LIMITS.modelCalls-1?"model_calls":"time");
}
