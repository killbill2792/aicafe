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
  const out:Record<string,unknown>={};
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
  return digest(JSON.stringify(canonical({
    type:source.sourceType,id:source.sourceId,kind:source.kind,
    // Seen-only alert acknowledgement is not new evidence; an actionable task
    // changing from needs_response to needs_owner materially changes duty.
    status:source.sourceType==="alert"?"open":source.status,
    dueAt:source.dueAt??null,confidence:source.confidence??null,
    severity:source.severity??null,dedupeKey:source.dedupeKey??null,
    evidence:source.evidence??null,
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
  const severityClass=source.severity==="critical"?300:
    source.severity==="high"?200:100;
  let priority=severityClass+(ownerAction?25:source.sourceType==="alert"?15:10);
  if(overdue)priority+=20;
  if(source.confidence==="high")priority+=5;
  const revisionHash=priorityRevision(source);
  // This hash encodes scope and source identity, unlike a text-title dedupe.
  const stableKey=digest(source.businessId+":"+source.ownerUserId+":"+
    source.sourceType+":"+source.sourceId+":"+revisionHash);
  const reason=overdue?"Overdue item needs review":
    source.sourceType==="alert"?"Actionable café alert needs review":
    ownerAction?"Owner task needs review":"Task response needs review";
  return {source,revisionHash,priority,reason,stableKey};
}
export function choosePriorities(sources:readonly PrioritySource[],now:Date,limit=3):
  PriorityDecision[]{
  const candidates=sources.filter(s=>
    (s.sourceType==="alert"&&(s.status==="new"||s.status==="seen"))||
    (s.sourceType==="operating_task"&&!alreadyNotifiedTaskKinds.has(s.kind)&&
      (s.status==="needs_owner"||s.status==="needs_response")))
    .map(s=>rankPriority(s,now));
  return candidates.sort((a,b)=>b.priority-a.priority||
    a.source.createdAt.localeCompare(b.source.createdAt)||
    a.stableKey.localeCompare(b.stableKey)).slice(0,Math.max(0,limit));
}
