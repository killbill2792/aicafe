import test from "node:test";
import assert from "node:assert/strict";
import {row,schemaCases,makeInventory,buildCensusReport,inventoryDelta,requireComplete,verifyBootstrapSnapshot,verifyInheritedScenarios,scenarioCoveragePlan,verifyReviewedSourceChanges,planPaidBatches} from "./supervisor-coverage.mjs";
const head="a".repeat(40);
const tool=row("tool","manage_routine",{type:"object"});
const metric=row("metric","profit",{unit:"cents"});
const manifests={ids:["example"],index:new Map([["manage_routine",["example"]]])};
test("deterministic metric and registered scenario do not imply end-to-end proof",()=>{
 const report=buildCensusReport([tool,metric],manifests,{head,deterministicMetrics:["profit"]});
 assert.equal(report.totals.UNTESTED,2);
 assert.equal(report.rows.find(r=>r.id===metric.id).deterministicMetricOracle,"PASS");
 assert.deepEqual(report.rows.find(r=>r.id===tool.id).candidateScenarios,["example"]);
 assert.equal(report.providerModelProof,false);
 assert.throws(()=>requireComplete({...report,complete:true,providerModelProof:true}),/not_proven/);
});
test("missing, new, removed, changed or duplicate identities cannot disappear",()=>{
 assert.throws(()=>makeInventory([]),/empty/);
 assert.throws(()=>makeInventory([tool,tool]),/duplicate/);
 const added=row("effect","supplier.send",{revision:1});
 assert.deepEqual(inventoryDelta([tool,metric],[row("tool","manage_routine",{new:true}),added]),
 {added:[added.id],removed:[metric.id],changed:[tool.id]});
});
test("enumerates nested input choices with independent operation IDs",()=>{
 const rows=schemaCases("tool-input","routine",{properties:{action:{enum:["create","pause","revoke"]},nested:{properties:{enabled:{const:true}}}}});
 assert.ok(rows.some(r=>r.key==='routine:$.action="revoke"'));
 assert.ok(rows.some(r=>r.key==="routine:$.nested.enabled=true"));
 assert.equal(makeInventory(rows).length,7);
});
test("unknown manifest tools are reported rather than counted as coverage",()=>{
 const r=buildCensusReport([tool],{ids:["bad"],index:new Map([["unknown",["bad"]]])},{head});
 assert.deepEqual(r.unknownManifestTools,["unknown"]);
 assert.throws(()=>requireComplete(r));
 assert.throws(()=>buildCensusReport([tool],manifests,{head:"wrong"}),/invalid_head/);
});

test("frozen bootstrap snapshot rejects new or changed coverage debt",()=>{
 const report=buildCensusReport([tool,metric],manifests,{head});
 const mapping={schemaVersion:1,baselineInventoryDigest:report.inventoryDigest,baselineRows:2};
 assert.doesNotThrow(()=>verifyBootstrapSnapshot(report,mapping));
 for(const rows of [[tool,metric,row("tool","new_tool",{})],[row("tool","manage_routine",{changed:true}),metric],[tool]]){
  const changed=buildCensusReport(rows,manifests,{head});
  assert.throws(()=>verifyBootstrapSnapshot(changed,mapping),/coverage_drift/);
 }
});
test("forged all-green candidate result never clears trusted acceptance",()=>{
 const report=buildCensusReport([tool],manifests,{head});
 assert.throws(()=>requireComplete({...report,complete:true,providerModelProof:true,rows:report.rows.map(r=>({...r,status:"PASS"}))}),/trusted_receipt_reconciliation_pending/);
});

test("the reviewed addition must be present with its exact contract, not merely an allowed name",()=>{
 const original=buildCensusReport([tool,metric],manifests,{head});
 const memory=row("tool","remember_cafe_fact",{scope:"owner"});
 const mapping={schemaVersion:1,baselineRows:2,baselineInventoryDigest:original.inventoryDigest,reviewedAdditions:[memory]};
 assert.doesNotThrow(()=>verifyBootstrapSnapshot(buildCensusReport([tool,metric,memory],manifests,{head}),mapping));
 assert.throws(()=>verifyBootstrapSnapshot(original,mapping),/coverage_drift/);
 assert.throws(()=>verifyBootstrapSnapshot(buildCensusReport([tool,metric,row("tool",memory.key,{scope:"any"})],manifests,{head}),mapping),/coverage_drift/);
});

test("a registered schema omitted from the actual model list is retained as a failure, not untested or unsupported",()=>{
 const report=buildCensusReport([tool,metric],manifests,{head,registrationGaps:[tool.key]});
 assert.deepEqual(report.registrationGaps,[tool.key]);
 assert.equal(report.rows.find(r=>r.id===tool.id).status,"FAIL");
 assert.deepEqual(report.totals,{PASS:0,FAIL:1,UNTESTED:1,UNSUPPORTED:0});
 assert.throws(()=>requireComplete(report),/not_proven/);
});

test("prior feature scenario and oracle blobs cannot silently disappear or change",()=>{
 const baseline={"13c.json":"a".repeat(40),"13c.live.test.ts":"b".repeat(40)};
 assert.doesNotThrow(()=>verifyInheritedScenarios(baseline,{...baseline,"17b.json":"c".repeat(40)}));
 assert.throws(()=>verifyInheritedScenarios(baseline,{"13c.json":baseline["13c.json"]}),/inherited_scenario_missing_or_changed/);
 assert.throws(()=>verifyInheritedScenarios(baseline,{...baseline,"13c.json":"d".repeat(40)}),/inherited_scenario_missing_or_changed/);
});
test("all earlier scenarios and joined cases must remain separately visible, never counted as provider proof",()=>{
 const groups={"14":["14b","14d"],"17b":["17b-supply"],"17c":["17c"]};
 const families=[{id:"supply",modules:["stock","finance"],candidates:["14b","14d","17b-supply","17c"],missing:"joined effect"}];
 const partial=scenarioCoveragePlan(["14b","14d","17b-supply"],groups,families);
 assert.equal(partial.allRegistered,false);
 assert.deepEqual(partial.groups[2].missing,["17c"]);
 const combined=scenarioCoveragePlan(["14b","14d","17b-supply","17c"],groups,families);
 assert.equal(combined.allRegistered,true);
 assert.equal(combined.complete,false);
 assert.equal(combined.crossFunctional[0].status,"UNTESTED");
 assert.equal(scenarioCoveragePlan(["14b","14d","17b-supply","17c","new"],groups,families).allRegistered,false);
 assert.throws(()=>scenarioCoveragePlan(["14b"],groups,[{...families[0],candidates:["nonexistent"]}]),/invalid_cross_functional/);
});

test("reviewed source change boundary rejects unknown runtime paths",()=>{
 assert.doesNotThrow(()=>verifyReviewedSourceChanges(["lib/ai/agent/tools/index.ts"],["lib/ai/agent/tools/index.ts"]));
 assert.throws(()=>verifyReviewedSourceChanges(["lib/unknown.ts"],[]),/unreviewed_supervisor_source_change/);
});
test("all actual manifests assigned once to <=20-case grants, never paid by generating plan",()=>{
 const specs=Array.from({length:34},(_,i)=>({id:"case-"+i,entrypoint:"case.mjs"}));
 const plan=planPaidBatches(specs);
 assert.deepEqual(plan.batches.map(b=>b.ids.length),[20,14]);
 assert.equal(plan.reservedCents,612);
 assert.equal(plan.authorizationRequired,true);
 assert.equal(plan.ready,false);
 assert.throws(()=>planPaidBatches([...specs,specs[0]]),/invalid_paid_inventory/);
});

test("phase plan is an exact disjoint partition, rejects forged selections and reports missing child IDs",()=>{
 const specs=[{id:"a",entrypoint:"a.mjs"},{id:"b",entrypoint:"b.mjs"},{id:"c",entrypoint:"c.mjs"}];
 const phases=[{id:"business",ids:["b","a"]},{id:"autonomy",ids:["c","d"]}];
 const result=planPaidBatches(specs,phases);
 assert.deepEqual(result.batches.map(b=>[b.phase,b.selection,b.maxReservedCents]),[["business","a,b",36],["autonomy","c",18]]);
 assert.deepEqual(result.missing,["d"]);
 assert.equal(result.maxProviderCalls,54);
 assert.equal(result.ready,false);
 for(const bad of [[{id:"one",ids:["a","b","c","a"]}],[{id:"one",ids:["a","b"]}],[{id:"one",ids:["a","b","c","all"]}]]){
  assert.throws(()=>planPaidBatches(specs,bad),/invalid_paid_phase_partition/);
 }
 assert.throws(()=>planPaidBatches([{id:"all",entrypoint:"a.mjs"}]),/invalid_paid_inventory/);
 assert.throws(()=>planPaidBatches([{id:"group-17",entrypoint:"a.mjs"}]),/invalid_paid_inventory/);
});
