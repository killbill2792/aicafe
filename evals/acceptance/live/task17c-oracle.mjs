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
