import test from "node:test";
import assert from "node:assert/strict";
import {row,schemaCases,makeInventory,buildCensusReport,inventoryDelta,requireComplete,verifyBootstrapSnapshot} from "./supervisor-coverage.mjs";
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
