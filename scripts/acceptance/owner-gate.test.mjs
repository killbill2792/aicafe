import test from "node:test";
import assert from "node:assert/strict";
import {domainsForPaths,classifyBaselinePaths,selectedFiles,selection,validateReport,validateTap,
 validateProof,DOMAINS} from "./owner-gate.mjs";
import {parseNameStatus} from "../e2e/targeted.mjs";
const head="a".repeat(40),base="b".repeat(40);
const good=files=>({testResults:files.map(name=>({name:"/repo/"+name,
 status:"passed",assertionResults:[{title:"actual contract",status:"passed"}]})),
 numTotalTests:files.length,numPassedTests:files.length,
 numFailedTests:0,numPendingTests:0,numTodoTests:0});
const claim=domains=>({schema_version:1,head_sha:head,base_sha:base,run_id:12345,status:"passed",
 domains,files:selectedFiles(domains),executed_tests:4,provider_model_proof:false});
test("known open feature PRs select every relevant, registered owner domain",()=>{
 const plans=[
  [["lib/ai/agent/tools/supplies.ts","lib/data/inventoryEvidence.server.ts"],["supervisor","inventory"]],
  [["lib/ai/conversations/receiptDuplicate.ts","lib/ai/agent/tools/purchases.ts"],["supervisor","inventory"]],
  [["lib/ai/agent/tools/gmail.ts","lib/connectors/gmail/oauth.server.ts"],["supervisor","gmail"]],
  [["lib/ai/agent/loop.server.ts","lib/scheduling/planInput.server.ts"],["supervisor","staffing"]],
  [["lib/ai/supervisor/routines/dispatch.server.ts","lib/ai/agent/memory.server.ts"],["supervisor","routines","memory"]],
  [["lib/ai/agent/tools/dataQuery.ts","lib/data/canonical/dictionary.ts"],["supervisor","pos"]]
 ];
 for(const [paths,expected] of plans)
  assert.deepEqual(domainsForPaths(paths),DOMAINS.filter(d=>expected.includes(d)));
});
test("owner-impacting infrastructure and migrations cannot silently escape the gate",()=>{
 assert.deepEqual(domainsForPaths(["app/api/ai/threads/route.ts"]),["supervisor"]);
 assert.deepEqual(domainsForPaths(["supabase/migrations/20261113022500_supervisor_owner_message_inventory_effect.sql"]),
  ["supervisor","inventory"]);
 assert.deepEqual(domainsForPaths(["lib/data/futureEconomics.server.ts"]),["supervisor"]);
 assert.deepEqual(domainsForPaths([".github/workflows/ai-cafe-pr-baseline.yml"]),["supervisor","acceptance"]);
 assert.deepEqual(domainsForPaths(["docs/README.md","README.md"]),[]);
 assert.throws(()=>domainsForPaths(["lib/connectors/newProvider/oauth.ts"]),/unknown_connector_contract/);
 assert.throws(()=>domainsForPaths(["app/api/connectors/unknown/callback/route.ts"]),/unknown_connector_contract/);
});
test("rename carries both old and new domain; duplicate test files execute once",()=>{
 const paths=parseNameStatus("R100\0lib/connectors/gmail/provider.server.ts\0lib/ai/agent/tools/gmail.ts\0M\0docs/README.md\0");
 assert.deepEqual(domainsForPaths(paths),["supervisor","gmail"]);
 const files=selectedFiles(["supervisor","pos"]);
 assert.equal(new Set(files).size,files.length);
 assert.equal(files.filter(f=>f.endsWith("dataQuery.registered.test.ts")).length,1);
 assert.throws(()=>selectedFiles(["supervisor","supervisor"]),/invalid_domains/);
 assert.throws(()=>selectedFiles(["unknown"]),/invalid_domains/);
});
test("PR and explicit full workflow use actual head and distinct selected suites",()=>{
 const pr=selection({eventName:"pull_request",base,head,
  paths:["lib/ai/agent/tools/purchases.ts"]});
 assert.deepEqual(pr.domains,["supervisor","inventory"]);
 assert.equal(pr.files.includes("lib/ai/agent/tools/purchases.test.ts"),true);
 const full=selection({eventName:"workflow_dispatch",head});
 assert.deepEqual(full.domains,DOMAINS);
 assert.equal(full.files.includes("lib/connectors/gmail/oauth.test.ts"),true);
 assert.throws(()=>selection({eventName:"pull_request",base,head:"bad",paths:[]}),
  /missing_exact_head/);
 assert.throws(()=>selection({eventName:"push",base,head,paths:[]}),/unsupported_event/);
});
test("JSON Vitest evidence requires every registered file with genuine passed assertions",()=>{
 const files=selectedFiles(["inventory"]);
 const ok=good(files);
 assert.deepEqual(validateReport(ok,files),{passed:files.length,files:files.length});
 for(const bad of [
  {...ok,numPassedTests:0}, {...ok,numFailedTests:1},
  {...ok,numPendingTests:1},{...ok,numTodoTests:1},
  {...ok,testResults:[]},
  {...ok,testResults:[{...ok.testResults[0],assertionResults:[]},ok.testResults[1]]},
  {...ok,testResults:[{...ok.testResults[0],assertionResults:[{status:"skipped"}]},ok.testResults[1]]}
 ])assert.throws(()=>validateReport(bad,files),/owner_acceptance:/);
});
test("Node TAP cannot hide failed, skipped, cancelled, zero or unexecuted tests",()=>{
 const tap="# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
 assert.equal(validateTap(tap),3);
 for(const bad of [
  tap.replace("# pass 3","# pass 2"),
  tap.replace("# fail 0","# fail 1"),
  tap.replace("# skipped 0","# skipped 1"),
  tap.replace("# tests 3","# tests 0"),
  "# tests 1\n# pass 1\n",
 ])assert.throws(()=>validateTap(bad),/node_tests_missing_failed_or_skipped/);
});
test("exact-head domain proof fails on wrong SHA, missing tests or fake Luna identity",()=>{
 const domains=["supervisor","inventory"],ok=claim(domains);
 assert.equal(validateProof(ok,{head,base,runId:12345,domains}).status,"passed");
 for(const bad of [
  {...ok,head_sha:base},{...ok,base_sha:head},{...ok,run_id:23456},
  {...ok,files:ok.files.slice(1)},
  {...ok,domains:["supervisor"]},{...ok,status:"skipped"},
  {...ok,provider_model_proof:true},{...ok,executed_tests:0},
 ])assert.throws(()=>validateProof(bad,{head,base,runId:12345,domains}),/owner_acceptance:/);
 assert.throws(()=>validateProof(ok,{head:"not-sha",base,runId:12345,domains}),/invalid_or_wrong_head_proof/);
});

test("Git-local CI classification retains the original docs, code, E2E and Supervisor gates",()=>{
 assert.deepEqual(classifyBaselinePaths(["docs/README.md"]),{
  code:false,e2e:false,supervisor:false,"docs-only":true,"non-docs":false
 });
 assert.deepEqual(classifyBaselinePaths(["lib/ai/agent/loop.server.ts","tests/e2e/owner-journeys.spec.mjs"]),{
  code:true,e2e:true,supervisor:true,"docs-only":false,"non-docs":true
 });
 assert.deepEqual(classifyBaselinePaths([".github/workflows/ai-cafe-pr-baseline.yml"]),{
  code:true,e2e:false,supervisor:false,"docs-only":false,"non-docs":true
 });
 assert.deepEqual(classifyBaselinePaths(["docs/README.md","scripts/dev-dispatcher/ci.mjs"]),{
  code:true,e2e:false,supervisor:false,"docs-only":true,"non-docs":true
 });
 assert.deepEqual(classifyBaselinePaths([".github/workflows/a-visual.yml"]),{
  code:true,e2e:true,supervisor:false,"docs-only":false,"non-docs":true
 });
 assert.throws(()=>classifyBaselinePaths([]),/empty_pull_request_diff/);
});
test("shared connector boundary runs Gmail security tests; new unknown provider remains blocked",()=>{
 const domains=domainsForPaths(["lib/connectors/registry.server.ts","lib/connectors/crypto.server.ts",
  "lib/connectors/registry.test.ts"]);
 assert.deepEqual(domains,["gmail"]);
 assert.throws(()=>domainsForPaths(["lib/connectors/newProvider/token.server.ts"]),
  /unknown_connector_contract/);
});
