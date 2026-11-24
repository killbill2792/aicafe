import test from "node:test";
import assert from "node:assert/strict";
import {matchedCount,assertU3ObservedEvidence,resolveU3ProofPaths,observedProviderCalls,completedSqlReceiptCount,matchedLocalTime,assertU3HistoryEvidence} from "./u3-canonical-research.mjs";

test("U3 independent count check rejects substring, wrong count and absent source",()=>{
 assert.equal(matchedCount("17 orders and 61 order lines",17),true);
 assert.equal(matchedCount("117 orders",17),false);
 assert.equal(matchedCount("unknown",0),false);
 assert.equal(matchedCount("1,017 orders",1017),true);
});
test("U3 live oracle requires observed Luna, registered research and no effects",()=>{
 const ok={model:"gpt-6-luna",tools:["describe_data","query_data"],
  text:"17 orders, 61 order lines, recorded sales 1,234.56",orders:17,lines:61,cents:123456,proposals:0,sqlReceipts:1};
 assert.doesNotThrow(()=>assertU3ObservedEvidence(ok));
 assert.throws(()=>assertU3ObservedEvidence({...ok,tools:["get_sales"]}),/registered_research_tool_not_used/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,model:"mock"}),/unexpected_runtime_model/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,cents:12345}),/independent_source_result_mismatch/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,proposals:1}),/unapproved_effect_created/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,sqlReceipts:0}),/committed_sql_research_not_observed/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,sqlReceipts:undefined}),/committed_sql_research_not_observed/);
});

test("U3 proof rejects non-runner and repository paths and requires observed provider calls",()=>{
 const env={AICAFE_SHARED_LUNA_CANDIDATE:"1",AICAFE_SHARED_LUNA_PROOF_DIR:"/proof"};
 assert.throws(()=>resolveU3ProofPaths(["--output","/candidate/proof.json","--scope-output","/proof/u3-canonical-research-scope.json"],env),/fresh_local_evidence_path_required/);
 assert.throws(()=>resolveU3ProofPaths(["--output","/proof/u3-canonical-research-proof.json","--scope-output","/proof/u3-canonical-research-scope.json"],{}),/private_output_and_scope_required/);
 assert.equal(observedProviderCalls({model_call_count:3}),3);
 for(const n of [undefined,0,-1,1.5])assert.throws(()=>observedProviderCalls({model_call_count:n}),/missing_provider_call_count/);
});

test("SQL evidence requires a committed complete-page server receipt, not a tool invocation",()=>{
 const receipt="u3_sql_research_receipt {\n  receipt_id: 'a1234567-1234-4123-8123-123456789abc',\n  duration_ms: 37,\n  relation_count: 2,\n  page_complete: true\n}";
 assert.equal(completedSqlReceiptCount("event: tool query_data\n"+receipt+"\n"+receipt),1);
 assert.equal(completedSqlReceiptCount(receipt.replace("true","false")),0);
 assert.equal(completedSqlReceiptCount(receipt.replace("relation_count: 2","relation_count: 0")),0);
 assert.equal(completedSqlReceiptCount("model said "+receipt),0);
 assert.equal(completedSqlReceiptCount("u3_sql_research_failure { code: 'query_timeout' }"),0);
 assert.equal(completedSqlReceiptCount(receipt+"\n"+receipt.replace("a1234567","b1234567")),2);
});

test("historical oracle requires exact local punches, night revenue, ranking and missing evidence",()=>{
 const oracle={total:180,night:{n:120,cents:"123456"},top:{name:"Night Orchard Tea",units:360},employeeName:"Harbor Sample",
  punches:[{clock_in:"22:15",clock_out:"02:45",break_start:"23:17",break_end:"23:47"},{clock_in:"21:10",clock_out:null}]};
 const ok={model:"gpt-6-luna",tools:["query_data"],oracle,proposals:0,sqlReceipts:1,
  text:"180 total orders, 120 night orders, net 1,234.56, Night Orchard Tea 360 units. Harbor Sample: 10:15 PM to 2:45 AM, break 11:17 PM to 11:47 PM. Next clock-in 21:10, clock-out missing."};
 assert.doesNotThrow(()=>assertU3HistoryEvidence(ok));
 for(const [a,b] of [["360","361"],["1,234.56","1,234.57"],["11:17 PM","11:18 PM"],["missing","complete"],["Night Orchard Tea","Foreign Orchard Tea"]])
  assert.throws(()=>assertU3HistoryEvidence({...ok,text:ok.text.replace(a,b)}),/historical_independent_source_result_mismatch/);
 assert.throws(()=>assertU3HistoryEvidence({...ok,sqlReceipts:0}),/historical_committed_research_missing/);
 assert.equal(matchedLocalTime("122:15","22:15"),false);
 assert.equal(matchedLocalTime("2:45 AM","02:45"),true);
 assert.equal(matchedLocalTime("2:45 PM","02:45"),false);
});
