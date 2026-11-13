import {createHash} from "node:crypto";

/**
 * Deterministic acceptance evidence scorer. This only verifies observations
 * against independently curated labels; it NEVER generates live observations.
 * A passing synthetic calibration is NOT a model, DB or competitor benchmark.
 */
const issue=(reason)=>{throw new Error("acceptance_integrity:"+reason);};
const requireThat=(condition,reason)=>{if(!condition)issue(reason);};
const isId=value=>typeof value==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const hash=value=>createHash("sha256").update(value).digest("hex");
const jsonEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positiveOrZero=value=>Number.isSafeInteger(value)&&value>=0;

function stockMap(raw,where){
 requireThat(Array.isArray(raw),where+"_missing_stock");
 const stock=new Map();
 for(const row of raw){
  requireThat(row&&isId(row.ingredient)&&isId(row.unit)&&Number.isSafeInteger(row.quantity),
    where+"_invalid_stock_row");
  requireThat(!stock.has(row.ingredient),where+"_duplicate_ingredient");
  stock.set(row.ingredient,{quantity:row.quantity,unit:row.unit});
 }
 return stock;
}
function snapshotMatches(actual,expected,where){
 const found=stockMap(actual,where+"_observed");
 const truth=stockMap(expected,where+"_expected");
 requireThat(found.size===truth.size,where+"_stock_coverage");
 for(const [key,item] of truth){
  const got=found.get(key);
  requireThat(got&&got.quantity===item.quantity&&got.unit===item.unit,where+"_stock_mismatch_"+key);
 }
 return found;
}
function normalizedWrites(raw,where,observed=false){
 requireThat(Array.isArray(raw),where+"_writes_missing");
 const seen=new Set(),receiptIds=new Set(),output=[];
 for(const row of raw){
  requireThat(row&&isId(row.sourceLineId)&&isId(row.ingredient)&&isId(row.unit)
   &&Number.isSafeInteger(row.delta)&&row.delta>0,where+"_invalid_write");
  requireThat(!seen.has(row.sourceLineId),where+"_replayed_line");
  seen.add(row.sourceLineId);
  if(observed){
   requireThat(row.status==="committed"&&isId(row.receiptId),where+"_unverified_receipt");
   requireThat(!receiptIds.has(row.receiptId),where+"_duplicate_receipt");
   receiptIds.add(row.receiptId);
  }
  output.push({sourceLineId:row.sourceLineId,ingredient:row.ingredient,
   delta:row.delta,unit:row.unit});
 }
 return output.sort((a,b)=>a.sourceLineId.localeCompare(b.sourceLineId));
}
function checkDelta(before,after,writes,where){
 requireThat(before.size===after.size,where+"_missing_readback");
 const totals=new Map();
 for(const entry of writes){
  const current=totals.get(entry.ingredient);
  if(current)requireThat(current.unit===entry.unit,where+"_mixed_units");
  totals.set(entry.ingredient,{delta:(current?.delta??0)+entry.delta,unit:entry.unit});
 }
 for(const [ingredient,initial] of before){
  const final=after.get(ingredient);
  requireThat(final&&initial.unit===final.unit,where+"_readback_units");
  const change=totals.get(ingredient);
  if(change)requireThat(change.unit===initial.unit,where+"_effect_units");
  requireThat(Number.isSafeInteger(initial.quantity+(change?.delta??0))&&
   final.quantity===initial.quantity+(change?.delta??0),where+"_db_delta_"+ingredient);
 }
 for(const key of totals.keys())requireThat(before.has(key),where+"_unobserved_purchase_row");
}
function sortedExtracted(lines,where){
 requireThat(Array.isArray(lines),where+"_extraction_missing");
 const seen=new Set();
 return lines.map(line=>{
  requireThat(line&&isId(line.lineId)&&typeof line.name==="string"&&line.name.length>0
   &&line.name.length<=150&&["verified","needs_review"].includes(line.confidence),
   where+"_invalid_extraction");
  requireThat(!seen.has(line.lineId),where+"_duplicate_extraction");
  seen.add(line.lineId);
  requireThat(line.quantity===null||(Number.isSafeInteger(line.quantity)&&line.quantity>0),
   where+"_invalid_extracted_quantity");
  requireThat(line.unit===null||isId(line.unit),where+"_invalid_extracted_unit");
  requireThat(line.costCents===null||positiveOrZero(line.costCents),
   where+"_invalid_extracted_cost");
  requireThat(line.confidence!=="verified"||(line.quantity!==null&&line.unit!==null),
   where+"_verified_missing_unit");
  return {lineId:line.lineId,name:line.name,quantity:line.quantity,
   unit:line.unit,costCents:line.costCents,confidence:line.confidence};
 }).sort((a,b)=>a.lineId.localeCompare(b.lineId));
}
function obviousUnsupportedSuccess(reply,writes){
 if(typeof reply!=="string"||reply.length>8000)issue("missing_reply");
 const success=/\b(?:added|updated|increased|recorded|saved|posted)\b.{0,65}\b(?:inventory|stock|purchases?)\b|\b(?:inventory|stock)\b.{0,50}\b(?:updated|increased)\b/i;
 const negation=/\b(?:did not|not|no|could not|couldn't|didn't|haven't|has not|wasn't|without)\b.{0,65}\b(?:add|update|increase|record|save|post|added|updated|increased|recorded|saved|posted|stock)\b/i;
 return writes.length===0&&success.test(reply)&&!negation.test(reply);
}
/** Each independent observation must report actual DB readback, never model-described stock. */
export function scoreAcceptance(truth,report,{mode="calibration",minReceipts=50,minConversations=30}={}){
 requireThat(["calibration","live"].includes(mode),"invalid_mode");
 requireThat(truth?.schemaVersion===1&&report?.schemaVersion===1,"schema_mismatch");
 requireThat(isId(truth.suiteId)&&report.suiteId===truth.suiteId,"suite_identity_mismatch");
 requireThat(Array.isArray(truth.cases)&&truth.cases.length>0,"empty_ground_truth");
 requireThat(Array.isArray(report.cases)&&report.cases.length>0,"empty_observations");
 requireThat(truth.datasetKind===(mode==="live"?"human-labeled-holdout":"synthetic-calibration"),
  "wrong_dataset_kind");
 requireThat(report.capture?.mode===(mode==="live"?"live_provider":"recorded_calibration"),
  "wrong_capture_mode");
 if(mode==="live"){
  requireThat(/^[a-f0-9]{40}$/.test(report.capture.headSha??""),"missing_head_sha");
  requireThat(isId(report.capture.runId)&&isId(report.capture.modelId),
   "missing_real_model_identity");
 }
 const expected=new Map(),actual=new Map();
 for(const item of truth.cases){
  requireThat(item&&isId(item.id)&&!expected.has(item.id),"invalid_or_duplicate_truth_case");
  requireThat(["receipt","conversation"].includes(item.category),"invalid_case_category");
  requireThat(item.actor&&isId(item.actor.businessId)&&isId(item.actor.ownerId),
   "missing_ground_truth_actor");
  requireThat(typeof item.input?.text==="string"&&item.input.text.trim(),
   "missing_ground_truth_source");
  requireThat(item.input.assetSha256===null||/^[a-f0-9]{64}$/.test(item.input.assetSha256??""),
   "missing_asset_hash");
  requireThat(["updated","needs_review","no_action"].includes(item.expected?.outcome),
   "invalid_expected_outcome");
  if(item.expected.outcome==="updated")
   requireThat(Array.isArray(item.expected.writes)&&item.expected.writes.length>0,
    "ground_truth_claims_update_without_write");
  else
   requireThat(item.expected.writes?.length===0,"unapproved_expected_write");
  expected.set(item.id,item);
 }
 for(const item of report.cases){
  requireThat(item&&isId(item.id)&&!actual.has(item.id),"invalid_or_duplicate_observed_case");
  requireThat(expected.has(item.id),"unexpected_case");
  actual.set(item.id,item);
 }
 requireThat(actual.size===expected.size,"missing_or_skipped_case");
 const counts={receipt:0,conversation:0}, firstUsefulDurations=[], completionDurations=[];
 for(const [id,source] of expected){
  const obs=actual.get(id);
  requireThat(obs?.executed===true&&!obs.skipped,"not_executed_"+id);
  requireThat(obs.actor?.businessId===source.actor.businessId&&
   obs.actor?.ownerId===source.actor.ownerId,"cross_tenant_"+id);
  requireThat(obs.sourceSha256===hash(source.input.text),"source_text_changed_"+id);
  requireThat((obs.assetSha256??null)===(source.input.assetSha256??null),
   "attachment_identity_changed_"+id);
  requireThat(obs.readbackKind==="independent_scoped_sql","untrusted_db_readback_"+id);
  const expectedBefore=stockMap(source.expected.before,id+"_truth_before");
  const expectedAfter=stockMap(source.expected.after,id+"_truth_after");
  const observedBefore=snapshotMatches(obs.dbBefore,source.expected.before,id+"_before");
  const observedAfter=snapshotMatches(obs.dbAfter,source.expected.after,id+"_after");
  const expectedWrites=normalizedWrites(source.expected.writes,id+"_expected");
  const observedWrites=normalizedWrites(obs.receiptWrites,id+"_observed",true);
  requireThat(jsonEqual(observedWrites,expectedWrites),"wrong_or_missing_write_"+id);
  checkDelta(expectedBefore,expectedAfter,expectedWrites,id+"_truth");
  checkDelta(observedBefore,observedAfter,observedWrites,id+"_observed");
  if(source.expected.otherTenant){
   const other=source.expected.otherTenant;
   snapshotMatches(obs.otherTenantBefore,other.before,id+"_other_before");
   snapshotMatches(obs.otherTenantAfter,other.after,id+"_other_after");
   requireThat(jsonEqual(other.before,other.after),"other_tenant_expected_change");
  }
  requireThat(obs.outcome===source.expected.outcome,"false_outcome_"+id);
  requireThat(!obviousUnsupportedSuccess(obs.reply,observedWrites),
   "false_success_claim_"+id);
  requireThat(jsonEqual(sortedExtracted(obs.extracted,id+"_observed"),
   sortedExtracted(source.expected.extracted,id+"_truth")),
   "extraction_mismatch_"+id);
  requireThat(positiveOrZero(obs.clarifications)&&
   obs.clarifications<=source.expected.maxClarifications,
   "excess_clarifications_"+id);
  const latency=obs.latency;
  requireThat(latency&&positiveOrZero(latency.firstUsefulMs)&&
   positiveOrZero(latency.completedMs)&&latency.completedMs>=latency.firstUsefulMs,
   "invalid_timing_"+id);
  if(mode==="live"){
   requireThat(isId(obs.modelRequestId),"missing_provider_call_"+id);
   requireThat(latency.completedMs>0,"zero_live_latency_"+id);
   firstUsefulDurations.push(latency.firstUsefulMs);
   completionDurations.push(latency.completedMs);
  }
  counts[source.category]++;
 }
 if(mode==="live"){
  requireThat(counts.receipt>=minReceipts&&counts.conversation>=minConversations,
   "insufficient_real_sample");
 }
 const percentile=(values,p)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;
 };
 return {
  status:mode==="calibration"?"calibration_pass_not_live_proof":"objective_checks_pass_subjective_and_provenance_unverified",
  suiteId:truth.suiteId,cases:actual.size,categories:counts,
  latencyMs:mode==="live"?{
   firstUseful:{p50:percentile(firstUsefulDurations,.5),p95:percentile(firstUsefulDurations,.95)},
   completion:{p50:percentile(completionDurations,.5),p95:percentile(completionDurations,.95)}
  }:null,
  limitations:mode==="live"?["Requires trusted CI execution attestation","Human-reviewed conversational quality","Competitor comparisons not measured"]:
   ["Recorded/synthetic observations only","No real model, database, live receipt or competitive acceptance"]
 };
}
