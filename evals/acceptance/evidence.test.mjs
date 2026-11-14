import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {scoreAcceptance} from "./evidence.mjs";
// Every code PR must kill-test the real capture gate, without using an API key.
import "./live/preflight.test.mjs";
import "./live/runner.test.mjs";

const load=name=>JSON.parse(readFileSync(new URL("./fixtures/"+name,import.meta.url),"utf8"));
const truth=load("calibration-truth.json");
const report=load("calibration-observations.json");
const clone=value=>structuredClone(value);
function rejected(name,change,expected){
 test("must detect corruption: "+name,()=>{
  const t=clone(truth),o=clone(report);
  change(t,o);
  assert.throws(()=>scoreAcceptance(t,o),error=>
   error instanceof Error && error.message.startsWith("acceptance_integrity:") &&
   (!expected||error.message.includes(expected)));
 });
}
test("independently annotated calibration scenarios pass with exact item, owner and stock evidence",()=>{
 const result=scoreAcceptance(truth,report);
 assert.equal(result.status,"calibration_pass_not_live_proof");
 assert.equal(result.cases,8);
 assert.deepEqual(result.categories,{receipt:5,conversation:3});
 assert.equal(result.latencyMs,null);
 assert.match(result.limitations.join(" "),/No real model/);
});
rejected("missing entire case",(_,o)=>{o.cases.pop();},"missing_or_skipped_case");
rejected("duplicate reported case",(_,o)=>{o.cases.push(clone(o.cases[0]));},"invalid_or_duplicate_observed_case");
rejected("unexpected invented case",(_,o)=>{o.cases[0].id="fake_case";},"unexpected_case");
rejected("skip disguised as a valid row",(_,o)=>{o.cases[0].executed=false;},"not_executed");
rejected("hidden skipped test",(_,o)=>{o.cases[0].skipped=true;},"not_executed");
rejected("wrong owner or café",(_,o)=>{o.cases[0].actor.businessId="another_cafe";},"cross_tenant");
rejected("changed user instruction",(_,o)=>{o.cases[0].sourceSha256="0".repeat(64);},"source_text_changed");
rejected("wrong photo bytes",(_,o)=>{o.cases[1].assetSha256="0".repeat(64);},"attachment_identity_changed");
rejected("missing independent SQL readback",(_,o)=>{o.cases[0].readbackKind="model_said_saved";},"untrusted_db_readback");
rejected("false starting quantity",(_,o)=>{o.cases[0].dbBefore[0].quantity=999;},"stock_mismatch");
rejected("false ending quantity",(_,o)=>{o.cases[0].dbAfter[0].quantity=999;},"stock_mismatch");
rejected("missing durable receipt",(_,o)=>{o.cases[0].receiptWrites=[];},"wrong_or_missing_write");
rejected("committed claim without actual receipt",(_,o)=>{o.cases[0].receiptWrites[0].receiptId="";},"unverified_receipt");
rejected("duplicate stock receipt",(_,o)=>{o.cases[1].receiptWrites[1].receiptId="rec_102";},"duplicate_receipt");
rejected("wrong stock unit",(_,o)=>{o.cases[1].receiptWrites[0].unit="lb";},"wrong_or_missing_write");
rejected("wrong stock quantity",(_,o)=>{o.cases[1].receiptWrites[0].delta=10;},"wrong_or_missing_write");
rejected("wrong source line item",(_,o)=>{o.cases[1].receiptWrites[0].ingredient="beans";},"wrong_or_missing_write");
rejected("unexpected extra write",(_,o)=>{o.cases[2].receiptWrites.push({sourceLineId:"bad_line",ingredient:"milk",delta:1,unit:"gal",status:"committed",receiptId:"rec_222"});},"wrong_or_missing_write");
rejected("no-action case falsely claims update",(_,o)=>{o.cases[3].outcome="updated";},"false_outcome");
rejected("assistant claims success but nothing changed",(_,o)=>{o.cases[3].reply="I updated stock and added inventory purchases."; },"false_success_claim");
rejected("false item-specific purchase claim without inventory keyword",(_,o)=>{o.cases[3].reply="I added five pounds of beans."; },"false_success_claim");
rejected("later false stock claim not hidden by earlier negation",(_,o)=>{o.cases[3].reply="I did not record the purchase, but I added beans."; },"false_success_claim");
rejected("incorrect extracted quantity",(_,o)=>{o.cases[1].extracted[1].quantity=20;},"extraction_mismatch");
rejected("guessed value for blurry evidence",(_,o)=>{o.cases[2].extracted[0].quantity=5;o.cases[2].extracted[0].unit="gal";o.cases[2].extracted[0].confidence="verified";},"extraction_mismatch");
rejected("too many owner questions",(_,o)=>{o.cases[0].clarifications=1;},"excess_clarifications");
rejected("impossibly fast completion",(_,o)=>{o.cases[0].latency.completedMs=1;},"invalid_timing");
rejected("other café inventory changed",(_,o)=>{o.cases[5].otherTenantAfter[0].quantity=777;},"stock_mismatch");
rejected("missing other-café readback",(_,o)=>{delete o.cases[5].otherTenantAfter;},"missing_stock");
rejected("wrong answer expectation in golden labels",(t)=>{t.cases[0].expected.after[0].quantity=200;},"stock_mismatch");
rejected("wrong quantity despite altered label",(t)=>{t.cases[0].expected.writes[0].delta=11;},"wrong_or_missing_write");
rejected("contradictory golden DB delta",(t)=>{t.cases[0].expected.after[0].quantity=111;}, "stock_mismatch");
rejected("golden says updated with no approved effect",(t)=>{t.cases[0].expected.writes=[];},"ground_truth_claims_update_without_write");
rejected("missing expected source",(t)=>{t.cases[0].input.text="";},"missing_ground_truth_source");
rejected("duplicate golden case ids",(t)=>{t.cases[1].id=t.cases[0].id;},"invalid_or_duplicate_truth_case");
rejected("empty golden suite",(t)=>{t.cases=[];},"empty_ground_truth");
test("recorded model cannot fake a real provider request even when other headers look live",()=>{
 const t=clone(truth),o=clone(report);
 t.datasetKind="human-labeled-holdout";
 o.capture.mode="live_provider";
 o.capture.headSha="a".repeat(40);
 o.capture.runId="run_1";
 o.capture.modelId="real_provider";
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live",minReceipts:1,minConversations:1}),/missing_provider_call/);
});
test("synthetic evidence cannot be promoted into real-model acceptance",()=>{
 assert.throws(()=>scoreAcceptance(truth,report,{mode:"live"}),/wrong_dataset_kind/);
});
test("calibration does not count as human-labeled even with a passing-looking status field",()=>{
 const fake=clone(report);
 fake.status="pass";
 fake.capture.mode="live_provider";
 assert.throws(()=>scoreAcceptance(truth,fake),/wrong_capture_mode/);
});
test("source tampering in the truth cannot be overlooked",()=>{
 const t=clone(truth);t.cases[0].input.text="I bought two gallons";
 assert.throws(()=>scoreAcceptance(t,report),/source_text_changed/);
});

/**
 * Synthetic contract exercise of the *live-mode scorer branch*. No model or
 * database is called; even a passing report retains an unverified provenance
 * status. This catches the evaluator defect where live mode always fails.
 */
function syntheticLiveContract(){
 const t=clone(truth),o=clone(report);
 t.datasetKind="human-labeled-holdout";
 o.capture={mode:"live_provider",headSha:"a".repeat(40),
  runId:"synthetic_contract",modelId:"synthetic_contract"};
 t.cases=[];o.cases=[];
 for(let i=0;i<80;i++){
  const receipt=i<50;
  const source=clone(truth.cases[receipt?1:0]);
  const observation=clone(report.cases[receipt?1:0]);
  const id="contract_"+i;
  source.id=id;
  observation.id=id;
  source.input.text+=" (synthetic contract "+i+")";
  observation.sourceSha256=createHash("sha256").update(source.input.text).digest("hex");
  if(receipt){
   source.input.assetSha256=createHash("sha256").update("synthetic_receipt_"+i).digest("hex");
   observation.assetSha256=source.input.assetSha256;
  }
  observation.modelRequestId="synthetic_request_"+i;
  observation.latency={firstUsefulMs:(i+1)*10,completedMs:(i+1)*20};
  t.cases.push(source);
  o.cases.push(observation);
 }
 return {t,o};
}
test("the full-size synthetic live-mode contract reaches scoring, never a real acceptance verdict",()=>{
 const {t,o}=syntheticLiveContract();
 const result=scoreAcceptance(t,o,{mode:"live"});
 assert.equal(result.status,"objective_checks_pass_subjective_and_provenance_unverified");
 assert.deepEqual(result.categories,{receipt:50,conversation:30});
 assert.equal(result.cases,80);
 assert.deepEqual(result.latencyMs,{
  firstUseful:{p50:400,p95:760},completion:{p50:800,p95:1520}
 });
 assert.match(result.limitations.join(" "),/trusted CI execution attestation/);
});
test("live mode refuses a complete-looking set below required sample counts",()=>{
 const {t,o}=syntheticLiveContract();
 t.cases.splice(0,1);o.cases.splice(0,1);
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/insufficient_real_sample/);
});
test("live mode refuses synthetic request IDs missing on one case of a full batch",()=>{
 const {t,o}=syntheticLiveContract();
 delete o.cases[25].modelRequestId;
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/missing_provider_call/);
});
test("live mode requires an exact GitHub head and trustworthy model identifier shape",()=>{
 const {t,o}=syntheticLiveContract();
 o.capture.headSha="not_a_commit";
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/missing_head_sha/);
});
test("live mode still rejects a wrong database delta in one of 80 otherwise valid cases",()=>{
 const {t,o}=syntheticLiveContract();
 o.cases[79].dbAfter[0].quantity+=1;
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/stock_mismatch/);
});

test("live benchmark cannot manufacture 50 receipts by repeating one image",()=>{
 const {t,o}=syntheticLiveContract();
 const copied=t.cases[0].input.assetSha256;
 for(let i=1;i<50;i++){
  t.cases[i].input.assetSha256=copied;
  o.cases[i].assetSha256=copied;
 }
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/insufficient_receipt_diversity/);
});
test("live benchmark cannot manufacture 30 conversations by repeating one prompt",()=>{
 const {t,o}=syntheticLiveContract();
 const copied=t.cases[50].input.text;
 const matchingHash=createHash("sha256").update(copied).digest("hex");
 for(let i=51;i<80;i++){
  t.cases[i].input.text=copied;
  o.cases[i].sourceSha256=matchingHash;
 }
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/insufficient_conversation_diversity/);
});
test("live scorer refuses to count a single provider request as multiple case executions",()=>{
 const {t,o}=syntheticLiveContract();
 o.cases[1].modelRequestId=o.cases[0].modelRequestId;
 assert.throws(()=>scoreAcceptance(t,o,{mode:"live"}),/reused_provider_request/);
});
