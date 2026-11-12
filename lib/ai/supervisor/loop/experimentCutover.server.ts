import "server-only";
import {formatInTimeZone} from "date-fns-tz";

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
import {readVerifiedToastPriceEvidence} from "./toastPriceEvidence.server";
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
/** The ONE new-path monitor handler for verified Toast prices only. Callers
 * must select mode=new first and must bypass the old calendar-day writer.
 * Note the full source and no-shared-credential preconditions; the worker
 * operates only on previously saved Toast facts, never calls Toast directly. */
export async function runVerifiedToastPriceTick(db:SupabaseClient,repo:LoopRepository,
 row:PriceRow,scope:OwnerLoopScope,now:string,timezone:string,
 proposal:LoopProposal):Promise<"waiting_source"|"monitoring"|"reported"|"not_price">{
 const effect=priceEffect(row.canonical_effect_payload);
 if(!effect||!row.approved_at||!isPriceCapability(row.capability_id))return "not_price";
 const published=await readVerifiedToastPriceEvidence(db,row.business_id,
  effect.productId,effect.newPriceCents);
 const targetReady=published.status==="verified"&&
  published.oldPriceCents===effect.oldPriceCents&&
  Date.parse(published.observedAt)>=Date.parse(row.approved_at)&&
  Date.parse(published.startAt)>=Date.parse(row.approved_at);
 if(!targetReady){
  if(row.status==="manual_pending")await postVerifiedSourceReminder(db,{
   businessId:row.business_id,ownerUserId:row.owner_user_id,
   proposalId:row.id,threadId:row.thread_id,productId:effect.productId,
   productName:effect.productName,targetPriceCents:effect.newPriceCents,
   currency:effect.currency,approvedAt:row.approved_at,now,timezone,
   sourceVerified:false,cancelled:false,
  });
  return "waiting_source";
 }
 const receipt=published;
 if(receipt.status!=="verified")return "waiting_source";
 if(row.status==="manual_pending"){
  // Keep the existing Supervisor proposal lifecycle, but only AFTER the
  // source verification guard. The legacy date is not our 24h clock.
  const localToday=formatBusinessDay(now,timezone);
  await repo.transition(scope,row.id,row.revision,"manual_confirmed",localToday);
 }
 const days=row.monitor_spec?.durationDays;
 if(!Number.isSafeInteger(days)||days<1||days>90)
  throw new Error("invalid_experiment_monitor_duration");
 const windows=planElapsed24HourWindows(receipt.startAt,days);
 const complete=[] as Awaited<ReturnType<typeof readElapsedWindowObservations>>[];
 for(const window of windows){
  if(Date.parse(window.endAt)>Date.parse(now))break;
  const measured=await readElapsedWindowObservations(db,row.business_id,
   effect.productId,window,now,timezone);
  const written=await db.from("supervisor_monitor_windows").upsert({
   business_id:row.business_id,owner_user_id:row.owner_user_id,
   monitor_kind:"approved_price",source_id:row.id,window_index:window.index,
   source_reference:{historyId:receipt.historyId,restaurantGuid:receipt.restaurantGuid,
    menuItemId:receipt.menuItemId,publicationVersion:receipt.publicationVersion,
    startBasis:receipt.startBasis,observedAt:receipt.observedAt},
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
 const actual=complete.every(c=>c.status==="actual");
 const units=actual?complete.reduce((a,b)=>a+(b.units??0),0):null;
 const revenue=actual?complete.reduce((a,b)=>a+(b.revenueCents??0),0):null;
 const result={productId:effect.productId,productName:effect.productName,
  oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
  observedUnits:units,observedRevenueCents:revenue,coveredWindows:complete.filter(
   c=>c.status==="actual").length,totalWindows:days,windowStartAt:receipt.startAt,
  windowEndAt:windows.at(-1)!.endAt,sourceBasis:receipt.startBasis,
  extraTradingInterval:{status:"not_verified",revenueCents:null},
  nonCausal:true,sourcePublicationVersion:receipt.publicationVersion};
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
    sourcePublicationVersion:receipt.publicationVersion},
   confidence:actual?"high":"low",
   evidence:[{source:"order_lines",facts:{actualWindowCount:result.coveredWindows,
    totalWindowCount:days,status,nonCausal:true}}],
   threadText:"Toast verified the price for "+effect.productName+
    ". I observed "+result.coveredWindows+" of "+days+
    " elapsed 24-hour sales windows. "+(actual?
    "The recorded lines were complete for those windows.":
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
function formatBusinessDay(instant:string,timezone:string):string{
 // date-fns-tz is required for the true café-local date across DST.
 return formatInTimeZone(new Date(instant),timezone,"yyyy-MM-dd");
}
