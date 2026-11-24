import {createHash} from "node:crypto";
import type {PriorityDecision,PrioritySource} from "./contracts";

/** Tasks already published by their authoritative notice writer are not fresh
 * priority evidence. Retain them in their original inbox; never duplicate
 * their owner notification through Task 7. */
export const alreadyNotifiedTaskKinds=new Set([
  "priority_notice","commitment","event_plan","event_change","event_report",
]);
const volatile=new Set(["lastCheckedAt","last_checked_at","polledAt","polled_at",
  "seenAt","seen_at","updatedAt","updated_at","reconciledAt","reconciled_at"]);
/** Normalize JSON input deterministically before fingerprinting; no raw café
 * records or currency amounts are persisted in priority notices. */
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(!value||typeof value!=="object")return value;
  // External alert/task JSON may include __proto__. A null-prototype
  // accumulator preserves the key in the hash rather than mutating the object.
  const out:Record<string,unknown>=Object.create(null);
  for(const key of Object.keys(value).sort()){
    if(volatile.has(key))continue;
    const v=(value as Record<string,unknown>)[key];
    if(v!==undefined)out[key]=canonical(v);
  }
  return out;
}
function digest(s:string):string{
  return createHash("sha256").update(s).digest("hex");
}
export function priorityRevision(source:PrioritySource):string{
  // Rolling asOf/from/to report dates do not prove a business fact changed.
  // Re-open an anomaly only for a changed subject, severity or observed value.
  const sourceEvidence=source.evidence;
  const evidence=source.sourceType==="alert"&&source.kind==="business_anomaly"&&
    sourceEvidence&&typeof sourceEvidence==="object"&&!Array.isArray(sourceEvidence)
    ?Object.fromEntries(Object.entries(sourceEvidence).filter(([key,value])=>
      !["asOf","from","to"].includes(key)&&
      // This one legacy detector already certified missing physical counts.
      // Adding the explicit classification on refresh is not new evidence.
      !(key==="gapReason"&&value==="missing_business_input"&&
        (sourceEvidence as Record<string,unknown>).family==="data_gap"&&
        (sourceEvidence as Record<string,unknown>).subject==="stock_counts")))
    :sourceEvidence;
  return digest(JSON.stringify(canonical({
    type:source.sourceType,id:source.sourceId,kind:source.kind,
    // Seen-only alert acknowledgement is not new evidence; an actionable task
    // changing from needs_response to needs_owner materially changes duty.
    status:source.sourceType==="alert"?"open":source.status,
    dueAt:source.dueAt??null,confidence:source.confidence??null,
    severity:source.severity??null,dedupeKey:source.dedupeKey??null,
    evidence:evidence??null,
  })));
}
export function rankPriority(source:PrioritySource,now:Date):PriorityDecision{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid priority instant");
  const overdue=source.sourceType==="operating_task"&&
    source.dueAt!==null&&source.dueAt!==undefined&&
    Number.isFinite(Date.parse(source.dueAt))&&Date.parse(source.dueAt)<=now.getTime();
  const ownerAction=source.status==="needs_owner";
  // Severity is a class, not a small bonus: a verified critical café issue
  // must never lose to an ordinary overdue administrative task.
  // Within a class, age, owner action and confidence provide stable ordering.
  // Source severity is only actionable as critical when the evidence itself is
  // verified. An outage or incomplete provider snapshot is not a proven loss.
  const evidence=source.evidence;
  const record=evidence&&typeof evidence==="object"&&!Array.isArray(evidence)?
    evidence as Record<string,unknown>:null;
  const unverified=source.confidence==="unknown"||source.confidence==="low"||
    record?.quality==="partial"||record?.quality==="missing"||
    record?.quality==="stale"||record?.verified===false;
  const severityClass=!unverified&&source.severity==="critical"?300:
    !unverified&&source.severity==="high"?200:100;
  // An approved supplier draft is an owner-action item, never a generic cost anomaly.
  let priority=severityClass+((source.sourceType==="supplier_po"||source.sourceType==="supplier_dispatch")?30:
    ownerAction?25:source.sourceType==="alert"?15:10);
  if(overdue)priority+=20;
  if(source.confidence==="high")priority+=5;
  const revisionHash=priorityRevision(source);
  // This hash encodes scope and source identity, unlike a text-title dedupe.
  const stableKey=digest(source.businessId+":"+source.ownerUserId+":"+
    source.sourceType+":"+source.sourceId+":"+revisionHash);
  const reason=source.sourceType==="supplier_po"?
    "Supplier purchase-order draft needs your approval":
    source.sourceType==="supplier_dispatch"?
    "Approved order unresolved: was the supplier contacted by Gmail, phone or portal, and what did they confirm?":
    overdue?"Overdue item needs review":
    source.sourceType==="alert"?"Actionable café alert needs review":
    ownerAction?"Owner task needs review":"Task response needs review";
  return {source,revisionHash,priority,reason,stableKey};
}
/** Verified missing business inputs are actionable regardless of the source.
 * Readers attest absence only after a successful canonical read; uncertain
 * coverage and technical failures are recovery work, not owner requests.
 * Keep the previous stock-count receipt readable until its detector refresh. */
export function eligibleAlertEvidence(kind:string,evidence:unknown):boolean{
  if(kind!=="business_anomaly"||!evidence||typeof evidence!=="object"||Array.isArray(evidence))
    return true;
  const fact=evidence as Record<string,unknown>;
  if(fact.quality==="technical_failure"||fact.quality==="not_matured")return false;
  if(fact.family!=="data_gap")return true;
  return fact.quality==="missing"&&fact.current===1&&fact.unit==="coverage"&&
    (fact.gapReason==="missing_business_input"||
      (fact.gapReason===undefined&&fact.subject==="stock_counts"));
}
export function requiresOwnerAttention(source:PrioritySource):boolean{
  return source.sourceType!=="alert"||eligibleAlertEvidence(source.kind,source.evidence);
}
export function choosePriorities(sources:readonly PrioritySource[],now:Date,limit=3,
  options?:{includeWatching?:boolean}):PriorityDecision[]{
  const candidates=sources.filter(s=>requiresOwnerAttention(s)&&(
    (s.sourceType==="alert"&&(s.status==="new"||s.status==="seen"))||
    (s.sourceType==="operating_task"&&!alreadyNotifiedTaskKinds.has(s.kind)&&
      (s.status==="needs_owner"||s.status==="needs_response"||
       (options?.includeWatching===true&&s.status==="watching")))||
    (s.sourceType==="supplier_po"&&s.status==="draft")||
    (s.sourceType==="supplier_dispatch"&&s.status==="approved_for_ordering")))
    .map(s=>rankPriority(s,now));
  return candidates.sort((a,b)=>b.priority-a.priority||
    a.source.createdAt.localeCompare(b.source.createdAt)||
    a.stableKey.localeCompare(b.stableKey)).slice(0,Math.max(0,limit));
}
