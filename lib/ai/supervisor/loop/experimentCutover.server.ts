import "server-only";

/** One per-café writer decision. Shadow mode may compare reads but MUST NOT
 * perform any new-path writes; legacy goals and check-ins stay enabled. */
export type ExperimentCutoverMode="legacy"|"shadow"|"new";
export type ExperimentCutoverGate={
 requested:unknown;
 parityProven:boolean;
 rollbackProven:boolean;
 releaseApproved:boolean;
};
export function resolveExperimentCutoverMode(gate:ExperimentCutoverGate):ExperimentCutoverMode{
 if(gate.requested==="shadow")return "shadow";
 if(gate.requested==="new"&&gate.parityProven===true&&
    gate.rollbackProven===true&&gate.releaseApproved===true)return "new";
 return "legacy";
}
export const legacyPriceWriterEnabled=(mode:ExperimentCutoverMode)=>
 mode!=="new";
export const newPriceWriterEnabled=(mode:ExperimentCutoverMode)=>
 mode==="new";
export const shadowPriceWriterEnabled=(_mode:ExperimentCutoverMode)=>false;

import type {SupabaseClient} from "@supabase/supabase-js";
import type {LoopProposal,LoopRepository,OwnerLoopScope,LoopReport} from "./engine";
import {readVerifiedToastPriceEvidence,matchCompletedToastObservation,type CompletedToastHistory,type VerifiedToastPriceEvidence} from "./toastPriceEvidence.server";
import {readElapsedWindowObservations,planElapsed24HourWindows} from "./rollingExperimentSales.server";
import {postVerifiedSourceReminder,postToastObservationNotice,toastObservationNoticeKey} from "./experimentNotices.server";

import {formatInTimeZone} from "date-fns-tz";
import {getPricingInputs} from "@/lib/data/getPricingInputs";

export const priceCapabilityIds=[
 "alex.drink_price_experiment.v1","alex.menu_price_change.v1"] as const;
export const isPriceCapability=(id:string)=>
 (priceCapabilityIds as readonly string[]).includes(id);
/** Read ONLY previously recorded release proof. No environment flag and no
 * owner chat input can silently enable a second price report writer. */
export async function readCafeExperimentCutoverMode(db:SupabaseClient,
 businessId:string):Promise<ExperimentCutoverMode>{
 const {data,error}=await db.from("supervisor_experiment_cutover_cafes")
  .select("mode,parity_proven_at,rollback_proven_at,release_approved_at")
  .eq("business_id",businessId).maybeSingle();
 if(error)throw new Error("experiment_cutover_gate_unavailable");
 return resolveExperimentCutoverMode({requested:data?.mode,
  parityProven:Boolean(data?.parity_proven_at),
  rollbackProven:Boolean(data?.rollback_proven_at),
  releaseApproved:Boolean(data?.release_approved_at)});
}
type PriceRow={id:string;business_id:string;owner_user_id:string;thread_id:string;
 capability_id:string;status:string;revision:number;approved_at:string|null;
 canonical_effect_payload:unknown;monitor_spec:{durationDays:number};
 locale:"en"|"es"|"ar"};
function priceEffect(v:unknown):{productId:string;productName:string;
 oldPriceCents:number;newPriceCents:number;currency:string}|null{
 if(!v||typeof v!=="object")return null;
 const r=v as Record<string,unknown>;
 return typeof r.productId==="string"&&typeof r.productName==="string"&&
  typeof r.currency==="string"&&Number.isSafeInteger(r.oldPriceCents)&&
  Number.isSafeInteger(r.newPriceCents)&&r.oldPriceCents!==r.newPriceCents&&
  (r.oldPriceCents as number)>0&&(r.newPriceCents as number)>0?
  {productId:r.productId,productName:r.productName,
   oldPriceCents:r.oldPriceCents as number,newPriceCents:r.newPriceCents as number,
   currency:r.currency}:null;
}
/** Return legacy for disconnected/manual items even if the café has enabled
 * the Toast cutover; local price edits do not depend on Toast publication. */
export async function priceProposalCutoverMode(db:SupabaseClient,
 row:PriceRow):Promise<ExperimentCutoverMode>{
 const effect=priceEffect(row.canonical_effect_payload);
 if(!isPriceCapability(row.capability_id)||!effect)return "legacy";
 const {data:item,error}=await db.from("menu_items")
  .select("catalog_source").eq("business_id",row.business_id)
  .eq("id",effect.productId).maybeSingle();
 if(error)throw new Error("experiment_item_source_unavailable");
 if(item?.catalog_source!=="toast")return "legacy";
 return readCafeExperimentCutoverMode(db,row.business_id);
}
type ActivationAnchor=VerifiedToastPriceEvidence;
/** The durable row is first written BEFORE lifecycle confirmation. A newer
 * unrelated Toast publication must not change the approved experiment's
 * verified start instant or the source change that activated it. */
export function readVerifiedActivationAnchor(raw:unknown,startAt:unknown,expected:{
 businessId:string;menuItemId:string;oldPriceCents:number;
 newPriceCents:number;approvedAt:string;
}):ActivationAnchor|null{
 if(!raw||typeof raw!=="object"||typeof startAt!=="string")return null;
 const v=raw as Record<string,unknown>;
 const valid=(x:unknown)=>typeof x==="string"&&
  Number.isFinite(Date.parse(x));
 const strings=["historyId","restaurantGuid","menuItemId","posItemId",
  "publicationVersion","observedAt"] as const;
 if(strings.some(k=>typeof v[k]!=="string"||!v[k])||
    v.businessId!==expected.businessId||v.menuItemId!==expected.menuItemId||
    v.oldPriceCents!==expected.oldPriceCents||
    v.newPriceCents!==expected.newPriceCents||
    (v.startBasis!=="source_effective"&&
     v.startBasis!=="first_verified_observation")||
    !valid(v.observedAt)||!valid(startAt)||!valid(expected.approvedAt)||
    Date.parse(startAt)<Date.parse(expected.approvedAt)||
    Date.parse(v.observedAt as string)<Date.parse(expected.approvedAt)||
    !(v.posItemId as string).toLowerCase().startsWith(
      "toast:"+(v.restaurantGuid as string).toLowerCase()+":"))
  return null;
 return {status:"verified",businessId:expected.businessId,
  menuItemId:expected.menuItemId,historyId:v.historyId as string,
  restaurantGuid:v.restaurantGuid as string,
  posItemId:v.posItemId as string,
  oldPriceCents:expected.oldPriceCents,newPriceCents:expected.newPriceCents,
  publicationVersion:v.publicationVersion as string,
  observedAt:v.observedAt as string,startAt,
  startBasis:v.startBasis as ActivationAnchor["startBasis"]};
}
function activationReference(receipt:ActivationAnchor){
 const {status,startAt,...rest}=receipt;
 return rest;
}
type ContextSnapshot={
 observed_at:string;new_pos_item_id:string|null;
 new_pricing_strategy:string|null;new_catalog_source:string|null;
 new_is_active:boolean;old_price_cents:number|null;
 new_price_cents:number|null;old_publication_state:string|null;
 new_publication_state:string|null;
};
/** The first canonical import may be updated after source observation but
 * BEFORE authenticated activation is recorded: it is not an interruption.
 * Only movement AWAY from the approved price and source context counts. */
export function contextChangeBreaksApprovedPrice(row:ContextSnapshot,
 receipt:{posItemId:string;newPriceCents:number}):boolean{
 const strategy=receipt.posItemId.includes(":size:")?"SIZE_PRICE":"BASE_PRICE";
 return row.new_pos_item_id!==receipt.posItemId||
  row.new_pricing_strategy!==strategy||
  row.new_catalog_source!=="toast"||
  row.new_is_active!==true||
  (row.old_price_cents===receipt.newPriceCents&&
   row.new_price_cents!==receipt.newPriceCents)||
  (row.old_publication_state==="active"&&
   row.new_publication_state!=="active");
}
type CurrentMenuPrice={
 catalog_source:string|null;is_active:boolean;
 pos_item_id:string|null;price_cents:number|null;
 toast_publication_state:string|null;
 pos_pricing_strategy:string|null;
 toast_publication_observed_at:string|null;
};
/** Source changes after the Nth elapsed 24h boundary belong to a *different*
 * observation, not the approved experiment. The active menu can have moved
 * on since the closed window, so distinguish a post-end publication from an
 * in-window change of item, size, price or pricing strategy. */
export function trialSourceInterruption(input:{
 receipt:{startAt:string;posItemId:string;newPriceCents:number};
 finalEndAt:string;asOf:string;current:CurrentMenuPrice|null;
 firstPriceChangeAt:string|null;firstContextChangeAt:string|null;
 priorInterruptionAt:string|null;
}):{at:string|null;reason:"verified_price_changed"|"unverified_gap"|null}{
 const start=Date.parse(input.receipt.startAt);
 const end=Date.parse(input.finalEndAt);
 const now=Date.parse(input.asOf);
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(now)||
    end<=start)throw new Error("invalid_price_continuity_interval");
 const expectedStrategy=input.receipt.posItemId.includes(":size:")?
  "SIZE_PRICE":"BASE_PRICE";
 const current=input.current;
 const matches=Boolean(current&&current.catalog_source==="toast"&&
  current.is_active&&current.toast_publication_state==="active"&&
  current.pos_item_id===input.receipt.posItemId&&
  current.pos_pricing_strategy===expectedStrategy&&
  current.price_cents===input.receipt.newPriceCents);
 const occurred=(time:string|null):number|null=>{
  if(!time)return null;
  const ms=Date.parse(time);
  return Number.isFinite(ms)&&ms>=start&&ms<end&&ms<=now?ms:null;
 };
 const history=occurred(input.firstPriceChangeAt);
 const context=occurred(input.firstContextChangeAt);
 const prior=occurred(input.priorInterruptionAt);
 let gap:number|null=null;
 if(!matches){
  const observed=Date.parse(current?.toast_publication_observed_at??"");
  if(Number.isFinite(observed)&&observed<=now&&observed>=end){
   // The source change was observed only after the trial had completed.
   gap=null;
  }else if(Number.isFinite(observed)&&observed<=now){
   gap=Math.max(start,observed);
  }else{
   // No trusted publication timestamp: do not invent uninterrupted exposure.
   gap=start;
  }
  if(gap!==null&&gap>=end)gap=null;
 }
 const events=[...(history!==null?[{at:history,reason:"verified_price_changed" as const}]:[]),
  ...(context!==null?[{at:context,reason:"unverified_gap" as const}]:[]),
  ...(prior!==null?[{at:prior,reason:"unverified_gap" as const}]:[]),
  ...(gap!==null?[{at:gap,reason:"unverified_gap" as const}]:[])]
  .sort((a,b)=>a.at-b.at);
 return events[0]?{at:new Date(events[0].at).toISOString(),
  reason:events[0].reason}:{at:null,reason:null};
}
/** The ONE new-path monitor handler for verified Toast prices only. Callers
 * must select mode=new first and must bypass the old calendar-day writer.
 * Note the full source and no-shared-credential preconditions; the worker
 * operates only on previously saved Toast facts, never calls Toast directly. */
export async function runVerifiedToastPriceTick(db:SupabaseClient,repo:LoopRepository,
 row:PriceRow,scope:OwnerLoopScope,now:string,timezone:string,
 proposal:LoopProposal):Promise<"waiting_source"|"monitoring"|"reported"|"not_price">{
 const effect=priceEffect(row.canonical_effect_payload);
 if(!effect||!row.approved_at||!isPriceCapability(row.capability_id))return "not_price";
 const days=row.monitor_spec?.durationDays;
 if(!Number.isSafeInteger(days)||days<1||days>90)
  throw new Error("invalid_experiment_monitor_duration");
 const anchorQuery=()=>db.from("supervisor_monitor_windows")
  .select("source_reference,start_at")
  .eq("business_id",row.business_id)
  .eq("monitor_kind","approved_price").eq("source_id",row.id)
  .eq("window_index",0).maybeSingle();
 const initial=await anchorQuery();
 if(initial.error)throw new Error("activation_receipt_read_failed");
 const expected={businessId:row.business_id,menuItemId:effect.productId,
  oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
  approvedAt:row.approved_at};
 let receipt:ActivationAnchor|null=null;
 if(initial.data){
  receipt=readVerifiedActivationAnchor(initial.data.source_reference,
   initial.data.start_at,expected);
  if(!receipt)throw new Error("invalid_persisted_activation");
 }else{
  const published=await readVerifiedToastPriceEvidence(db,row.business_id,
   effect.productId,effect.newPriceCents,{approvedAt:row.approved_at,
    oldPriceCents:effect.oldPriceCents});
  const ready=published.status==="verified"&&
   published.oldPriceCents===effect.oldPriceCents&&
   Date.parse(published.observedAt)>=Date.parse(row.approved_at)&&
   Date.parse(published.startAt)>=Date.parse(row.approved_at);
  if(!ready){
   if(row.status==="manual_pending")await postVerifiedSourceReminder(db,{
    businessId:row.business_id,ownerUserId:row.owner_user_id,
    proposalId:row.id,threadId:row.thread_id,productId:effect.productId,
    productName:effect.productName,targetPriceCents:effect.newPriceCents,
    currency:effect.currency,approvedAt:row.approved_at,now,timezone,
    sourceVerified:false,cancelled:false,
   });
   return "waiting_source";
  }
  if(published.status!=="verified")return "waiting_source";
  const window0=planElapsed24HourWindows(published.startAt,days)[0];
  const recorded=await db.from("supervisor_monitor_windows").upsert({
   business_id:row.business_id,owner_user_id:row.owner_user_id,
   monitor_kind:"approved_price",source_id:row.id,window_index:0,
   source_reference:activationReference(published),
   start_at:window0.startAt,end_at:window0.endAt,
   coverage_status:"unknown",evaluation_status:"in_progress",
  },{onConflict:"business_id,monitor_kind,source_id,window_index",
      ignoreDuplicates:true});
  if(recorded.error)throw new Error("activation_receipt_write_failed");
  // Two cron workers must agree on the first committed source receipt.
  const persisted=await anchorQuery();
  if(persisted.error||!persisted.data)
   throw new Error("activation_receipt_unavailable");
  receipt=readVerifiedActivationAnchor(persisted.data.source_reference,
   persisted.data.start_at,expected);
  if(!receipt)throw new Error("invalid_persisted_activation");
 }
 if(!receipt)throw new Error("activation_receipt_unavailable");
 if(row.status==="manual_pending"){
  // Keep the existing Supervisor proposal lifecycle, but only AFTER the
  // source verification guard. The legacy date is not our 24h clock.
  // The existing transition RPC validates PostgreSQL current_date (UTC),
  // not the café-local display day. This is only lifecycle bookkeeping;
  // elapsed source windows still begin at receipt.startAt.
  const transitionDate=new Date().toISOString().slice(0,10);
  await repo.transition(scope,row.id,row.revision,"manual_confirmed",transitionDate);
 }
 // Verify continuity only within the measured source interval. A later
 // publication or price revert belongs to a different observed phase.
 const windows=planElapsed24HourWindows(receipt.startAt,days);
 const finalEndAt=windows[windows.length-1].endAt;
 const [current,changes,contextChanges]=await Promise.all([
  db.from("menu_items").select(
   "catalog_source,is_active,pos_item_id,price_cents,toast_publication_state,pos_pricing_strategy,toast_publication_observed_at")
   .eq("business_id",row.business_id).eq("id",effect.productId).maybeSingle(),
  db.from("menu_price_history").select("toast_observed_at,new_price_cents")
   .eq("business_id",row.business_id).eq("menu_item_id",effect.productId)
   .eq("source_type","connected_pos").eq("source_provider","toast")
   .eq("toast_restaurant_guid",receipt.restaurantGuid)
   .gt("toast_observed_at",receipt.observedAt)
   .lt("toast_observed_at",finalEndAt)
   .lte("toast_observed_at",now)
   .order("toast_observed_at",{ascending:true}).limit(1),
  // Append-only DB trigger records the FIRST context change. Unlike the
  // menu's latest publication timestamp it survives later menu versions,
  // reverts and unrelated publishes. Unknown source-effective time stays
  // insufficient-evidence rather than becoming a fake clean window.
  db.from("supervisor_toast_price_context_changes")
   .select("observed_at,new_pos_item_id,new_pricing_strategy,new_catalog_source,new_is_active,old_price_cents,new_price_cents,old_publication_state,new_publication_state",{count:"exact"})
   .eq("business_id",row.business_id)
   .eq("menu_item_id",effect.productId)
   .gte("observed_at",receipt.startAt).lt("observed_at",finalEndAt)
   .lte("observed_at",now)
   .order("observed_at",{ascending:true}).limit(10000),
 ]);
 if(current.error||changes.error||contextChanges.error)
  throw new Error("source_continuity_read_failed");
 // A missing or truncated audit page cannot certify uninterrupted pricing.
 if(contextChanges.count===null||
    contextChanges.count!==(contextChanges.data?.length??0))
  throw new Error("source_context_audit_incomplete");
 const firstContextChange=(contextChanges.data??[])
  .find(entry=>contextChangeBreaksApprovedPrice(entry,receipt));
 const storedAt=initial.data?.source_reference?.interruptedAt;
 const priorInterruption=typeof storedAt==="string"&&
  Number.isFinite(Date.parse(storedAt))?storedAt:null;
 const continuity=trialSourceInterruption({
  receipt,finalEndAt,asOf:now,current:current.data,
  firstPriceChangeAt:changes.data?.[0]?.toast_observed_at??null,
  firstContextChangeAt:firstContextChange?.observed_at??null,
  priorInterruptionAt:typeof storedAt==="string"?storedAt:null,
 });
 const interruptionAt=continuity.at;
 const sourceReference={...activationReference(receipt),
  ...(interruptionAt?{interruptedAt:interruptionAt,
   sourceContinuity:continuity.reason}:{})};
 if(interruptionAt&&!priorInterruption){
  const saved=await db.from("supervisor_monitor_windows")
   .update({source_reference:sourceReference,updated_at:new Date().toISOString()})
   .eq("business_id",row.business_id).eq("monitor_kind","approved_price")
   .eq("source_id",row.id).eq("window_index",0);
  if(saved.error)throw new Error("source_interruption_receipt_failed");
 }
 const complete=[] as Awaited<ReturnType<typeof readElapsedWindowObservations>>[];
 for(const window of windows){
  if(Date.parse(window.endAt)>Date.parse(now))break;
  // A window overlapping a subsequent source price change cannot be
  // valued at the original approved price, even if lines have timestamps.
  const cut=interruptionAt!==null&&Date.parse(window.endAt)>Date.parse(interruptionAt);
  const measured=cut?{
   window,status:"insufficient_evidence" as const,
   units:null,revenueCents:null,countedLines:0,unknownTimeLines:1,
   source:"order_lines.ordered_at" as const,asOf:now,
  }:await readElapsedWindowObservations(db,row.business_id,
   effect.productId,window,now,timezone);
  const written=await db.from("supervisor_monitor_windows").upsert({
   business_id:row.business_id,owner_user_id:row.owner_user_id,
   monitor_kind:"approved_price",source_id:row.id,window_index:window.index,
   source_reference:sourceReference,
   start_at:window.startAt,end_at:window.endAt,
   coverage_status:measured.status==="actual"?"actual":"partial",
   unknown_time_lines:measured.unknownTimeLines,
   units:measured.units,revenue_cents:measured.revenueCents,
   evaluation_status:measured.status==="actual"?"complete":"insufficient_evidence",
   updated_at:new Date().toISOString(),
  },{onConflict:"business_id,monitor_kind,source_id,window_index"});
  if(written.error)throw new Error("verified_window_write_failed");
  complete.push(measured);
 }
 // The new-mode midpoint uses the SAME idempotent report+notifyOwner
 // delivery path as legacy. The skipped calendar-day monitor must never
 // become a second writer; a stable midRunKey deduplicates cron retries.
 if(complete.length!==days){
  const half=Math.ceil(days/2);
  if(days>1&&complete.length>=half&&Date.parse(now)<Date.parse(finalEndAt)){
   const actualCount=complete.filter(c=>c.status==="actual").length;
   const firstHalfEnd=windows[half-1].endAt;
   const interim:LoopReport={
    status:"in_progress",recommendation:"adjust",
    source:"order_lines.ordered_at+orders.closed_at",
    midRunKey:"verified-source-half",
    midRunText:"Toast verified the price for "+effect.productName+
     ". Midpoint update: "+actualCount+" of "+complete.length+
     " elapsed 24-hour windows have actual sales coverage. "+
     (interruptionAt?"A later price or source-context change interrupted this trial. ":
      "Any missing timestamps or late imports remain unverified. ")+
     "These observations do not prove that the price caused sales changes.",
    result:{productId:effect.productId,productName:effect.productName,
     oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
     coveredWindows:actualCount,elapsedWindows:complete.length,totalWindows:days,
     windowStartAt:receipt.startAt,windowEndAt:firstHalfEnd,
     sourceContinuity:interruptionAt?"interrupted":"verified",
     nonCausal:true,status:"in_progress"},
    delivery:{agentId:"alex",taskKind:"price_experiment_report",
     entityType:"menu_item",entityId:effect.productId,
     confidence:"low",payload:{productId:effect.productId,
      productName:effect.productName,itemName:effect.productName,
      outcomeStatus:"in_progress",recommendation:"adjust",
      oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
      coveredWindows:actualCount,totalWindows:days,
      windowStartAt:receipt.startAt,windowEndAt:firstHalfEnd,
      sourceCoverage:"in_progress",nonCausal:true},
     evidence:[{source:"order_lines",facts:{actualWindowCount:actualCount,
      elapsedWindowCount:complete.length,totalWindowCount:days,nonCausal:true}}],
     threadText:""},
   };
   await repo.saveReport(scope,proposal,interim,{midRun:true});
  }
  return "monitoring";
 }
 const actual=!interruptionAt&&complete.every(c=>c.status==="actual");
 const units=actual?complete.reduce((a,b)=>a+(b.units??0),0):null;
 const revenue=actual?complete.reduce((a,b)=>a+(b.revenueCents??0),0):null;
 const result={productId:effect.productId,productName:effect.productName,
  oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
  observedUnits:units,observedRevenueCents:revenue,coveredWindows:complete.filter(
   c=>c.status==="actual").length,totalWindows:days,windowStartAt:receipt.startAt,
  windowEndAt:windows.at(-1)!.endAt,sourceBasis:receipt.startBasis,
  extraTradingInterval:{status:"not_verified",revenueCents:null},
  nonCausal:true,sourcePublicationVersion:receipt.publicationVersion,
  sourceContinuity:interruptionAt?"interrupted":"verified",interruptedAt:interruptionAt};
 const status=actual?"complete":"insufficient_evidence";
 const report:LoopReport={status,result,recommendation:"adjust",
  source:"order_lines.ordered_at+orders.closed_at",
  delivery:{agentId:"alex",taskKind:"price_experiment_report",
   entityType:"menu_item",entityId:effect.productId,
   payload:{productId:effect.productId,productName:effect.productName,
    itemName:effect.productName,outcomeStatus:status,recommendation:"adjust",
    oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
    observedUnits:units,observedRevenueCents:revenue,
    coveredWindows:result.coveredWindows,totalWindows:days,
    windowStartAt:receipt.startAt,windowEndAt:windows.at(-1)!.endAt,
    sourceBasis:receipt.startBasis,sourceCoverage:status,
    extraTradingStatus:"not_verified",nonCausal:true,
    sourcePublicationVersion:receipt.publicationVersion,
    sourceContinuity:interruptionAt?"interrupted":"verified",
    interruptionAt},
   confidence:actual?"high":"low",
   evidence:[{source:"order_lines",facts:{actualWindowCount:result.coveredWindows,
    totalWindowCount:days,status,nonCausal:true}}],
   threadText:"Toast verified the price for "+effect.productName+
    ". I observed "+result.coveredWindows+" of "+days+
    " elapsed 24-hour sales windows. "+(actual?
    "The recorded lines were complete for those windows.":
    interruptionAt?
    "A later source price change or unverifiable price gap interrupted this phase.":
    "Some source timestamps or certified coverage were missing.")+
    " These are observed sales, not proof that the price change caused them. "+
    "Any trading after the final window remains separately unverified.",
  }};
 await repo.saveReport(scope,proposal,report);
 return "reported";
}
/** Notification-only action during legacy/shadow rollout. This does not
 * activate a price monitor or mutate a published price. */
export async function remindPendingToastPrice(db:SupabaseClient,row:PriceRow,
 now:string,timezone:string):Promise<"not_price"|"verified"|"not_due"|"posted"|"leased_elsewhere">{
 if(row.status!=="manual_pending"||!row.approved_at||!isPriceCapability(row.capability_id))
  return "not_price";
 const effect=priceEffect(row.canonical_effect_payload);
 if(!effect)return "not_price";
 const {data:item,error}=await db.from("menu_items").select("catalog_source")
  .eq("business_id",row.business_id).eq("id",effect.productId).maybeSingle();
 if(error)throw new Error("experiment_item_source_unavailable");
 if(item?.catalog_source!=="toast")return "not_price";
 const evidence=await readVerifiedToastPriceEvidence(db,row.business_id,
  effect.productId,effect.newPriceCents);
 if(evidence.status==="verified"&&evidence.oldPriceCents===effect.oldPriceCents&&
    Date.parse(evidence.observedAt)>=Date.parse(row.approved_at)&&
    Date.parse(evidence.startAt)>=Date.parse(row.approved_at))return "verified";
 return postVerifiedSourceReminder(db,{
  businessId:row.business_id,ownerUserId:row.owner_user_id,
  proposalId:row.id,threadId:row.thread_id,productId:effect.productId,
  productName:effect.productName,targetPriceCents:effect.newPriceCents,
  currency:effect.currency,approvedAt:row.approved_at,now,timezone,
  sourceVerified:false,cancelled:false,
 });
}


type ObservationDue={history_id:string;business_id:string;enabled_at:string};
type ObservationMeasurement={
 index:number;startAt:string;endAt:string;segmentEndAt:string;
 status:"actual"|"insufficient_evidence";units:number|null;revenueCents:number|null;
 baselineUnits:number|null;baselineRevenueCents:number|null;
 contributionEstimateCents:number|null;unitCostEstimateCents:number|null;
};
const observationDayMs=86400000;
const observationColumns="id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,toast_restaurant_guid,toast_publication_version,toast_observed_at,toast_effective_at,changed_at,toast_publication_completed_at,toast_publication_pos_item_id";

/** The existing authenticated experiment cron, not a second agent or job.
 * Independent watches are never proposals, never trigger a price write, and
 * are gated separately from already-enabled approved experiments. */
export async function runToastObservationBatch(db:SupabaseClient,now:string):
 Promise<{checked:number;reported:number;failed:number}>{
 const result={checked:0,reported:0,failed:0};
 const due=await db.rpc("supervisor_8a_due_toast_observations",{p_now:now,p_limit:10});
 if(due.error)throw new Error("toast_observation_discovery_failed");
 for(const row of (due.data??[]) as ObservationDue[]){
  result.checked++;
  try{result.reported+=await runCompletedToastObservation(db,row,now);}
  catch{result.failed++;}
 }
 return result;
}
async function runCompletedToastObservation(db:SupabaseClient,due:ObservationDue,now:string):Promise<number>{
 const {business_id:businessId,history_id:sourceId}=due;
 const source=await db.from("menu_price_history").select(observationColumns)
  .eq("business_id",businessId).eq("id",sourceId).maybeSingle();
 if(source.error||!source.data)throw new Error("observation_source_missing");
 const event=source.data as CompletedToastHistory;
 const [location,cafe,owners,current,existing]=await Promise.all([
  db.from("toast_location_mappings").select("restaurant_guid,verified_at")
   .eq("business_id",businessId).eq("restaurant_guid",event.toast_restaurant_guid).maybeSingle(),
  db.from("businesses").select("timezone,currency").eq("id",businessId).single(),
  db.from("memberships").select("user_id",{count:"exact"}).eq("business_id",businessId)
   .eq("role","owner").order("user_id").limit(100),
  db.from("menu_items").select("name,catalog_source,is_active,pos_item_id,price_cents,toast_publication_state,pos_pricing_strategy,toast_publication_observed_at")
   .eq("business_id",businessId).eq("id",event.menu_item_id).maybeSingle(),
  db.from("supervisor_monitor_windows").select("owner_user_id,source_reference")
   .eq("business_id",businessId).eq("monitor_kind","toast_price_observation")
   .eq("source_id",sourceId).eq("window_index",0).maybeSingle(),
 ]);
 if(location.error||cafe.error||owners.error||current.error||existing.error||
   owners.count!==(owners.data?.length??0)||!cafe.data?.timezone||!cafe.data?.currency)
  throw new Error("observation_scope_unavailable");
 if(!owners.data?.length)return 0;
 const receipt=matchCompletedToastObservation({businessId,historyId:sourceId,
  notBefore:due.enabled_at,asOf:now,event,location:location.data});
 if(receipt.status!=="verified")throw new Error("invalid_observation_source");
 const timezone=cafe.data.timezone,currency=cafe.data.currency;
 const itemName=typeof current.data?.name==="string"?current.data.name:"Menu item";
 const windows=planElapsed24HourWindows(receipt.startAt,7);
 const finalEndAt=windows[6].endAt;
 const [later,context,baselineChanges]=await Promise.all([
  db.from("menu_price_history").select("toast_observed_at,toast_effective_at,toast_publication_completed_at,new_price_cents",{count:"exact"})
   .eq("business_id",businessId).eq("menu_item_id",receipt.menuItemId)
   .eq("source_type","connected_pos").eq("source_provider","toast")
   .eq("toast_restaurant_guid",receipt.restaurantGuid)
   .gt("toast_observed_at",receipt.observedAt).lte("toast_observed_at",now)
   .order("toast_observed_at").limit(100),
  db.from("supervisor_toast_price_context_changes")
   .select("observed_at,new_pos_item_id,new_pricing_strategy,new_catalog_source,new_is_active,old_price_cents,new_price_cents,old_publication_state,new_publication_state",{count:"exact"})
   .eq("business_id",businessId).eq("menu_item_id",receipt.menuItemId)
   .gte("observed_at",receipt.observedAt).lt("observed_at",finalEndAt)
   .lte("observed_at",now).order("observed_at").limit(1000),
  db.from("menu_price_history").select("id",{head:true,count:"exact"})
   .eq("business_id",businessId).eq("menu_item_id",receipt.menuItemId)
   .gte("changed_at",new Date(Date.parse(receipt.startAt)-7*observationDayMs).toISOString())
   .lt("changed_at",receipt.startAt).neq("id",receipt.historyId),
 ]);
 if(later.error||context.error||baselineChanges.error||
   later.count!==(later.data?.length??0)||context.count!==(context.data?.length??0)||baselineChanges.count===null)
  throw new Error("observation_continuity_unavailable");
 const first=later.data?.[0];
 const nextAt=first?.toast_publication_completed_at?(first.toast_effective_at??first.toast_observed_at):
  first?.toast_observed_at??null;
 const prior=existing.data?.source_reference?.interruptedAt;
 const continuity=trialSourceInterruption({receipt,finalEndAt,asOf:now,current:current.data,
  firstPriceChangeAt:nextAt,firstContextChangeAt:(context.data??[]).find(c=>contextChangeBreaksApprovedPrice(c,receipt))?.observed_at??null,
  priorInterruptionAt:typeof prior==="string"?prior:null});
 const cut=continuity.at;
 const endAt=cut??finalEndAt;
 const ref={...activationReference(receipt),itemName,currency,interruptedAt:cut,
  sourceContinuity:continuity.reason??"verified",asOf:now};
 const measurementOwner=existing.data?.owner_user_id??owners.data[0].user_id;
 // Establish the seven durable slots before delivery. Retrying a discovery
 // can never create a second independent watch for the same history UUID.
 const initialized=await db.from("supervisor_monitor_windows").upsert(windows.map(window=>({
  business_id:businessId,owner_user_id:measurementOwner,monitor_kind:"toast_price_observation",
  source_id:sourceId,window_index:window.index,source_reference:ref,
  start_at:window.startAt,end_at:window.endAt,
 })),{onConflict:"business_id,monitor_kind,source_id,window_index",ignoreDuplicates:true});
 if(initialized.error)throw new Error("observation_window_initialization_failed");
 const measurements:ObservationMeasurement[]=[];
 let unitCost:number|null=null;
 if(windows.some(w=>Date.parse(w.startAt)<Date.parse(endAt)&&
   Date.parse(now)>=Math.min(Date.parse(w.endAt),Date.parse(endAt)))){
  // Current recipe/fallback inputs are not historical COGS. Even an actual
  // current unit cost is explicitly an estimate of historical contribution.
  try{
   const inputs=await getPricingInputs(db,businessId,{profile:"Menu"});
   const item=inputs.items.find(i=>i.id===receipt.menuItemId);
   if(item?.productCostStatus==="READY"&&Number.isFinite(item.productCostCents)&&item.productCostCents>0)
    unitCost=item.productCostCents;
  }catch{/* Product economics unknown; do not replace missing cost with zero. */}
 }
 for(const window of windows){
  if(Date.parse(window.startAt)>=Date.parse(endAt))break;
  const segmentEndAt=new Date(Math.min(Date.parse(window.endAt),Date.parse(endAt))).toISOString();
  if(Date.parse(now)<Date.parse(segmentEndAt))break;
  const partial=Date.parse(segmentEndAt)<Date.parse(window.endAt);
  const measured=await readElapsedWindowObservations(db,businessId,receipt.menuItemId,window,now,timezone,
   partial?segmentEndAt:undefined);
  const baselineWindow={index:window.index,startAt:new Date(Date.parse(window.startAt)-7*observationDayMs).toISOString(),
   endAt:new Date(Date.parse(window.endAt)-7*observationDayMs).toISOString()};
  const baseline=baselineChanges.count===0?await readElapsedWindowObservations(db,businessId,receipt.menuItemId,
   baselineWindow,now,timezone,partial?new Date(Date.parse(segmentEndAt)-7*observationDayMs).toISOString():undefined):null;
  const measurement:ObservationMeasurement={index:window.index,startAt:window.startAt,endAt:window.endAt,
   segmentEndAt,status:measured.status,units:measured.units,revenueCents:measured.revenueCents,
   baselineUnits:baseline?.units??null,baselineRevenueCents:baseline?.revenueCents??null,
   unitCostEstimateCents:unitCost,contributionEstimateCents:measured.units!==null&&measured.revenueCents!==null&&unitCost!==null?
    Math.round(measured.revenueCents-measured.units*unitCost):null};
  const saved=await db.from("supervisor_monitor_windows").upsert({
   business_id:businessId,owner_user_id:measurementOwner,monitor_kind:"toast_price_observation",
   source_id:sourceId,window_index:window.index,source_reference:{...ref,measurement},
   start_at:window.startAt,end_at:window.endAt,
   coverage_status:!partial&&measured.status==="actual"?"actual":"partial",
   units:partial?null:measured.units,revenue_cents:partial?null:measured.revenueCents,
   unknown_time_lines:measured.unknownTimeLines,
   evaluation_status:!partial&&measured.status==="actual"?"complete":"insufficient_evidence",
   updated_at:now,
  },{onConflict:"business_id,monitor_kind,source_id,window_index"});
  if(saved.error)throw new Error("observation_measurement_write_failed");
  measurements.push(measurement);
 }
 const total=(key:"units"|"revenueCents"|"baselineUnits"|"baselineRevenueCents"|"contributionEstimateCents")=>
  measurements.length&&measurements.every(m=>m[key]!==null)?measurements.reduce((sum,m)=>sum+m[key]!,0):null;
 const finalDue=Date.parse(now)>=Date.parse(endAt);
 const cumulative={observedUnits:total("units"),observedRevenueCents:total("revenueCents"),
  baselineUnits:total("baselineUnits"),baselineRevenueCents:total("baselineRevenueCents"),
  contributionEstimateCents:total("contributionEstimateCents"),costBasis:unitCost===null?"missing":"current_cost_estimate",
  completedExposureWindows:measurements.length,interruptedAt:cut,nonCausal:true};
 const format=(cents:number|null)=>cents===null?"unknown":new Intl.NumberFormat("en-US",{style:"currency",currency}).format(cents/100);
 const advice=(revenue:number|null,baseline:number|null)=>
  revenue===null||baseline===null?"Wait for complete comparable evidence before deciding.":
  revenue<baseline?"Revenue was lower than the comparison period. Review traffic, discounts and costs before considering another price change.":
  "Review volume and contribution before deciding whether to retain the price.";
 const date=(s:string)=>formatInTimeZone(new Date(s),timezone,"yyyy-MM-dd");
 let posted=0,allDelivered=true;
 for(const owner of owners.data){
  const thread=await db.from("ai_threads").select("id").eq("business_id",businessId)
   .eq("owner_user_id",owner.user_id).order("updated_at",{ascending:false}).order("id").limit(1).maybeSingle();
  if(thread.error)throw new Error("observation_owner_thread_read_failed");
  if(!thread.data){allDelivered=false;continue;}
  const send=async(index:number,at:string,final:boolean,payload:Record<string,string|number|boolean|null>,text:string,confidence:"high"|"low")=>{
   const key=toastObservationNoticeKey({businessId,ownerUserId:owner.user_id,priceHistoryId:sourceId,
    windowIndex:index,localDate:date(at),final});
   const prior=await db.from("supervisor_experiment_notice_receipts").select("id").eq("business_id",businessId)
    .eq("owner_user_id",owner.user_id).eq("source_id",sourceId).eq("kind",key.kind).eq("slot",key.slot).eq("state","posted").limit(1).maybeSingle();
   if(prior.error)throw new Error("observation_notice_read_failed");
   if(prior.data)return;
   const result=await postToastObservationNotice(db,{key,threadId:thread.data!.id,timezone,
    payload:{...payload,itemName,oldPriceCents:receipt.oldPriceCents,newPriceCents:receipt.newPriceCents,currency,observationOnly:true},
    text,confidence});
   if(result==="posted")posted++;else allDelivered=false;
  };
  await send(0,receipt.observedAt,false,{title:"Toast price change detected",nonCausal:true},
   "Toast confirmed a published price change for "+itemName+" from "+format(receipt.oldPriceCents)+" to "+format(receipt.newPriceCents)+
   ". I will observe seven elapsed days unless the source price changes again. This is monitoring, not an approved experiment or a price write.","high");
  for(const m of measurements){
   await send(m.index+1,m.segmentEndAt,false,{title:"Toast price observation day "+(m.index+1),units:m.units,
    revenueCents:m.revenueCents,baselineRevenueCents:m.baselineRevenueCents,contributionEstimateCents:m.contributionEstimateCents,
    segmentEndAt:m.segmentEndAt,nonCausal:true},
    itemName+": observation day "+(m.index+1)+" ending "+m.segmentEndAt+
    ". "+(m.units===null?"Sales coverage is incomplete.":m.units+" units, net revenue "+format(m.revenueCents)+".")+
    " Comparable prior revenue: "+format(m.baselineRevenueCents)+". Estimated contribution using current cost: "+format(m.contributionEstimateCents)+
    ". "+advice(m.revenueCents,m.baselineRevenueCents)+" This does not establish causation.",m.status==="actual"?"high":"low");
  }
  if(finalDue)await send(7,endAt,true,{title:"Toast price observation summary",...cumulative},
   itemName+": "+(cut?"Price exposure was interrupted; ":"Seven elapsed days ended; ")+
   "observed units "+(cumulative.observedUnits??"unknown")+", net revenue "+format(cumulative.observedRevenueCents)+
   ", comparable prior revenue "+format(cumulative.baselineRevenueCents)+
   ", estimated contribution using current cost "+format(cumulative.contributionEstimateCents)+
   ". "+advice(cumulative.observedRevenueCents,cumulative.baselineRevenueCents)+
   " No causal conclusion or price action has been made.",cumulative.observedRevenueCents===null?"low":"high");
 }
 // Keep checking corrections for the existing fourteen-day correction period.
 // A missing owner thread or undelivered receipt remains actionable backlog.
 const settled=finalDue&&allDelivered&&Date.parse(now)>Date.parse(endAt)+14*observationDayMs;
 const anchor=await db.from("supervisor_monitor_windows").update({
  source_reference:{...ref,...(measurements[0]?{measurement:measurements[0]}:{}),cumulative,finalDue,
   ...(settled?{closedAt:now}:{})},updated_at:now,
 }).eq("business_id",businessId).eq("monitor_kind","toast_price_observation")
 .eq("source_id",sourceId).eq("window_index",0);
 if(anchor.error)throw new Error("observation_anchor_write_failed");
 return posted;
}
