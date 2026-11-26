import test from "node:test";
import assert from "node:assert/strict";
import {matchedCount,assertU3ObservedEvidence,resolveU3ProofPaths,observedProviderCalls} from "./u3-canonical-research.mjs";

test("U3 independent count check rejects substring, wrong count and absent source",()=>{
 assert.equal(matchedCount("17 orders and 61 order lines",17),true);
 assert.equal(matchedCount("117 orders",17),false);
 assert.equal(matchedCount("unknown",0),false);
 assert.equal(matchedCount("1,017 orders",1017),true);
});
test("U3 live oracle requires observed Luna, registered research and no effects",()=>{
 const ok={model:"gpt-6-luna",tools:["describe_database","run_sql"],
  text:"17 orders, 61 order lines, recorded sales 1,234.56",orders:17,lines:61,cents:123456,proposals:0};
 assert.doesNotThrow(()=>assertU3ObservedEvidence(ok));
 assert.throws(()=>assertU3ObservedEvidence({...ok,tools:["get_sales"]}),/registered_research_tool_not_used/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,model:"mock"}),/unexpected_runtime_model/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,cents:12345}),/independent_source_result_mismatch/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,proposals:1}),/unapproved_effect_created/);
});

test("U3 proof rejects non-runner and repository paths and requires observed provider calls",()=>{
 const env={AICAFE_SHARED_LUNA_CANDIDATE:"1",AICAFE_SHARED_LUNA_PROOF_DIR:"/proof"};
 assert.throws(()=>resolveU3ProofPaths(["--output","/candidate/proof.json","--scope-output","/proof/u3-canonical-research-scope.json"],env),/fresh_local_evidence_path_required/);
 assert.throws(()=>resolveU3ProofPaths(["--output","/proof/u3-canonical-research-proof.json","--scope-output","/proof/u3-canonical-research-scope.json"],{}),/private_output_and_scope_required/);
 assert.equal(observedProviderCalls({model_call_count:3}),3);
 for(const n of [undefined,0,-1,1.5])assert.throws(()=>observedProviderCalls({model_call_count:n}),/missing_provider_call_count/);
});
