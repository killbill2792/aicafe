import assert from "node:assert/strict";
export const requiredFamilies=Object.freeze([
 "sales_decline","inventory_depletion","supplier_cost_change","late_purchase_order",
 "receiving_invoice_discrepancy","staff_absence","staff_coverage","equipment_failure",
 "pricing_experiment","cashflow","event_goals_briefs","chat_routine","chat_files",
 "concurrent_cafes","worker_restart","provider_outage","expired_lease","uncertain_receipt",
 "duplicate_event","revoked_access","offline_owner","authorized_effect_recovery"
]);
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
