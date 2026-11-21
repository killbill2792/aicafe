import {test} from "node:test";
import assert from "node:assert/strict";
import {evaluateReplay,extractIncidentFixture} from "./u1-incident-replay.mjs";
const target="does not ask for an unrequested year of sales after today's closed day is missing";
const report=(status="passed",error="",other="passed")=>({testResults:[{assertionResults:[
 {title:target,status,failureMessages:[error]},
 {title:"explicit history",status:other},{title:"source failure",status:"passed"},{title:"delayed synthesis",status:"passed"},
]}]});
test("matched replay accepts only the exact historical defect and all independent invariants",()=>{
 assert.deepEqual(evaluateReplay(report("failed","expected false to be true"),true),{tests:4,expectedYearScanFailure:true,passed:3});
 assert.deepEqual(evaluateReplay(report(),false),{tests:4,expectedYearScanFailure:false,passed:4});
 assert.throws(()=>evaluateReplay(report("failed","import or module failed"),true),/exact year-scan/);
 assert.throws(()=>evaluateReplay(report("passed"),true),/exact year-scan/);
 assert.throws(()=>evaluateReplay(report("failed","expected false to be true","failed"),true),/Non-target/);
 assert.throws(()=>evaluateReplay(report("failed","expected false to be true"),false),/Candidate/);
 assert.throws(()=>evaluateReplay({testResults:[]},false),/four matched/);
});
test("fixture extraction discards unrelated older tests and refuses incomplete fixtures",()=>{
 const prefix='import {it} from "vitest";\n';
 const source=prefix+'describe("recorded Responses streaming fixtures",()=>{});\n'+
  'describe("U1 incident regression: dates",()=>{it('+JSON.stringify(target)+',()=>{});});\n'+
  'describe("U1 controlled incident timing fixture",()=>{});';
 assert.ok(extractIncidentFixture(source).startsWith(prefix+'describe("U1 incident regression:'));
 assert.ok(!extractIncidentFixture(source).includes("recorded Responses streaming fixtures"));
 assert.throws(()=>extractIncidentFixture(prefix),/boundaries/);
});
