import test from "node:test";
import assert from "node:assert/strict";
import {verifyOwnerCases} from "./task17d-evidence.mjs";
const matrix={cases:[{id:"D01"}],viewports:[390,1440]};
const spec=(id,status="passed",extra={})=>({title:"@home 17D:"+id+" actual test",tests:[{
  status:"expected",expectedStatus:"passed",results:[{status}],...extra
}]});
const report=(...specs)=>({suites:[{suites:[{specs}]}]});
test("both unique executed viewports required; fixture success never means integrated/live proof",()=>{
  const p=verifyOwnerCases(report(spec("D01-390"),spec("D01-1440")),matrix);
  assert.equal(p.status,"passed");assert.equal(p.integrated_proven,false);assert.equal(p.live_model_proof,false);
});
test("missing, duplicate, unknown, skipped, expected-failure and retry cannot satisfy exact case evidence",()=>{
  for(const bad of [
    report(spec("D01-390")),
    report(spec("D01-390"),spec("D01-1440","skipped")),
    report(spec("D01-390"),spec("D01-1440"),spec("D01-390")),
    report(spec("D01-390"),spec("D01-1440"),spec("D02-390")),
    report(spec("D01-390"),spec("D01-1440","failed",{expectedStatus:"failed"})),
    report(spec("D01-390"),spec("D01-1440","passed",{results:[{status:"failed"},{status:"passed"}]})),
  ])assert.equal(verifyOwnerCases(bad,matrix).status,"failed");
});

test("domain-specific selection must enforce its own 17D cases without claiming overall proof",()=>{
  const contract={viewports:[390,1440],cases:[{id:"D01",tag:"home"},{id:"D09",tag:"money"}]};
  assert.equal(verifyOwnerCases(report(spec("D09-390"),spec("D09-1440")),contract,["money"]).status,"passed");
  assert.equal(verifyOwnerCases(report(spec("D01-390"),spec("D01-1440")),contract,["money"]).status,"failed");
  assert.equal(verifyOwnerCases(report(),contract,["staff"]).status,"not_selected");
});
