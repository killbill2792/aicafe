import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {validateAndScore} from "./task13b-operator-parity.mjs";
const digest=x=>createHash("sha256").update(x).digest("hex");
const scenarios=[
 "unprompted_roster_gap","owner_approval_boundary","persistent_resume",
 "staff_opt_out","meta_acceptance_not_delivery","signed_delivery_reconcile",
 "rate_limit_and_uncertain","mandate_scope_and_revocation",
 "changed_roster_correction","proactive_exception_followup",
];
const reviewer="independent-operator";
function fixtures(){
 const manifest={schemaVersion:1,suiteId:"reviewed-13b-suite-1",operatorId:"system-author",
  reviewer:{independentReviewerId:reviewer,labelsApprovedAt:"2026-11-14T08:00:00Z"},
  cases:scenarios.map((scenario,i)=>({id:"case-"+i,scenario,
   prompt:"Perform the exact independently reviewed scheduling task "+scenario,
   sourceSha256:digest("source-shift-facts-"+i),
   requirements:["verified_authority","verified_outcome"],
   permissionProfileId:"isolated-cafe-owner-staff-sandbox",
  }))};
 const sessions=manifest.cases.flatMap((c,i)=>["aicafe","grokbot","muse"].map(system=>({
  caseId:c.id,system,sessionUrl:"https://test.example/"+system+"/"+i,
  permissionProfileId:c.permissionProfileId,
  startedAt:"2026-11-14T08:10:00Z",finishedAt:"2026-11-14T08:12:00Z",
  gradedBy:reviewer,reviewedAt:"2026-11-14T08:20:00Z",
  requirementEvidence:c.requirements.map(requirement=>({
    requirement,state:"verified",externalReceiptRef:"synthetic-"+system+"-"+i+"-"+requirement,
    evidenceSha256:digest(system+i+requirement),verifiedAt:"2026-11-14T08:12:00Z",
    evidenceKind:"independent_operator_log",
  })),
 })));
 return {manifest,observations:{schemaVersion:1,suiteId:manifest.suiteId,sessions}};
}
const fails=(fn,why)=>assert.throws(fn,err=>err instanceof Error&&
 err.message.includes("parity_evidence_invalid:"+why));
test("synthetic evaluator control proves scoring only; NOT competitor parity proof",()=>{
 const {manifest,observations}=fixtures();
 const r=validateAndScore(manifest,observations);
 assert.equal(r.parityProven,true);
 assert.deepEqual(r.scores.map(x=>x.fullScenarios),[10,10,10]);
});
test("never treats a missing Grokbot or Muse run as independent evidence",()=>{
 const {manifest,observations}=fixtures();
 observations.sessions.pop();
 fails(()=>validateAndScore(manifest,observations),"three_competitor_sessions_required");
});
test("rejects self-review even if all claims say success",()=>{
 const {manifest,observations}=fixtures();
 manifest.operatorId=reviewer;
 fails(()=>validateAndScore(manifest,observations),"independent_prelabels_required");
});
test("rejects post-hoc labels based on the model's own outcome",()=>{
 const {manifest,observations}=fixtures();
 manifest.reviewer.labelsApprovedAt="2026-11-14T09:00:00Z";
 fails(()=>validateAndScore(manifest,observations),"not_comparable_or_missing_independent_session");
});
test("requires the same permission profile for all three systems",()=>{
 const {manifest,observations}=fixtures();
 observations.sessions[8].permissionProfileId="unconnected-competitor";
 fails(()=>validateAndScore(manifest,observations),"not_comparable_or_missing_independent_session");
});
test("provider HTTP 200 without an external receipt cannot be called delivered",()=>{
 const {manifest,observations}=fixtures();
 const receipt=observations.sessions[0].requirementEvidence[0];
 receipt.externalReceiptRef="";
 fails(()=>validateAndScore(manifest,observations),"unverifiable_accepted_or_delivered_claim");
});
test("never silently drop a failed, uncertain, or unsupported requirement",()=>{
 const {manifest,observations}=fixtures();
 observations.sessions[0].requirementEvidence.pop();
 fails(()=>validateAndScore(manifest,observations),"unscored_requirement");
 observations.sessions[0].requirementEvidence.push({
  requirement:"verified_outcome",state:"unproven"});
 const result=validateAndScore(manifest,observations);
 assert.equal(result.parityProven,false);
 assert.equal(result.scores[0].fullScenarios,9);
});
test("rejects incomplete agentic scenario coverage instead of cherry-picking",()=>{
 const {manifest,observations}=fixtures();
 manifest.cases[0].scenario="generic_chat";
 fails(()=>validateAndScore(manifest,observations),"incomplete_scenario_suite");
});
test("denies duplicate system/case records instead of double-counting successes",()=>{
 const {manifest,observations}=fixtures();
 observations.sessions[1]=observations.sessions[0];
 fails(()=>validateAndScore(manifest,observations),"three_competitor_sessions_required");
});
