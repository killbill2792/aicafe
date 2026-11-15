/** Task 13B independently reviewed operational comparison — NO MODEL CALLS.
 * The runner fails closed without genuine signed/exported observations from
 * all three independently accessed services. It never fabricates competitor
 * capability, provider delivery, or labels from the system's own output.
 * Usage: node evals/acceptance/task13b-operator-parity.mjs
 *    /private/reviewer-approved-manifest.json /private/three-agent-observations.json
 */
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

const systems=["aicafe","grokbot","muse"];
const requiredScenarios=[
 "unprompted_roster_gap","owner_approval_boundary","persistent_resume",
 "staff_opt_out","meta_acceptance_not_delivery","signed_delivery_reconcile",
 "rate_limit_and_uncertain","mandate_scope_and_revocation",
 "changed_roster_correction","proactive_exception_followup",
];
const sha=x=>createHash("sha256").update(x).digest("hex");
const error=message=>{throw Error("parity_evidence_invalid:"+message);};
const validTime=x=>typeof x==="string"&&Number.isFinite(Date.parse(x));
const validSha=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const list=x=>Array.isArray(x)?x:error("array_required");
const unique=x=>new Set(x).size===x.length;
export function validateAndScore(manifest,observations){
 if(manifest?.schemaVersion!==1||observations?.schemaVersion!==1||
   typeof manifest.suiteId!=="string"||manifest.suiteId.length<8||
   manifest.suiteId!==observations.suiteId)error("suite_mismatch");
 const reviewer=manifest.reviewer;
 if(!reviewer||typeof reviewer.independentReviewerId!=="string"||
   !validTime(reviewer.labelsApprovedAt)||
   reviewer.independentReviewerId===manifest.operatorId)
   error("independent_prelabels_required");
 const cases=list(manifest.cases),records=list(observations.sessions);
 if(cases.length!==requiredScenarios.length||
   !unique(cases.map(c=>c.scenario))||
   !requiredScenarios.every(s=>cases.some(c=>c.scenario===s))||
   !unique(cases.map(c=>c.id)))error("incomplete_scenario_suite");
 if(records.length!==cases.length*systems.length||
   !unique(records.map(c=>c.caseId+":"+c.system)))error("three_competitor_sessions_required");
 let results=[];
 for(const task of cases){
  if(typeof task.id!=="string"||task.id.length<4||!validSha(task.sourceSha256)||
    typeof task.prompt!=="string"||task.prompt.length<30||
    !Array.isArray(task.requirements)||task.requirements.length<2||
    !unique(task.requirements)||task.requirements.some(x=>typeof x!=="string"))
    error("missing_independent_ground_truth:"+String(task.id));
  const sessions=[];
  for(const system of systems){
   const run=records.find(x=>x.caseId===task.id&&x.system===system);
   if(!run||typeof run.sessionUrl!=="string"||
      !/^https:\/\//.test(run.sessionUrl)||!validTime(run.startedAt)||
      !validTime(run.finishedAt)||Date.parse(run.finishedAt)<Date.parse(run.startedAt)||
      Date.parse(run.startedAt)<=Date.parse(reviewer.labelsApprovedAt)||
      typeof run.permissionProfileId!=="string"||!run.permissionProfileId||
      run.permissionProfileId!==task.permissionProfileId)
     error("not_comparable_or_missing_independent_session:"+task.id+":"+system);
   if(typeof run.gradedBy!=="string"||
      run.gradedBy!==reviewer.independentReviewerId||
      !validTime(run.reviewedAt)||
      Date.parse(run.reviewedAt)<Date.parse(run.finishedAt))
     error("unreviewed_run:"+task.id+":"+system);
   const proofs=list(run.requirementEvidence);
   if(proofs.length!==task.requirements.length||
      !unique(proofs.map(p=>p.requirement))||
      !task.requirements.every(req=>proofs.some(p=>p.requirement===req)))
     error("unscored_requirement:"+task.id+":"+system);
   let passed=0,unproven=0;
   for(const proof of proofs){
    if(!["verified","failed","not_supported","unproven"].includes(proof.state))
      error("invalid_result_state");
    if(proof.state==="unproven"){unproven++;continue;}
    // Independently observed failures and unsupported competitor operations
    // need external proof too. Unsupported cannot be self-declared to
    // manufacture a lower competitor score or a false parity win.
    if(typeof proof.externalReceiptRef!=="string"||proof.externalReceiptRef.length<8||
       !validSha(proof.evidenceSha256)||!validTime(proof.verifiedAt)||
       Date.parse(proof.verifiedAt)<Date.parse(run.startedAt)||
       typeof proof.evidenceKind!=="string"||
       !["provider_receipt","signed_webhook","database_observer",
         "independent_operator_log"].includes(proof.evidenceKind))
       error("unverifiable_accepted_or_delivered_claim:"+task.id+":"+system);
    if(proof.state==="verified")passed++;
   }
   sessions.push({system,passed,unproven,total:task.requirements.length,
    allVerified:passed===task.requirements.length});
  }
  results.push({scenario:task.scenario,sessions});
 }
 const scores=systems.map(system=>{
  const score=results.flatMap(r=>r.sessions.filter(s=>s.system===system));
  return {system,verifiedRequirements:score.reduce((n,s)=>n+s.passed,0),
   totalRequirements:score.reduce((n,s)=>n+s.total,0),
   unprovenRequirements:score.reduce((n,s)=>n+s.unproven,0),
   fullScenarios:score.filter(s=>s.allVerified).length};
 });
 const a=scores[0],peers=scores.slice(1);
 const parityProven=a.fullScenarios===requiredScenarios.length&&
   peers.every(p=>p.unprovenRequirements===0&&
     a.verifiedRequirements>=p.verifiedRequirements);
 return {suiteId:manifest.suiteId,independentReviewerId:reviewer.independentReviewerId,
  results,scores,parityProven,limit:"Recorded externally reviewed operations; real provider receipts must be attached, never inferred"};
}
export function runCli(args,stdout=console.log){
 if(args.length!==2)error("private_manifest_and_capture_paths_required");
 const [manifest,captures]=args.map(path=>JSON.parse(readFileSync(path,"utf8")));
 const result=validateAndScore(manifest,captures);
 stdout(JSON.stringify(result,null,2));
 if(!result.parityProven)process.exitCode=1;
 return result;
}
if(process.argv[1]?.endsWith("/task13b-operator-parity.mjs"))
 runCli(process.argv.slice(2));
