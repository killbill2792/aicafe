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
import {readVerifiedToastPriceEvidence,type VerifiedToastPriceEvidence} from "./toastPriceEvidence.server";
import {readElapsedWindowObservations,planElapsed24HourWindows} from "./rollingExperimentSales.server";
import {postVerifiedSourceReminder} from "./experimentNotices.server";

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
   effect.productId,effect.newPriceCents);
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
 if(complete.length!==days)return "monitoring";
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
