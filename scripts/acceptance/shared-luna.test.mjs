import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {validateScenario,readScenario} from "./shared-luna.mjs";
const good={
  id:"future-case",mode:"generic",engine:"vitest",
  entrypoint:"lib/ai/supervisor/routines/futureCase.live.test.ts",
  proof:"future-case-proof.json",scope:"future-case-scope.json",
  expectedTools:["get_investigation_source","get_schedule"],
  assertions:[
    {name:"source-case",kind:"source",table:"public.operating_tasks",
      where:{business_id:{scope:"businessId"}},minCount:1,maxCount:1},
    {name:"owner-update",kind:"owner",table:"public.ai_messages",
      where:{business_id:{scope:"businessId"},role:{eq:"supervisor"}},minCount:1,maxCount:10},
    {name:"second-cafe-denied",kind:"isolation",table:"public.ai_messages",
      where:{business_id:{scope:"otherCafeId"}},minCount:0,maxCount:0}
  ]
};
const copy=x=>structuredClone(x);
test("existing 13C and 14B case manifests retain exact immutable legacy entrypoints",()=>{
  const root=join(import.meta.dirname,"../..");
  for(const id of ["13c","14b"]){
    const m=readScenario(root,id);
    assert.equal(m.mode,"legacy");
    assert.ok(m.proof.endsWith(".json"));
  }
});
test("generic feature case can be added in the feature PR without changing the shared runner",()=>{
  assert.equal(validateScenario(good,"future-case").id,"future-case");
  const dir=mkdtempSync(join(tmpdir(),"luna-manifest-"));
  try{
    mkdirSync(join(dir,".github/luna/scenarios"),{recursive:true});
    writeFileSync(join(dir,".github/luna/scenarios/future-case.json"),JSON.stringify(good));
    assert.equal(readScenario(dir,"future-case").id,"future-case");
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test("candidate cannot change trusted 13C entrypoint or host oracle",()=>{
  const m={id:"13c",mode:"legacy",engine:"vitest",
    entrypoint:"lib/ai/supervisor/routines/fake.live.test.ts",
    proof:"13c-live-proof.json",scope:"13c-live-scope.json"};
  assert.throws(()=>validateScenario(m,"13c"),/Legacy oracle/);
});
test("a generic scenario without actual tool selection and source/owner/isolation proof fails closed",()=>{
  for(const mutate of [
    m=>{m.expectedTools=["get_schedule"]},
    m=>{m.assertions=m.assertions.slice(0,2)},
    m=>{m.assertions[2].kind="source"},
    m=>{m.assertions[2].maxCount=1},
    m=>{m.assertions[1].table="pg_catalog.pg_roles"},
    m=>{m.assertions[0].where={}},
    m=>{m.entrypoint="../escape.live.test.ts"},
    m=>{m.assertions[0].where={business_id:{eq:"x';DROP TABLE"}}}
  ]){
    const m=copy(good);mutate(m);
    assert.throws(()=>validateScenario(m,"future-case"));
  }
});
test("run replay is denied before reaching GitHub or paid model secrets",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-auth-"));
  try{
    const event=join(dir,"event.json");
    writeFileSync(event,JSON.stringify({
      repository:{full_name:"killbill2792/aicafe"},sender:{login:"killbill2792"},
      inputs:{head_sha:"a".repeat(40),pr_number:"0",scenario:"all"}
    }));
    const result=spawnSync(process.execPath,[join(import.meta.dirname,"shared-luna.mjs"),"plan"],{
      encoding:"utf8",env:{...process.env,
        GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:"workflow_dispatch",
        GITHUB_ACTOR:"killbill2792",GITHUB_TRIGGERING_ACTOR:"killbill2792",
        GITHUB_RUN_ATTEMPT:"2",GITHUB_REF:"refs/heads/main",GH_TOKEN:"not-a-real-token"}});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Explicit owner launch on trusted main required/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
