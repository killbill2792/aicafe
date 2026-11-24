import {test} from "node:test";
import assert from "node:assert/strict";
import {evaluateReplay,extractIncidentFixture,adaptHistoricalFixture} from "./u1-incident-replay.mjs";
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

test("historical fixture adapter preserves assertions and only changes the reviewed profit interface",()=>{
 const input=[
  'import type { AgentToolContext } from "./tools";',
  '  tools: {',
  "call(\"get_sales\",'{\"period\":\"today\",\"ownerInputs\":null}',\"fixture-0\")",
  "call(\"get_sales\",JSON.stringify({period,ownerInputs:null}),\"fixture-0\")",
  "call(\"get_sales\",JSON.stringify({period,ownerInputs:null}),\"fixture-1\")",
  "call(\"get_sales\",JSON.stringify({period,ownerInputs:null}),\"fixture-2\")",
  "call(\"get_peak_hours\",JSON.stringify(period),\"fixture-0\")",
  "call(\"get_peak_hours\",JSON.stringify(period),\"fixture-1\")",
  'call("get_profit",JSON.stringify({period,ownerInputs:null}),"a")',
  'call("get_profit",JSON.stringify({period,ownerInputs:null}),"b")',
  '{source:"get_profit",error:"internal"}',
  '{source:"get_profit",period,missing:["deadline_exceeded"]}',
  'expect(result.usage.latencyMs).toBe(59684);'
 ].join("\n");
 const output=adaptHistoricalFixture(input);
 assert.equal(output.split('call("query_data"').length-1,8);
 assert.ok(output.includes('expect(result.usage.latencyMs).toBe(59684);'));
 assert.ok(output.includes('canonicalData:async'));
 assert.ok(output.includes('{source:"query_data",period,missing:["deadline_exceeded"]}'));
 assert.throws(()=>adaptHistoricalFixture(input.replace('call("get_profit"','call("get_sales"')),/adapter input drift/);
});
