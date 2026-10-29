/** Pure, exhaustive owner-facing check-state transitions.
 * All reconciliation writers apply this complete patch, never individual columns.
 * An ERA mismatch is independent evidence: only a newer ERA result or reimport
 * may replace it.
 */
export type DayCheckState={
 recon_state:string;recon_source:string|null;internal_state:string|null;
 analytics_state:string|null;last_error_category:string|null;
 warnings:Record<string,unknown>;payment_repull_at:string|null;
 last_recon_attempt_at:string|null;
 reconciled_at:string|null;internal_reasons:string[];paid_other_day:number;
};
export type DayCheckEvent=
 |{type:"internal_result";result:"matched"|"mismatch";reasons:string[];paidOtherDay:number}
 |{type:"payment_recovery_queued"}
 |{type:"internal_missing";reasons:string[];paidOtherDay:number}
 |{type:"payment_recovery_exhausted";reasons:string[];paidOtherDay:number}
 |{type:"era_pending"}
 |{type:"era_result";matched:boolean;sourceIncomplete:boolean;comparisonMatched:boolean;moneyMismatch?:boolean}
 |{type:"era_error";category:string;permissionsLost:boolean}
 |{type:"internal_error";category:string}
 |{type:"era_timeout"}
 |{type:"mode_downgraded"}
 |{type:"evidence_invalidated"}
 |{type:"reimported"};

export function nextDayCheckState(current:DayCheckState,event:DayCheckEvent,at:string):DayCheckState{
 const externalMismatch=current.recon_state==="mismatch"&&current.recon_source==="toast_analytics";
 // Explicitly whitelist check-state columns. Supabase rows also carry
 // imported_at, import run IDs and money totals: spreading one into a patch
 // would fire import-reset/guard triggers even if imported_at is unchanged.
 const next:DayCheckState={
  recon_state:current.recon_state,
  recon_source:current.recon_source??null,
  internal_state:current.internal_state??null,
  analytics_state:current.analytics_state??null,
  last_error_category:current.last_error_category??null,
  payment_repull_at:current.payment_repull_at??null,
  last_recon_attempt_at:at,
  reconciled_at:current.reconciled_at??null,
  internal_reasons:[...(current.internal_reasons??[])],
  paid_other_day:current.paid_other_day??0,
  warnings:{...(current.warnings??{})}};
 const internalVerdict=()=>{
  next.recon_state=externalMismatch?"mismatch":
   next.internal_state==="mismatch"?"mismatch":"checked_internal";
  next.recon_source=externalMismatch?"toast_analytics":"internal";
 };
 const clearTransientWarning=()=>{delete next.warnings.analytics_timeout;};
 switch(event.type){
  case "internal_result":
   for(const old of next.internal_reasons)delete next.warnings[old];
   next.internal_state=event.result;
   next.internal_reasons=[...event.reasons];
   next.paid_other_day=event.paidOtherDay;
   for(const reason of event.reasons)next.warnings[reason]=1;
   next.payment_repull_at=null;next.last_error_category=null;
   next.reconciled_at=at;internalVerdict();break;
  case "internal_missing":
   next.internal_state=null;next.internal_reasons=[...event.reasons];
   next.paid_other_day=event.paidOtherDay;
   for(const reason of event.reasons)next.warnings[reason]=1;
   next.recon_state=externalMismatch?"mismatch":"pending";
   if(!externalMismatch)next.recon_source=null;
   next.last_error_category=null;next.reconciled_at=null;break;
  case "payment_recovery_exhausted":
   next.internal_state=null;next.internal_reasons=[...event.reasons];
   next.paid_other_day=event.paidOtherDay;
   for(const reason of event.reasons)next.warnings[reason]=1;
   next.payment_repull_at=null;
   next.last_error_category="unverified_payment_order";
   next.recon_state=externalMismatch?"mismatch":"pending";
   if(!externalMismatch)next.recon_source=null;
   next.reconciled_at=null;break;
  case "payment_recovery_queued":
   next.internal_reasons=["unknown_payment_order"];
   next.warnings.unknown_payment_order=1;
   next.internal_state=null;
   next.payment_repull_at??=at;
   next.recon_state=externalMismatch?"mismatch":"pending";
   if(!externalMismatch)next.recon_source=null;
   next.last_error_category=null;break;
  case "era_pending":
   internalVerdict();next.analytics_state="pending";
   next.last_error_category=null;clearTransientWarning();break;
  case "era_result":
   next.recon_state=event.moneyMismatch===true?"mismatch":
    event.moneyMismatch===false?(event.matched?"matched":"pending"):
    event.matched?"matched":"mismatch";
   next.recon_source="toast_analytics";next.analytics_state="available";
   next.last_error_category=null;next.reconciled_at=at;
   delete next.warnings.reconciliation_mismatch;
   delete next.warnings.source_incomplete;clearTransientWarning();
   if(!event.comparisonMatched)next.warnings.reconciliation_mismatch=1;
   if(event.sourceIncomplete)next.warnings.source_incomplete=1;
   break;
  case "era_error":
   internalVerdict();next.analytics_state=event.permissionsLost?"missing":"pending";
   next.last_error_category=event.category;break;
  case "internal_error":
   // Internal import/read failures do not invent pending Analytics requests.
   next.last_error_category=event.category;break;
  case "era_timeout":
   internalVerdict();next.analytics_state="missing";
   next.last_error_category=null;next.warnings.analytics_timeout=1;break;
  case "mode_downgraded":
   internalVerdict();
   if(next.analytics_state==="pending")next.analytics_state="missing";
   next.last_error_category=null;break;
  case "evidence_invalidated":
   // Invalidated auxiliary evidence cannot erase an independent ERA mismatch.
   next.recon_state=externalMismatch?"mismatch":"pending";
   if(!externalMismatch)next.recon_source=null;
   next.internal_state=null;
   next.last_error_category=null;next.last_recon_attempt_at=null;
   break;
  case "reimported":
   next.recon_state="pending";next.recon_source=null;next.internal_state=null;
   next.analytics_state=null;next.last_error_category=null;next.internal_reasons=[];
   next.paid_other_day=0;next.reconciled_at=null;next.last_recon_attempt_at=null;
   for(const key of ["reconciliation_mismatch","source_incomplete","analytics_timeout"])
    delete next.warnings[key];
   // Recovery deadline belongs to the unresolved payment, not to an import.
   break;
 }
 return next;
}
