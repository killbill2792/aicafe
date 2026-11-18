import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from "node:fs";
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
test("generic owner-browser scenarios can use the same shared server runner",()=>{
  const m=copy(good);
  m.engine="node-server";
  m.entrypoint="evals/acceptance/live/task14c.mjs";
  assert.equal(validateScenario(m,"future-case").engine,"node-server");
  m.entrypoint="evals/acceptance/../../scripts/unsafe.mjs";
  assert.throws(()=>validateScenario(m,"future-case"),/Invalid generic test entrypoint/);
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

test("trusted generic host checks provider receipts and independently executes scoped SQL",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-attest-"));
  try{
    const root=join(dir,"candidate/.github/luna/scenarios");
    const proofDir=join(dir,"luna-candidate-proof"),bin=join(dir,"bin");
    mkdirSync(root,{recursive:true});mkdirSync(proofDir);mkdirSync(bin);
    writeFileSync(join(root,"future-case.json"),JSON.stringify(good));
    writeFileSync(join(dir,"luna-locked-manifest.json"),JSON.stringify(good));
    const head="a".repeat(40);
    const businessId="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const otherCafeId="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeFileSync(join(proofDir,"future-case-proof.json"),JSON.stringify({
      head_sha:head,observed_model:"gpt-6-luna",status:"passed"
    }));
    writeFileSync(join(proofDir,"future-case-scope.json"),JSON.stringify({
      businessId,otherCafeId,taskId:"case-7",expectedProviderCalls:2
    }));
    const audit={
      head,attempts:2,reservedMicros:20000,
      receipts:[
        {terminal:"completed",model:"gpt-6-luna",actualInputTokens:10,actualOutputTokens:5,
          toolNames:["get_investigation_source"]},
        {terminal:"completed",model:"gpt-6-luna",actualInputTokens:11,actualOutputTokens:3,
          toolNames:["get_schedule"]}
      ]
    };
    const auditFile=join(dir,"luna-host-audit.json");
    writeFileSync(auditFile,JSON.stringify(audit));
    const psql=join(bin,"psql");
    writeFileSync(psql,'#!/usr/bin/env node\nconst query=process.argv.join(" ");console.log(query.includes("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")?"0":"1");\n');
    chmodSync(psql,0o755);
    const execute=()=>spawnSync(process.execPath,[join(import.meta.dirname,"shared-luna.mjs"),"attest"],{
      encoding:"utf8",cwd:dir,
      env:{...process.env,PATH:bin+":"+process.env.PATH,HEAD_SHA:head,
        SCENARIO:"future-case",RUNNER_TEMP:dir,GITHUB_RUN_ATTEMPT:"1"}});
    const pass=execute();
    assert.equal(pass.status,0,pass.stderr);
    const result=JSON.parse(readFileSync(join(dir,"luna-sanitized-result.json"),"utf8"));
    assert.equal(result.realModelAndDatabaseProof,true);
    assert.equal(result.independentOwnerUIAttestation,false);
    assert.equal(result.independentDatabaseReadbacks.length,3);
    // Codex P1: malicious candidate code downgrades its writable manifest
    // after the original immutable head was snapshotted by the trusted host.
    // The attester MUST retain all three original independent readbacks.
    const tampered=copy(good);
    tampered.assertions=[
      {name:"forged-source",kind:"source",table:"public.operating_tasks",
        where:{business_id:{scope:"businessId"}},minCount:0,maxCount:100},
      {name:"forged-owner",kind:"owner",table:"public.ai_messages",
        where:{business_id:{scope:"businessId"}},minCount:0,maxCount:100},
      {name:"forged-isolation",kind:"isolation",table:"public.ai_messages",
        where:{business_id:{scope:"otherCafeId"}},minCount:0,maxCount:0}
    ];
    writeFileSync(join(root,"future-case.json"),JSON.stringify(tampered));
    rmSync(join(dir,"luna-sanitized-result.json"));
    const protectedResult=execute();
    assert.equal(protectedResult.status,0,protectedResult.stderr);
    const protectedProof=JSON.parse(readFileSync(join(dir,"luna-sanitized-result.json"),"utf8"));
    assert.deepEqual(protectedProof.independentDatabaseReadbacks.map(x=>x.name),
      ["source-case","owner-update","second-cafe-denied"]);
    audit.receipts[0].model="not-luna";
    writeFileSync(auditFile,JSON.stringify(audit));
    const fail=execute();
    assert.notEqual(fail.status,0);
    assert.match(fail.stderr,/Provider identity or bounded paid receipt unverified/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("trusted owner launch selects all exact-head manifests without any model call",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-plan-"));
  try{
    const head="a".repeat(40),eventFile=join(dir,"event.json");
    const output=join(dir,"output.txt"),preload=join(dir,"mock-github.mjs");
    writeFileSync(output,"");
    const event={repository:{full_name:"killbill2792/aicafe"},sender:{login:"killbill2792"},
      inputs:{head_sha:head,pr_number:"0",scenario:"all",max_budget_usd:"0.36"}};
    writeFileSync(eventFile,JSON.stringify(event));
    const tree={truncated:false,tree:[
      {type:"blob",mode:"100644",path:".github/luna/scenarios/14b.json"},
      {type:"blob",mode:"100644",path:".github/luna/scenarios/13c.json"},
      {type:"blob",mode:"120000",path:".github/luna/scenarios/untrusted-link.json"}
    ]};
    const prefix='const SHA='+JSON.stringify(head)+';\n';
    writeFileSync(preload,prefix+
      'globalThis.fetch=async (url)=>{const s=String(url);'+
      'const body=s.includes("/branches/main")?{commit:{sha:SHA}}:'+
      's.includes("/git/trees/")?'+JSON.stringify(tree)+':null;'+
      'return new Response(JSON.stringify(body),{status:body?200:404});};\n');
    const execute=(cmd="plan")=>spawnSync(process.execPath,["--import",preload,
      join(import.meta.dirname,"shared-luna.mjs"),cmd],{
      encoding:"utf8",env:{...process.env,GITHUB_EVENT_PATH:eventFile,
        GITHUB_OUTPUT:output,GITHUB_RUN_ID:"9876",GH_TOKEN:"fake-read-only",
        GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF:"refs/heads/main",
        GITHUB_ACTOR:"killbill2792",GITHUB_TRIGGERING_ACTOR:"killbill2792",
        GITHUB_RUN_ATTEMPT:"1"}});
    const result=execute();
    assert.equal(result.status,0,result.stderr);
    const attrs=Object.fromEntries(readFileSync(output,"utf8").trim().split("\n")
      .map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)]}));
    assert.deepEqual(JSON.parse(attrs.matrix),["13c","14b"]);
    assert.equal(attrs.head,head);
    assert.match(result.stdout,/cumulative worst-case reserved USD=0.36/);
    assert.ok(!attrs.matrix.includes("untrusted-link"));
    // The same request with the default $0.20 per-dispatch budget must
    // fail before scheduling two scenarios whose combined reservation is $0.36.
    writeFileSync(eventFile,JSON.stringify({...event,inputs:{
      ...event.inputs,max_budget_usd:"0.20"}}));
    writeFileSync(output,"");
    const overBudget=execute();
    assert.notEqual(overBudget.status,0);
    assert.match(overBudget.stderr,/exceed manual owner budget authorization/);
    assert.equal(readFileSync(output,"utf8"),"");
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("trusted freeze denies modified Git checkout instead of trusting mutable manifest",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-freeze-"));
  try{
    const root=join(dir,"candidate"),manifest=join(root,".github/luna/scenarios/future-case.json");
    mkdirSync(join(root,".github/luna/scenarios"),{recursive:true});
    mkdirSync(join(root,"lib/ai/supervisor/routines"),{recursive:true});
    writeFileSync(manifest,JSON.stringify(good)+"\n");
    writeFileSync(join(root,good.entrypoint),'import {it} from "vitest";it("real",()=>{});\n');
    const git=(...args)=>{
      const r=spawnSync("git",["-C",root,...args],{encoding:"utf8"});
      assert.equal(r.status,0,r.stderr);return r.stdout.trim();
    };
    git("init");git("config","user.email","fixture@example.invalid");
    git("config","user.name","Test Fixture");
    git("add",".");git("commit","-m","scenario");
    const head=git("rev-parse","HEAD"),out=join(dir,"luna-locked-manifest.json");
    const run=()=>spawnSync(process.execPath,[join(import.meta.dirname,"shared-luna.mjs"),"freeze"],{
      cwd:dir,encoding:"utf8",
      env:{...process.env,HEAD_SHA:head,SCENARIO:"future-case",RUNNER_TEMP:dir}
    });
    const goodResult=run();
    assert.equal(goodResult.status,0,goodResult.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out,"utf8")),good);
    writeFileSync(manifest,JSON.stringify({...good,expectedTools:["get_schedule"]}));
    const blocked=run();
    assert.notEqual(blocked.status,0);
    assert.match(blocked.stderr,/Working candidate manifest differs|Invalid|EEXIST/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("exact owner PR comment authorizes one pinned scenario and rejects edited or spoofed grants",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-comment-"));
  try{
    const head="a".repeat(40),commentId=456789,updatedAt="2026-11-18T06:00:00Z";
    const body="/aicafe-luna pr "+head+" 13c 0.20";
    const eventFile=join(dir,"event.json"),output=join(dir,"out.txt");
    const preload=join(dir,"mock-github.mjs"),stateFile=join(dir,"comment-state.json"),
      grantsFile=join(dir,"grants.json");
    const event={
      action:"created",repository:{full_name:"killbill2792/aicafe"},
      sender:{login:"killbill2792"},
      issue:{number:520,pull_request:{url:"https://api.github.com/repos/killbill2792/aicafe/pulls/520"}},
      comment:{id:commentId,body,updated_at:updatedAt,user:{login:"killbill2792"}}
    };
    const state={id:commentId,body,updated_at:updatedAt,user:{login:"killbill2792"}};
    writeFileSync(eventFile,JSON.stringify(event));
    writeFileSync(stateFile,JSON.stringify(state));
    writeFileSync(grantsFile,"[]");
    const api=String.raw`import {readFileSync,writeFileSync} from "node:fs";
const file=process.env.LUNA_TEST_COMMENT_STATE,grants=process.env.LUNA_TEST_GRANTS;
const sha="a".repeat(40);
globalThis.fetch=async (url,options={})=>{
 const s=String(url);
 if(s.includes("/issues/520/comments")&&options.method==="POST"){
   const posted=JSON.parse(options.body);
   const old=JSON.parse(readFileSync(grants,"utf8"));
   old.push({body:posted.body,user:{login:"github-actions[bot]"}});
   writeFileSync(grants,JSON.stringify(old));
   return new Response(JSON.stringify({id:67890}),{status:201});
 }
 const body=s.includes("/issues/comments/456789")?JSON.parse(readFileSync(file,"utf8")):
  s.includes("/issues/520/comments?")?JSON.parse(readFileSync(grants,"utf8")):
  s.includes("/pulls/520")?{state:"open",head:{sha,repo:{full_name:"killbill2792/aicafe"}}}:
  s.includes("/git/trees/")?{truncated:false,tree:[
    {type:"blob",mode:"100644",path:".github/luna/scenarios/13c.json"}]}:null;
 return new Response(JSON.stringify(body),{status:body?200:404});
};
`;
    writeFileSync(preload,api);
    const execute=()=>spawnSync(process.execPath,["--import",preload,
      join(import.meta.dirname,"shared-luna.mjs"),"plan"],{
      encoding:"utf8",env:{...process.env,GITHUB_EVENT_PATH:eventFile,
        GITHUB_OUTPUT:output,GITHUB_RUN_ID:"999",GH_TOKEN:"fake-read-only",
        LUNA_TEST_COMMENT_STATE:stateFile,LUNA_TEST_GRANTS:grantsFile,
        GITHUB_EVENT_NAME:"issue_comment",
        GITHUB_REF:"refs/heads/main",GITHUB_ACTOR:"killbill2792",
        GITHUB_TRIGGERING_ACTOR:"killbill2792",GITHUB_RUN_ATTEMPT:"1"}});
    writeFileSync(output,"");
    const valid=execute();
    assert.equal(valid.status,0,valid.stderr);
    assert.match(readFileSync(output,"utf8"),/matrix=\["13c"\]/);
    const consumed=JSON.parse(readFileSync(grantsFile,"utf8"));
    assert.equal(consumed.length,1);
    assert.match(consumed[0].body,/aicafe-luna-consumed:owner-comment-456789:run-999/);
    writeFileSync(output,"");
    const revalidated=execute("revalidate");
    assert.equal(revalidated.status,0,revalidated.stderr);
    assert.equal(JSON.parse(readFileSync(grantsFile,"utf8")).length,1);
    writeFileSync(output,"");
    const duplicate=execute("plan");
    assert.notEqual(duplicate.status,0);
    assert.match(duplicate.stderr,/already consumed/);
    assert.equal(readFileSync(output,"utf8"),"");
    writeFileSync(stateFile,JSON.stringify({...state,body:body+" edited"}));
    const edited=execute("revalidate");
    assert.notEqual(edited.status,0);
    assert.match(edited.stderr,/Owner comment changed/);
    assert.equal(readFileSync(output,"utf8"),"");
    writeFileSync(stateFile,JSON.stringify(state));
    writeFileSync(eventFile,JSON.stringify({...event,sender:{login:"attacker"}}));
    const spoofed=execute("revalidate");
    assert.notEqual(spoofed.status,0);
    assert.match(spoofed.stderr,/Explicit owner launch/);
    writeFileSync(eventFile,JSON.stringify(event));
    writeFileSync(grantsFile,"[]");
    const noGrant=execute("revalidate");
    assert.notEqual(noGrant.status,0);
    assert.match(noGrant.stderr,/not consumed by this one-shot run/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("trusted workflow revalidates an owner comment after untrusted setup but before key access",()=>{
  const workflow=readFileSync(join(import.meta.dirname,"../../.github/workflows/ai-cafe-luna-shared.yml"),"utf8");
  const at=workflow.indexOf("name: Reverify consumed owner grant and current SHA immediately before provider access");
  const broker=workflow.indexOf("name: Start bounded trusted broker on host");
  assert.ok(at>0&&broker>at,"Paid workflow must recheck owner/current SHA after setup and before key");
  assert.ok(workflow.slice(at,broker).includes("node scripts/acceptance/shared-luna.mjs revalidate"));
  assert.ok(workflow.includes("queue: max")&&workflow.includes("cancel-in-progress: false"));
});
