import test from "node:test";
import assert from "node:assert/strict";
import {verifyOwnerCases,assessCensus} from "./task17d-evidence.mjs";
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

test("unmapped new upstream registry/operation never becomes owner acceptance",()=>{
  const tool={id:"tool:manage_routine",kind:"tool",key:"manage_routine",fingerprint:"a".repeat(64)};
  const novel={id:"tool:new_tool",kind:"tool",key:"new_tool",fingerprint:"b".repeat(64)};
  const census={head:"c".repeat(40),rows:[tool,novel]};
  const contract={cases:[{id:"D01"}],censusCandidates:{"tool:manage_routine":["D01"]},
    autonomyCandidates:{chat_routine:["D01"],retired:["D01"]}};
  const p=assessCensus(census,["chat_routine","new_monitor"],contract);
  assert.equal(p.unmapped,1);assert.equal(p.unmappedAutonomy,1);
  assert.deepEqual(p.staleMappings,["autonomy:retired"]);
  assert.ok(p.rows.every(r=>r.status==="UNTESTED"));assert.equal(p.integrated_proven,false);
  assert.throws(()=>assessCensus({...census,rows:[tool,tool]},["chat_routine"],contract),/Invalid upstream/);
  assert.throws(()=>assessCensus(census,[],contract),/Missing upstream/);
  assert.throws(()=>assessCensus(census,["chat_routine"],{...contract,censusCandidates:{"tool:manage_routine":["D99"]}}),/Unknown browser/);
});

test("new owner screens and retired route reviews cannot disappear from the census",()=>{
 const a={id:"screen-candidate:new/page.tsx",kind:"screen-candidate",key:"new/page.tsx",fingerprint:"a".repeat(64)};
 const result=assessCensus({head:"b".repeat(40),rows:[a]},["chat_routine"],
   {cases:[{id:"D01"}],routeReview:{"old/page.tsx":{state:"navigation_case_authored",cases:["D01"]}}});
 assert.deepEqual(result.missingRouteReviews,[a.id]);
 assert.deepEqual(result.retiredRouteReviews,["old/page.tsx"]);
 assert.equal(result.screens[0].status,"UNTESTED");
 assert.equal(result.integrated_proven,false);
});

test("inherited exact title evidence and tablet-specific cases cannot disappear",()=>{
 const contract={viewports:[390,1440],cases:[{id:"D20",tag:"home",viewports:[768,1024]}],inheritedCases:[{title:"@home Task16E inherited",tag:"home"},{title:"@purchasing actual purchase",tag:"purchasing"}]};
 const legacy={title:"@home Task16E inherited",tests:[{status:"expected",expectedStatus:"passed",results:[{status:"passed"}]}]};
 const a=report(spec("D20-768"),spec("D20-1024"));
 assert.equal(verifyOwnerCases(a,contract,["home"]).status,"failed");
 assert.equal(verifyOwnerCases(report(),contract,["purchasing"]).status,"failed");
 a.suites[0].suites[0].specs.push(legacy);
 assert.equal(verifyOwnerCases(a,contract,["home"]).status,"passed");
 legacy.tests[0].results.push({status:"passed"});
 assert.equal(verifyOwnerCases(a,contract,["home"]).status,"failed");
});
