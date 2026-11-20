import assert from "node:assert/strict";
// Coverage is about the producer, not just the tool that can answer a prompt.
// These are acceptance obligations, not claims that the producer exists or passed.
// Keep separate cases for deterministic delivery, real model investigation, and
// unsupported/undiscovered source triggers. A linked manifest is a candidate only.
export const proactiveRequirements=Object.freeze([
 ["sales_rise_opportunity","SALES_INCREASED","",["17b-sales-labor"],"source_only"],
 ["sales_drop_live","SALES_DECLINED","",["17b-sales-labor"],"source_only"],
 ["ingredient_cost_rise","INGREDIENT_COST_INCREASED","",["17b-supply-finance","14b"],"source_only"],
 ["product_cost_change","PRODUCT_COST_CHANGED","",["17b-supply-finance"],"source_only"],
 ["product_margin_decline","PRODUCT_PROFITABILITY_DECLINED","",["17b-supply-finance"],"source_only"],
 ["high_contribution_opportunity","PRODUCT_HIGH_CONTRIBUTION","",["17b-supply-finance"],"source_only"],
 ["labor_cost_change","LABOR_COST_CHANGED","",["17b-sales-labor"],"source_only"],
 ["expense_spike","EXPENSE_INCREASED","",["14e-autonomous-followup","17b-supply-finance"],"source_only"],
 ["operating_margin_decline","OPERATING_MARGIN_DECLINED","",["17b-sales-labor","17b-supply-finance"],"source_only"],
 ["pricing_review_snooze_reopen","PRICE_REVIEW_REQUIRED","price_review",[],"projection_only"],
 ["stock_count_low","INVENTORY_LOW","supply_check",["14b"],"partial"],
 ["forecast_stockout","STOCKOUT_RISK","supply_check",["14b"],"partial"],
 ["supplier_quote_change","SUPPLIER_COST_CHANGED","",["14b","17c-procurement-recovery"],"source_only"],
 ["missing_or_stale_source","DATA_INCOMPLETE","data_quality",["15c"],"partial"],
 ["missing_bill_autonomous_resolution","","",["17c-business-monitors"],"registered"],
 ["unusual_voids_verified_coverage","","",["17c-business-monitors"],"source_only"],
 ["meal_break_actual_not_schedule","","",["17c-business-monitors"],"source_only"],
 ["refund_spike","","",[],"source_only"],
 ["no_clock_in_at_shift_start","","staff_coverage",["13c","15c"],"source_only"],
 ["early_clock_in","","",[],"source_only"],
 ["overstaffed_hour","","",[],"source_only"],
 ["faster_cost_recovery","","",[],"source_only"],
 ["staff_publish_delivery_followup","","staff_coverage",["13c","15c"],"partial"],
 ["staff_leave_swap_recruitment","","staff_coordination",["13d"],"registered"],
 ["staff_unanswered_request","","staff_coverage",["13c","17c-autonomy"],"partial"],
 ["staff_decline_revision","","staff_coverage",["17c-autonomy","15c"],"registered"],
 ["supplier_draft_overdue","","",["17c-procurement-recovery"],"registered"],
 ["supplier_approved_unsent","","",["17c-procurement-recovery","14c"],"registered"],
 ["supplier_delivery_late","","supplier_receiving",["14d-autonomous"],"partial"],
 ["supplier_short_delivery_invoice","","supplier_receiving",["14d-autonomous"],"registered"],
 ["payable_due_overdue_duplicate","","money_update",["14e-payables","14e-autonomous-followup"],"partial"],
 ["changed_statement_cash_risk","","money_update",["14e-autonomous-followup","17c-autonomy"],"registered"],
 ["maintenance_assignment_vendor_sla","","maintenance_issue",["15b"],"registered"],
 ["experiment_awaiting_pos_confirmation","","price_experiment_report",["8a-approved-experiment"],"partial"],
 ["experiment_daily_guardrail_revert","","price_experiment_report",["8a-approved-experiment"],"partial"],
 ["experiment_missing_day_correction_final","","price_experiment_report",["8a-approved-experiment"],"partial"],
 ["goal_daily_progress_final","","goal_report",["16a"],"partial"],
 ["goal_checkin_due_answer_missed","","goal_checkin",[],"missing_live_case"],
 ["event_discovery_no_action_or_plan","","event_plan",["8b-multiday-lifecycle"],"partial"],
 ["event_change_cancel_truthful_replan","","event_change",["8b-multiday-lifecycle"],"partial"],
 ["event_live_surprise_and_report","","event_report",["8b-multiday-lifecycle"],"partial"],
 ["morning_brief_due_coverage_retry","","daily_brief",[],"missing_live_case"],
 ["commitment_due_once_close","","commitment",["17c"],"partial"],
 ["priority_notice_cap_mute_dedupe","","priority_notice",["17c-autonomy","17c-business-monitors"],"partial"],
 ["routine_pause_revoke_catchup_dst","","",["17b-owner-security","17c"],"partial"],
 ["whatsapp_consent_window_receipt","","",[],"missing_live_case"],
 ["gmail_inbound_reply_revocation","","",["14d-autonomous","15b","16c"],"partial"],
 ["ownerless_thread_or_revoked_owner","","",["15c"],"partial"],
 ["provider_timeout_quota_backoff","","",["15c","17c-autonomy","6-15c-owner-run"],"partial"],
 ["multi_cafe_concurrency_fairness","","",["17c-autonomy","15c","6-15c-owner-run"],"partial"],
 ["standing_mandate_expiry_limit","","",["16a"],"partial"],
 ["healthy_control_and_no_false_notice","","",["17c-business-monitors"],"registered"],
 ["unmatched_item_import_recovery","","",[],"missing_live_case"],
 ["pos_disconnect_stale_partial_recovery","","",["17b-sales-labor"],"partial"],
 ["source_revision_repeat_reopen","","",["17c-autonomy","17c-business-monitors"],"registered"],
 ["goal_progress_guardrail_no_auto_effect","","goal_report",[],"missing_live_case"],
 ["live_sales_growth_opportunity","","",[],"source_only"],
 ["historical_sales_decline","","",[],"source_only"],
 ["consumption_variance","","",[],"source_only"],
 ["cost_recovery_lag","","",[],"source_only"],
 ["customer_trends_identity_and_anonymous","","",["pos0ef-customer-trends"],"partial"],
 ["customer_detail_identity_privacy","","",["pos0ef-customer-detail","pos0ef-customer-identity"],"partial"],
 ["stock_to_procurement_authorized_draft","","",["14b","17c-procurement-recovery"],"partial"],
 ["proactive_owner_answer_same_episode","","",["15a-proactive-owner-answer"],"partial"],
 ["independent_toast_price_observation","","",["8a-price-observation"],"partial"],
 ["durable_chat_admission_kill_restart","","",["6-15c-owner-run"],"partial"],
 ["proactive_rich_response_and_reload","","",["16e","17c"],"partial"],
 ["attachment_report_reconnect_identity","","",["16e","17c","6-15c-owner-run"],"partial"],
 ["multi_day_event_occurrence_identity","","",["8b-multiday-lifecycle"],"partial"],
].map(([family,signal,taskKind,candidates,state])=>Object.freeze({family,signal,taskKind,candidates:Object.freeze(candidates),state})));

// Actual merged anomaly producer vocabulary; separate from general CafeSignal projections.
// A source mapping does not certify all thresholds, tenant scope, dispatch or Luna behavior.
export const businessAnomalyCoverage=Object.freeze({
 "sales_decline": "historical_sales_decline",
 "live_sales_decline": "sales_drop_live",
 "live_sales_growth": "live_sales_growth_opportunity",
 "sales_growth": "sales_rise_opportunity",
 "labor_cost": "labor_cost_change",
 "recorded_expense_rise": "expense_spike",
 "recorded_refund_rise": "refund_spike",
 "order_refund_rise": "refund_spike",
 "ingredient_cost": "ingredient_cost_rise",
 "stock_shortage": "stock_count_low",
 "stockout_risk": "forecast_stockout",
 "consumption_variance": "consumption_variance",
 "supplier_quote": "supplier_quote_change",
 "product_cost": "product_cost_change",
 "product_contribution": "product_margin_decline",
 "high_contribution": "high_contribution_opportunity",
 "operating_margin": "operating_margin_decline",
 "cost_recovery_lag": "cost_recovery_lag",
 "cost_recovery_ahead": "faster_cost_recovery",
 "overstaffed_hour": "overstaffed_hour",
 "early_clock_in": "early_clock_in",
 "missed_clock_evidence": "no_clock_in_at_shift_start",
 "data_gap": "missing_or_stale_source",
 "customer_trend": "customer_trends_identity_and_anonymous"
});
export function auditBusinessAnomalyCoverage(keys){
 const obligations=new Set(proactiveRequirements.map(x=>x.family));
 const actual=new Set(keys),mapped=Object.keys(businessAnomalyCoverage);
 return {missing:[...actual].filter(k=>!Object.hasOwn(businessAnomalyCoverage,k)).sort(),
  retired:mapped.filter(k=>!actual.has(k)).sort(),
  orphaned:mapped.filter(k=>!obligations.has(businessAnomalyCoverage[k])).sort(),complete:false};
}

export const cronProactiveCoverage=Object.freeze({
 "team-alerts":["whatsapp_consent_window_receipt"],
 "supervisor-experiments":["experiment_awaiting_pos_confirmation","experiment_daily_guardrail_revert","experiment_missing_day_correction_final","goal_daily_progress_final","goal_checkin_due_answer_missed","authorized_effect_recovery"],
 "admin-question-patterns":["internal_analytics_not_owner_agent"],
 "toast-sync":["pos_disconnect_stale_partial_recovery","unmatched_item_import_recovery"],
 "square-sync":["pos_disconnect_stale_partial_recovery","unmatched_item_import_recovery"],
 "refresh-derived":["missing_bill_autonomous_resolution","unusual_voids_verified_coverage","meal_break_actual_not_schedule","staff_unanswered_request","supplier_draft_overdue","supplier_approved_unsent","commitment_due_once_close","routine_pause_revoke_catchup_dst","changed_statement_cash_risk","supplier_short_delivery_invoice"],
 "daily-brief":["morning_brief_due_coverage_retry","whatsapp_consent_window_receipt"],
 "today-live":["sales_drop_live","no_clock_in_at_shift_start","event_live_surprise_and_report"],
 "events-lookahead":["event_discovery_no_action_or_plan","event_change_cancel_truthful_replan","event_live_surprise_and_report"],
 "whatsapp-supervisor":["whatsapp_consent_window_receipt","authorized_effect_recovery"],
 "data-health":["missing_or_stale_source","pos_disconnect_stale_partial_recovery"],
 "menu-labels":["missing_or_stale_source"]
});
export const manualCronCoverage=Object.freeze({"supervisor-run-worker":["worker_restart","offline_owner","authorized_effect_recovery"]});
export function auditProactiveInventory({signals,taskKinds,cronPaths,routePaths=cronPaths,manifestIds}){
 const required=new Set(proactiveRequirements.map(x=>x.family));
 assert.equal(required.size,proactiveRequirements.length,"duplicate proactive requirement");
 const absent=(expected,actual)=>[...new Set(expected)].filter(x=>!actual.has(x)).sort();
 const mappedSignals=new Set(proactiveRequirements.map(x=>x.signal).filter(Boolean));
 const mappedKinds=new Set(proactiveRequirements.map(x=>x.taskKind).filter(Boolean));
 const cronNames=new Set(Object.keys(cronProactiveCoverage));
 const actualCrons=cronPaths.map(p=>p.replace(/^\/api\/cron\//,""));
 const actualRoutes=routePaths.map(p=>p.replace(/^\/api\/cron\//,""));
 const designedRoutes=new Set([...cronNames,...Object.keys(manualCronCoverage)]);
 const missingCandidates=proactiveRequirements.flatMap(x=>x.candidates.filter(id=>!manifestIds.includes(id)).map(id=>x.family+":"+id));
 return {missingSignals:absent(signals,mappedSignals),missingTaskKinds:absent(taskKinds,mappedKinds),
  missingCrons:absent(actualCrons,cronNames),retiredCrons:absent([...cronNames],new Set(actualCrons)),
  missingRoutes:absent(actualRoutes,designedRoutes),retiredRoutes:absent([...designedRoutes],new Set(actualRoutes)),
  unscheduledWorkers:Object.keys(manualCronCoverage).filter(x=>!actualCrons.includes(x)),
  missingCandidates:[...new Set(missingCandidates)].sort(),
  unregistered:proactiveRequirements.filter(x=>x.state!=="registered").map(x=>({family:x.family,state:x.state})),
  complete:false}; // inventory alone can NEVER prove proactive behavior
}

export const requiredFamilies=Object.freeze([...new Set([
 "sales_decline","inventory_depletion","supplier_cost_change","late_purchase_order",
 "receiving_invoice_discrepancy","staff_absence","staff_coverage","equipment_failure",
 "pricing_experiment","cashflow","event_goals_briefs","chat_routine","chat_files",
 "concurrent_cafes","worker_restart","provider_outage","expired_lease","uncertain_receipt",
 "duplicate_event","revoked_access","offline_owner","authorized_effect_recovery",
 ...proactiveRequirements.map(x=>x.family)
])]);
export function verifyRoutineAndFile({scope,expected,routines,reply,attachments,ownerRows,usage,proposals,foreignRows}){
 assert.equal(routines.length,1,"one routine, not zero or duplicate");
 const routine=routines[0];
 for(const [field,value] of Object.entries({business_id:scope.businessId,owner_user_id:scope.ownerUserId,
   thread_id:scope.threadId,title:expected.title,cadence:"daily",timezone:expected.timezone,status:"active"}))
  assert.equal(routine[field],value,field);
 assert.equal(String(routine.local_time).slice(0,5),expected.time,"exact local schedule");
 assert.equal(Number(routine.revision),1);
 assert.deepEqual(routine.weekdays,[]);
 assert.equal(attachments.length,1);
 assert.equal(attachments[0].id,scope.attachmentId);
 assert.equal(attachments[0].business_id,scope.businessId);
 assert.equal(attachments[0].owner_user_id,scope.ownerUserId);
 assert.equal(attachments[0].thread_id,scope.threadId);
 assert.equal(ownerRows.length,1,"one genuine owner delegation");
 assert.equal(reply.length,1,"one persisted supervisor reply");
 const text=JSON.stringify(reply[0].structured_content??"");
 assert.ok(text.includes(expected.reference),"exact private source reference absent");
 assert.match(text,/oat milk/i);
 assert.ok(new RegExp("(?:^|[^0-9])"+expected.quantity+"(?:[^0-9]|$)").test(text),"exact source quantity absent");
 assert.equal(usage.model,"gpt-6-luna");
 assert.ok(Number.isSafeInteger(Number(usage.model_call_count))&&Number(usage.model_call_count)>=2);
 assert.ok(Number(usage.input_tokens)>0);
 assert.equal(proposals.length,0,"not authorized to buy/send/change stock");
 assert.equal(foreignRows.length,0,"cross-cafe data leak");
 return routine.id;
}
// Independent acceptance gate. Named scenarios or candidate PASS claims alone
// cannot certify a family. The host must supply independently validated receipts.
export function assessCoverage({head,inventoryFamilies=[],receipts=[]}){
 assert.match(head,/^[a-f0-9]{40}$/);
 assert.ok(Array.isArray(inventoryFamilies)&&inventoryFamilies.every(x=>typeof x==="string"&&x.length>0));
 const required=[...new Set([...requiredFamilies,...inventoryFamilies])];
 const rows=required.map(family=>{
  const matched=receipts.filter(r=>r.family===family&&r.head===head);
  const passed=matched.some(r=>r.model==="gpt-6-luna"&&r.providerAttested===true&&
    r.sourceVerified===true&&r.ownerVerified===true&&r.effectVerified===true&&
    r.negativeControlsVerified===true&&r.executionArtifact&&r.status==="PASS");
  const failed=matched.some(r=>r.status==="FAIL");
  return {family,status:failed?"FAIL":passed?"PASS":"NOT_PROVEN"};
 });
 // Empty or unavailable registry census is itself a blocking gap.
 return {head,rows,integratedProven:inventoryFamilies.length>0&&rows.every(r=>r.status==="PASS")};
}

export function verifyScheduledOccurrence({expected,firstPid,secondPid,before,after}){
 assert.ok(Number.isSafeInteger(firstPid)&&firstPid>0);
 assert.ok(Number.isSafeInteger(secondPid)&&secondPid>0&&secondPid!==firstPid,"different worker process");
 assert.equal(before.length,1,"one due occurrence must actually complete");
 const occurrence=before[0];
 assert.match(occurrence.run_id,/^[0-9a-f-]{36}$/i);
 assert.equal(occurrence.local_date,expected.localDate);
 assert.equal(Number(occurrence.revision),1);
 assert.equal(Number(occurrence.attempts),1);
 assert.equal(occurrence.state,"completed");
 assert.match(occurrence.receipt_ref,/^priority-check:[0-9]+$/);
 assert.deepEqual(after,before,"duplicate tick must not change run, receipt or attempts");
 return occurrence.run_id;
}

export function verifyOperatingWorld({world,evidence:e}){
 const {staff,finance}=world;
 assert.notEqual(staff.businessId,finance.businessId);
 assert.notEqual(staff.ownerUserId,finance.ownerUserId);
 const byTarget=(list,t)=>{
  const matches=list.filter(x=>x.business_id===t.businessId&&x.source_id===t.taskId);
  assert.equal(matches.length,1,"one durable investigation per source");
  return matches[0];
 };
 for(const list of [e.queued,e.recovered,e.followed])assert.equal(list.length,2,"two scoped incidents");
 const staffEpisode=byTarget(e.queued,staff).episode_id,financeEpisode=byTarget(e.queued,finance).episode_id;
 assert.notEqual(staffEpisode,financeEpisode);
 assert.ok([staffEpisode,financeEpisode].includes(e.interruptedEpisode));
 assert.ok(Number.isSafeInteger(e.originalPid)&&e.originalPid>0&&Number.isSafeInteger(e.recoveryPid)&&e.recoveryPid>0&&e.originalPid!==e.recoveryPid);
 for(const t of [staff,finance]){
  const id=byTarget(e.queued,t).episode_id;
  for(const list of [e.recovered,e.followed]){
   const item=byTarget(list,t);
   assert.equal(item.episode_id,id,"must resume same episode");
   assert.equal(item.phase,"awaiting_owner","no invented resolution");
   assert.equal(item.lease_token,null);
   const tools=item.evidence.modelTools;
   assert.ok(Array.isArray(tools)&&tools.includes("get_investigation_source"));
   if(t===staff){
    assert.ok(tools.includes("get_staff_messages"));
    assert.ok(tools.some(n=>["get_schedule","get_week_schedule","get_coverage_gaps"].includes(n)));
   }else{
    assert.ok(tools.includes("get_cashflow_evidence")&&tools.includes("get_bills"));
   }
  }
 }
 assert.equal(e.staffNotices.length,1,"no repeated notice for unchanged staff incident");
 assert.equal(e.financeBefore.length,1);
 assert.equal(e.financeNew.length,1,"one updated notice for changed source");
 assert.notEqual(e.financeBefore[0].id,e.financeNew[0].id);
 assert.equal(e.ownerRows.length,0,"no owner prompt");
 assert.equal(e.effects.length,0,"no unauthorized effect");
 assert.equal(e.proposals.length,0,"no invented proposal");
 assert.deepEqual(e.shifts,[{id:staff.shiftId,employee_id:staff.employeeId,status:"sent"}]);
 assert.equal(e.sources.length,2);
 for(const [id,cents] of [[finance.firstUploadId,world.initialCash],[e.secondUploadId,world.laterCash]]){
  const row=e.sources.find(x=>x.id===id);
  assert.ok(row);
  assert.equal(row.business_id,finance.businessId);
  assert.equal(Number(row.financial_closing_cents),cents);
 }
 const abandoned=e.usage.filter(x=>x.status==="attempted");
 assert.equal(abandoned.length,1,"one abandoned reservation");
 assert.equal(abandoned[0].model,"gpt-6-luna");
 assert.equal(abandoned[0].input_tokens,null);
 assert.equal(abandoned[0].business_id,e.interruptedEpisode===staffEpisode?staff.businessId:finance.businessId);
 const completed=e.usage.filter(x=>x.status==="completed");
 assert.equal(e.usage.length,completed.length+1);
 assert.ok(completed.length>=4&&completed.length<=18,"bounded completed Luna provider calls");
 assert.ok(completed.every(x=>x.model==="gpt-6-luna"&&Number(x.input_tokens)>0));
 assert.ok([staff,finance].every(t=>completed.some(x=>x.business_id===t.businessId)));
 return {providerCalls:completed.length,staffEpisodeId:staffEpisode,financeEpisodeId:financeEpisode,
  staffNoticeId:e.staffNotices[0].id,financeFirstNoticeId:e.financeBefore[0].id,financeFollowupNoticeId:e.financeNew[0].id};
}

export function verifyProcurementOutcome(x){
 const {expected:e,proposal:p}=x;
 const payload=p.canonical_effect_payload;
 assert.equal(p.status,"draft");
 assert.equal(p.capability_id,"maya.supplier_purchase_order.v1");
 assert.equal(payload.supplierName,e.supplier);
 assert.equal(payload.currency,e.currency);
 assert.equal(payload.subtotalCents,e.packs*e.price);
 assert.equal(payload.lines.length,1);
 assert.equal(payload.lines[0].quoteId,e.quoteId);
 assert.equal(payload.lines[0].packs,e.packs);
 assert.equal(x.preOrders.length,0);
 assert.equal(x.preAttempts.length,0);
 assert.ok([401,403,404].includes(x.foreignStatus));
 assert.equal(x.foreignOrders.length,0);
 assert.equal(x.foreignAttempts.length,0);
 assert.equal(x.dropped,true);
 assert.equal(x.serverStatus,200);
 assert.equal(x.committed.length,1);
 const order=x.committed[0];
 assert.equal(order.proposal_id,p.id);
 assert.equal(order.status,"approved_for_ordering");
 assert.equal(Number(order.subtotal_cents),e.packs*e.price);
 assert.equal(order.currency_code,e.currency);
 assert.equal(order.effect_hash,p.effect_hash);
 assert.equal(x.committedAttempts.length,1);
 const attempt=x.committedAttempts[0];
 assert.ok(attempt.attempt_key);
 assert.equal(attempt.effect_hash,p.effect_hash);
 assert.equal(attempt.authorization_kind,"click");
 assert.equal(attempt.state,"verified");
 assert.equal(attempt.receipt_ref,"purchase_orders:"+order.id);
 assert.deepEqual(x.afterAttempts,x.committedAttempts,"replay cannot create a second effect reservation");
 assert.deepEqual(x.approvals,[{owner_user_id:e.ownerUserId,effect_hash:p.effect_hash,authorization_kind:"click"}]);
 assert.ok([200,409,422].includes(x.replayStatus));
 assert.deepEqual(x.after,x.committed,"replayed approval cannot duplicate or mutate order");
 assert.deepEqual(x.finalProposal,[{id:p.id,status:"committed",effect_hash:p.effect_hash}]);
 assert.deepEqual(x.afterCounts,x.before,"PO approval is neither delivery, stock receipt nor payment");
 return order.id;
}
export function verifyRevocationOutcome(x){
 const good=JSON.stringify(x.good??[]),after=JSON.stringify(x.after??[]);
 assert.ok(good.includes(x.canary)&&/oat milk/i.test(good));
 // Remove the UUID before searching for a quantity: its digits must not
 // accidentally satisfy the independent quantity oracle.
 assert.ok(new RegExp("(?:^|[^0-9])"+x.qty+"(?:[^0-9]|$)").test(good.replaceAll(x.canary,"")));
 assert.equal(x.blocked,"supervisor_file_access_revoked");
 assert.equal(x.blockedUse.length,0);
 assert.ok([401,403,404].includes(x.foreignStatus)||(x.foreignStatus===503&&x.foreignError==="access_change_unverified"));
 assert.equal(x.prematureAccess.length,0);
 assert.ok(after.length>2);
 assert.ok(!after.includes(x.canary),"revoked private reference cannot recur");
 assert.deepEqual(x.access,[{allowed:false}]);
 assert.equal(x.proposals.length,0);
 assert.deepEqual(x.afterCounts,x.before);
}
export function verifyMonitorOutcome(x){
 const expected={id:x.alertId,business_id:x.businessId,status:"new"};
 assert.deepEqual(x.opened,[expected],"only the affected cafe may produce a missing bill alert");
 assert.deepEqual(x.repeated,x.opened,"repeated refresh must not create another alert");
 assert.equal(x.pending.length,1);
 const episode=x.pending[0];
 assert.equal(episode.phase,"awaiting_owner");
 assert.ok(["get_investigation_source","get_expenses","get_bills"].every(t=>episode.evidence.modelTools.includes(t)));
 assert.deepEqual(x.closed,[{...expected,status:"resolved"}]);
 assert.equal(x.finished.length,1);
 assert.equal(x.finished[0].episode_id,episode.episode_id);
 assert.equal(x.finished[0].phase,"resolved");
 assert.equal(x.beforeNotices.length,1);
 assert.equal(x.afterNotices.length,1);
 assert.notEqual(x.beforeNotices[0].id,x.afterNotices[0].id);
 assert.equal(x.ownerRows.length,0);
 assert.equal(x.effects.length,0);
 assert.equal(x.expenses.length,2);
 for(const id of [x.oldExpenseId,x.newExpenseId])assert.equal(Number(x.expenses.find(e=>e.id===id)?.amount_cents),x.amount);
 assert.ok(x.usage.length>=2&&x.usage.length<=18);
 assert.ok(x.usage.every(r=>r.status==="completed"&&r.model==="gpt-6-luna"&&Number(r.input_tokens)>0));
 return {episodeId:episode.episode_id,noticeId:x.beforeNotices[0].id,resolutionNoticeId:x.afterNotices[0].id,providerCalls:x.usage.length};
}

export function verifySupplierReminderOutcome(x){
 const checkNotice=(notices,messages,repeated,repeatedMessages,expectedText)=>{
  assert.equal(notices.length,1);
  assert.equal(notices[0].status,"needs_owner");
  assert.equal(notices[0].thread_id,x.threadId);
  assert.equal(messages.length,1);
  assert.equal(messages[0].thread_id,x.threadId);
  assert.match(JSON.stringify(messages[0].structured_content),expectedText);
  assert.deepEqual(repeated,notices,"duplicate tick changed source notice");
  assert.deepEqual(repeatedMessages,messages,"duplicate tick changed chat notice");
 };
 assert.deepEqual(x.earlyDraft,[]);
 assert.deepEqual(x.earlyDispatch,[]);
 checkNotice(x.draftNotice,x.draftMessage,x.repeatedDraft,x.repeatedDraftMessage,/Supplier purchase-order draft needs your approval/i);
 checkNotice(x.dispatchNotice,x.dispatchMessage,x.repeatedDispatch,x.repeatedDispatchMessage,/Approved order unresolved/i);
 assert.deepEqual(x.handledDraft,[{...x.draftNotice[0],status:"handled"}]);
 assert.notEqual(x.draftNotice[0].id,x.dispatchNotice[0].id);
 assert.notEqual(x.draftMessage[0].id,x.dispatchMessage[0].id);
 assert.deepEqual(x.ownerAfter,x.ownerBefore,"no new owner prompt for reminder");
 assert.deepEqual(x.delivery,[],"reminder must not dispatch a PO");
 assert.deepEqual(x.ordersAfter,x.ordersBefore);
 assert.deepEqual(x.attemptsAfter,x.attemptsBefore);
 assert.deepEqual(x.countsAfter,x.countsBefore);
 return {draftNoticeId:x.draftNotice[0].id,draftNoticeMessageId:x.draftMessage[0].id,
  dispatchNoticeId:x.dispatchNotice[0].id,dispatchNoticeMessageId:x.dispatchMessage[0].id};
}

export function verifySourceAlertLifecycle(x){
 assert.deepEqual(x.negative,[],"unknown void coverage and planned attendance cannot trigger an alert");
 assert.equal(x.opened.length,2);
 const meal=x.opened.find(a=>a.kind==="meal_break"),voids=x.opened.find(a=>a.kind==="voids");
 assert.ok(meal&&voids);
 assert.equal(meal.status,"new");
 assert.equal(voids.status,"new");
 assert.equal(meal.payload.timecardId,x.actualTimecard);
 assert.notEqual(meal.payload.timecardId,x.plannedTimecard);
 assert.equal(Number(meal.impact_cents),x.wage);
 assert.equal(Number(voids.impact_cents),x.voidCents);
 assert.equal(voids.payload.voidsThisMonthCents,x.voidCents);
 assert.equal(voids.payload.avgVoidsPrevious3MonthsCents,0);
 assert.deepEqual(x.repeated,x.opened);
 assert.deepEqual(x.closed,x.opened.map(a=>({...a,status:"resolved"})),"only authoritative correction resolves alert");
 assert.deepEqual(x.repeatedClosed,x.closed);
 assert.deepEqual(x.effects,[]);
 assert.deepEqual(x.ownerRows,[]);
 return {mealAlertId:meal.id,voidAlertId:voids.id};
}
