import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {validateScenario,readScenario,selectLunaScenarios} from "./shared-luna.mjs";
import {TEST_CAFES} from "../seed/cafes.mjs";
import {buildSeedSql,latestClosedDate} from "../seed/seedSql.mjs";
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

test("owner comment uses read-only immutable first-run history and rejects duplicates",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-comment-"));
  try{
    const head="a".repeat(40),main="b".repeat(40),commentId=456789,
      updatedAt="2026-11-18T06:00:00Z";
    const body="/aicafe-luna pr "+head+" 13c 0.20";
    const eventFile=join(dir,"event.json"),output=join(dir,"out.txt"),
      preload=join(dir,"mock-github.mjs"),stateFile=join(dir,"comment-state.json"),
      runsFile=join(dir,"runs.json");
    const event={
      action:"created",repository:{full_name:"killbill2792/aicafe"},
      sender:{login:"killbill2792"},
      issue:{number:520,pull_request:{url:"https://api.github.com/repos/killbill2792/aicafe/pulls/520"}},
      comment:{id:commentId,body,updated_at:updatedAt,user:{login:"killbill2792"}}
    };
    const state={id:commentId,body,updated_at:updatedAt,user:{login:"killbill2792"}};
    const goodRun={id:999,display_title:"luna-owner-comment-"+commentId,
      run_attempt:1,event:"issue_comment",head_sha:main,actor:{login:"killbill2792"}};
    writeFileSync(eventFile,JSON.stringify(event));
    writeFileSync(stateFile,JSON.stringify(state));
    writeFileSync(runsFile,JSON.stringify([goodRun]));
    const api=String.raw`import {readFileSync} from "node:fs";
const file=process.env.LUNA_TEST_COMMENT_STATE,runs=process.env.LUNA_TEST_ACTION_RUNS;
const sha="a".repeat(40);
globalThis.fetch=async (url,options={})=>{
 const s=String(url);
 if(options.method==="POST")throw Error("Owner grant verification must not write GitHub data");
 const body=s.includes("/issues/comments/456789")?JSON.parse(readFileSync(file,"utf8")):
  s.includes("/actions/workflows/ai-cafe-luna-shared.yml/runs?")?
    {workflow_runs:JSON.parse(readFileSync(runs,"utf8"))}:
  s.includes("/pulls/520")?{state:"open",head:{sha,repo:{full_name:"killbill2792/aicafe"}}}:
  s.includes("/git/trees/")?{truncated:false,tree:[
    {type:"blob",mode:"100644",path:".github/luna/scenarios/13c.json"}]}:null;
 return new Response(JSON.stringify(body),{status:body?200:404});
};
`;
    writeFileSync(preload,api);
    const execute=(cmd="plan")=>spawnSync(process.execPath,["--import",preload,
      join(import.meta.dirname,"shared-luna.mjs"),cmd],{
      encoding:"utf8",env:{...process.env,GITHUB_EVENT_PATH:eventFile,
        GITHUB_OUTPUT:output,GITHUB_RUN_ID:"999",GITHUB_SHA:main,GH_TOKEN:"fake-read-only",
        LUNA_TEST_COMMENT_STATE:stateFile,LUNA_TEST_ACTION_RUNS:runsFile,
        GITHUB_EVENT_NAME:"issue_comment",GITHUB_REF:"refs/heads/main",
        GITHUB_ACTOR:"killbill2792",GITHUB_TRIGGERING_ACTOR:"killbill2792",
        GITHUB_RUN_ATTEMPT:"1"}});
    writeFileSync(output,"");
    const valid=execute();
    assert.equal(valid.status,0,valid.stderr);
    assert.match(readFileSync(output,"utf8"),/matrix=\["13c"\]/);
    assert.equal(execute("revalidate").status,0,"Read-only verification must be repeatable for same run");
    writeFileSync(output,"");
    // A GitHub event that independently created a previous run with the same
    // owner comment cannot authorize a second model spend.
    writeFileSync(runsFile,JSON.stringify([
      {...goodRun,id:900},goodRun]));
    const duplicate=execute("revalidate");
    assert.notEqual(duplicate.status,0);
    assert.match(duplicate.stderr,/already consumed by an earlier workflow run/);
    assert.equal(readFileSync(output,"utf8"),"");
    writeFileSync(runsFile,JSON.stringify([goodRun]));
    writeFileSync(stateFile,JSON.stringify({...state,body:body+" edited"}));
    const edited=execute("revalidate");
    assert.notEqual(edited.status,0);
    assert.match(edited.stderr,/Owner comment changed/);
    writeFileSync(stateFile,JSON.stringify(state));
    writeFileSync(eventFile,JSON.stringify({...event,sender:{login:"attacker"}}));
    const spoofed=execute("revalidate");
    assert.notEqual(spoofed.status,0);
    assert.match(spoofed.stderr,/Explicit owner launch/);
    writeFileSync(eventFile,JSON.stringify(event));
    writeFileSync(runsFile,"[]");
    const missing=execute("revalidate");
    assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/Cannot independently verify this exact first-attempt owner-run history/);
    writeFileSync(runsFile,JSON.stringify([{...goodRun,head_sha:"c".repeat(40)}]));
    const wrongSha=execute("revalidate");
    assert.notEqual(wrongSha.status,0);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("trusted workflow revalidates an owner comment after untrusted setup but before key access",()=>{
  const workflow=readFileSync(join(import.meta.dirname,"../../.github/workflows/ai-cafe-luna-shared.yml"),"utf8");
  const at=workflow.indexOf("name: Reverify consumed owner grant and current SHA immediately before provider access");
  const broker=workflow.indexOf("name: Start bounded trusted broker on host");
  assert.ok(at>0&&broker>at,"Paid workflow must recheck owner/current SHA after setup and before key");
  assert.ok(workflow.slice(at,broker).includes("node scripts/acceptance/shared-luna.mjs revalidate"));
  assert.ok(workflow.includes("queue: max")&&workflow.includes("cancel-in-progress: false"));
  assert.ok(workflow.includes("run-name:")&&workflow.includes("luna-owner-comment-{0}"),
    "Immutable comment ID must appear in Actions run title");
  assert.ok(workflow.includes("actions: read")&&!workflow.includes("issues: write"),
    "Owner-grant authorization must use read-only GitHub permissions");
});

test("non-executing post-candidate source check blocks Git fsmonitor escape and accepts only 14B seed refresh",()=>{
  const work=mkdtempSync(join(tmpdir(),"luna-fsmonitor-"));
  try{
    const root=join(work,"candidate"),source=join(root,"lib/ai/agent/loop.server.ts");
    const seed=join(root,"supabase/seed.sql"),hook=join(work,"malicious-fsmonitor.sh");
    const sentinel=join(work,"hook-executed");
    mkdirSync(join(root,"lib/ai/agent"),{recursive:true});
    mkdirSync(join(root,"supabase"),{recursive:true});
    writeFileSync(source,"export const trusted = true;\n");
    writeFileSync(seed,"-- original fixed seed\n");
    const git=(...args)=>{
      const r=spawnSync("git",["-C",root,...args],{encoding:"utf8"});
      assert.equal(r.status,0,r.stderr);return r.stdout.trim();
    };
    git("init");git("config","user.email","fixture@example.invalid");
    git("config","user.name","Test Fixture");
    git("add",".");git("commit","-m","exact-head test");
    const head=git("rev-parse","HEAD");
    const command=(task,scenario,envDir=work)=>spawnSync(process.execPath,[
      join(import.meta.dirname,"shared-luna.mjs"),task
    ],{cwd:work,encoding:"utf8",env:{...process.env,HEAD_SHA:head,
      SCENARIO:scenario,RUNNER_TEMP:envDir}});
    assert.equal(command("snapshot-source","14b").status,0);
    // Codex P1 regression: candidate-modified generator temporarily writes
    // attacker SQL and restores its tracked source before verification.
    writeFileSync(seed,"-- malicious replacement\ncreate table public.fake_approval_receipt(id int);\n");
    const injected=command("verify-preflight","14b");
    assert.notEqual(injected.status,0);
    assert.match(injected.stderr,/unexpected tracked source/);
    // Only the independent reviewed/coordinator generator may supply
    // accepted bytes for the intentional 14B rolling-date seed refresh.
    const trustedSeed=buildSeedSql({cafes:TEST_CAFES,
      endDateStr:latestClosedDate(TEST_CAFES),days:14});
    writeFileSync(seed,trustedSeed);
    const pre=command("verify-preflight","14b");
    assert.equal(pre.status,0,pre.stderr);
    // Simulate the P1 malicious candidate rewriting its writable local Git
    // configuration. The trusted host MUST NEVER invoke Git after this point.
    writeFileSync(hook,"#!/bin/sh\necho pwned > "+JSON.stringify(sentinel)+"\nexit 0\n");
    chmodSync(hook,0o755);
    const gitconfig=join(root,".git/config");
    const oldConfig=readFileSync(gitconfig,"utf8");
    writeFileSync(gitconfig,oldConfig+"\n[core]\n\tfsmonitor = "+hook+"\n");
    const goodResult=command("verify-source","14b");
    assert.equal(goodResult.status,0,goodResult.stderr);
    assert.equal(readFileSync(seed,"utf8"),trustedSeed);
    assert.throws(()=>readFileSync(sentinel,"utf8"),{code:"ENOENT"});
    writeFileSync(source,"export const trusted = false;\n");
    const failResult=command("verify-source","14b");
    assert.notEqual(failResult.status,0);
    assert.match(failResult.stderr,/unexpected tracked source/);
    assert.throws(()=>readFileSync(sentinel,"utf8"),{code:"ENOENT"});
  }finally{rmSync(work,{recursive:true,force:true})}
});
test("a non-14B scenario cannot silently refresh the tracked SQL seed",()=>{
  const work=mkdtempSync(join(tmpdir(),"luna-seed-deny-"));
  try{
    const root=join(work,"candidate"),seed=join(root,"supabase/seed.sql");
    mkdirSync(join(root,"supabase"),{recursive:true});
    writeFileSync(seed,"seed-before\n");
    const git=(...args)=>{
      const r=spawnSync("git",["-C",root,...args],{encoding:"utf8"});
      assert.equal(r.status,0,r.stderr);return r.stdout.trim();
    };
    git("init");git("config","user.email","fixture@example.invalid");
    git("config","user.name","Test Fixture");git("add",".");
    git("commit","-m","seed source");
    const head=git("rev-parse","HEAD");
    const command=task=>spawnSync(process.execPath,[
      join(import.meta.dirname,"shared-luna.mjs"),task
    ],{cwd:work,encoding:"utf8",env:{...process.env,HEAD_SHA:head,
      SCENARIO:"13c",RUNNER_TEMP:work}});
    const first=command("snapshot-source");
    assert.equal(first.status,0,first.stderr);
    writeFileSync(seed,"seed-after\n");
    const denied=command("verify-preflight");
    assert.notEqual(denied.status,0);
    assert.match(denied.stderr,/unexpected tracked source/);
  }finally{rmSync(work,{recursive:true,force:true})}
});
test("shared paid workflow never executes Git against mutable candidate after container execution",()=>{
  const yaml=readFileSync(join(import.meta.dirname,"../../.github/workflows/ai-cafe-luna-shared.yml"),"utf8");
  const firstContainer=yaml.indexOf("name: Candidate installation and regression preflight");
  const after=yaml.slice(firstContainer);
  assert.ok(firstContainer>0);
  assert.ok(!/git -C candidate\b/.test(after),"Host must never invoke Git against candidate after untrusted execution");
  const mounts=yaml.match(/candidate\/\.git:\/candidate\/\.git:ro/g)||[];
  assert.equal(mounts.length,2,"Both candidate Docker stages must make Git metadata read-only");
  assert.ok(yaml.includes("shared-luna.mjs snapshot-source"));
  assert.ok(yaml.includes("shared-luna.mjs verify-preflight"));
  assert.ok(yaml.includes("shared-luna.mjs verify-source"));
});

test("single-file candidate runner resolves without coordinator seed files",()=>{
  const dir=mkdtempSync(join(tmpdir(),"luna-single-file-"));
  try{
    const file=join(dir,"shared-luna.mjs");
    writeFileSync(file,readFileSync(join(import.meta.dirname,"shared-luna.mjs")));
    const run=spawnSync(process.execPath,["--input-type=module","-e",`import(${JSON.stringify(file)})`],{encoding:"utf8",cwd:dir});
    assert.equal(run.status,0,run.stderr);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("shared live preflight actually executes trusted broker tests in split checkout layout",()=>{
  const work=mkdtempSync(join(tmpdir(),"luna-split-checkout-"));
  try{
    // Mimic the two checkouts created by GitHub Actions. The coordinator is
    // linked to this exact source checkout; the candidate has no trusted files.
    symlinkSync(join(import.meta.dirname,"../.."),join(work,"coordinator"),"dir");
    mkdirSync(join(work,"candidate"));
    const workflow=readFileSync(join(import.meta.dirname,
      "../../.github/workflows/ai-cafe-luna-shared.yml"),"utf8");
    const start=workflow.indexOf("name: Verify immutable scenario and trusted broker with zero secrets");
    const end=workflow.indexOf("name: Freeze the exact source-controlled scenario",start);
    assert.ok(start>0&&end>start,"No real paid-job preflight found");
    const lines=workflow.slice(start,end).split("\n");
    const matching=lines.filter(line=>line.includes("node --test"));
    assert.equal(matching.length,1,"Expect one real broker security invocation in paid preflight");
    const command=matching[0].trim();
    // Execute the actual workflow command, not an assertion about its spelling.
    const ok=spawnSync("bash",["-e","-o","pipefail","-c",command],{
      cwd:work,encoding:"utf8",timeout:30000,
      env:{...process.env,NODE_TEST_CONTEXT:undefined}});
    assert.equal(ok.status,0,"Live preflight broker tests failed in split checkout:\n"+
      (ok.stderr||"")+"\n"+(ok.stdout||"").slice(-1500));
    assert.match(ok.stdout,/^# tests 17$/m,"Actual trusted broker suite must execute all 17 tests");
    assert.match(ok.stdout,/^# pass 17$/m,"Actual trusted broker suite must pass all 17 tests");
    assert.match(ok.stdout,/^# fail 0$/m);
    // Historical regression: the same actual tests executed from workspace
    // root cannot resolve their own .github/workflows or fetch shim fixture.
    const broken=spawnSync(process.execPath,["--test",
      "coordinator/scripts/acceptance/task14b-broker.test.mjs"],{
        cwd:work,encoding:"utf8",timeout:30000,
        env:{...process.env,NODE_TEST_CONTEXT:undefined}});
    assert.notEqual(broken.status,0,"Broken workspace-root broker invocation unexpectedly passed");
    assert.match((broken.stderr||"")+(broken.stdout||""),/ENOENT|Cannot find module/);
  }finally{rmSync(work,{recursive:true,force:true})}
});

test("actual shared DB preflight rejects unavailable authenticated SQL before broker access",()=>{
  const work=mkdtempSync(join(tmpdir(),"luna-db-preflight-"));
  try{
    const bin=join(work,"bin"),candidate=join(work,"candidate");
    mkdirSync(bin);mkdirSync(candidate);
    const yaml=readFileSync(join(import.meta.dirname,
      "../../.github/workflows/ai-cafe-luna-shared.yml"),"utf8");
    const a=yaml.indexOf("      - name: Migrate a fresh disposable local Supabase only\n");
    const b=yaml.indexOf("      - name: Export masked disposable keys and a random capped proxy token\n",a);
    const broker=yaml.indexOf("      - name: Start bounded trusted broker on host",b);
    assert.ok(a>=0&&b>a&&broker>b,"actual DB step must precede paid broker");
    const section=yaml.slice(a,b),mark="        run: |\n";
    assert.ok(section.includes(mark));
    const shell=section.slice(section.indexOf(mark)+mark.length).split("\n")
      .map(line=>line.startsWith("          ")?line.slice(10):line).join("\n");
    const mock=(name,body)=>{
      const path=join(bin,name);writeFileSync(path,"#!/bin/sh\n"+body+"\n",{mode:0o700});
    };
    mock("supabase",'if [ "$1" = status ]; then printf "{}\\n"; fi\nif [ "$1" = db ] && [ "$MODE" = migration-fail ]; then exit 41; fi\nexit 0');
    mock("pg_isready",'if [ "$MODE" = readiness-fail ]; then exit 42; fi\nexit 0');
    const capture=join(work,"sql-invocation");
    mock("psql",'printf "%s\\n" "$PGPASSWORD" "$PGOPTIONS" "$@" > "$SQL_CAPTURE"\nif [ "$MODE" = sql-fail ]; then printf "true\\n"; exit 43; fi\nif [ "$MODE" = wrong-output ]; then printf "false\\n"; else printf "true\\n"; fi');
    const run=mode=>spawnSync("bash",["-euo","pipefail","-c",shell+"\necho BROKER_STARTED"],{
      cwd:candidate,encoding:"utf8",env:{...process.env,
        PATH:bin+":"+process.env.PATH,RUNNER_TEMP:work,MODE:mode,SQL_CAPTURE:capture}
    });
    for(const mode of ["migration-fail","readiness-fail","sql-fail","wrong-output"]){
      rmSync(capture,{force:true});
      const denied=run(mode);
      assert.notEqual(denied.status,0,mode);
      assert.doesNotMatch(denied.stdout,/BROKER_STARTED/);
      assert.throws(()=>readFileSync(join(work,"luna-local-supabase.json")),{code:"ENOENT"});
      if(mode==="sql-fail"||mode==="wrong-output")assert.match(readFileSync(capture,"utf8"),/ON_ERROR_STOP=1/);
      else assert.throws(()=>readFileSync(capture),{code:"ENOENT"});
    }
    const ok=run("ok");
    assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/BROKER_STARTED/);
    const args=readFileSync(capture,"utf8").trimEnd().split("\n");
    assert.deepEqual(args,["postgres","-c default_transaction_read_only=on",
      "-X","-q","-t","-A","-h","127.0.0.1","-p","54322","-U","postgres",
      "-d","postgres","-v","ON_ERROR_STOP=1","-c","select json_build_object('ready',true)->>'ready'"]);
    assert.equal(readFileSync(join(work,"luna-local-supabase.json"),"utf8"),"{}\n");
    assert.throws(()=>readFileSync(join(work,"luna-host-audit.json")),{code:"ENOENT"});
  }finally{rmSync(work,{recursive:true,force:true})}
});

test("shared failure projection comes from the real broker with only offline transport",async()=>{
  const {once}=await import("node:events");
  const {startTrustedBroker}=await import("./task14b-broker.mjs");
  const {readFailureAudit}=await import("./shared-luna-failure.mjs");
  const root=mkdtempSync(join(tmpdir(),"luna-failure-audit-")),auditFile=join(root,"audit.json");
  const head="a".repeat(40),token="b".repeat(64),key="sk-"+ "c".repeat(64);
  const privateMarker="private_marker_never_export";
  let transports=0,server;
  try{
    ({server}=startTrustedBroker({apiKey:key,token,head,auditFile,port:0,fetchUpstream:async()=>{
      transports++;
      if(transports===2)throw Error(privateMarker);
      return new Response(JSON.stringify({error:{type:"invalid_request_error",
        code:"invalid_function_parameters",param:"tools[0].parameters."+privateMarker,
        message:"Invalid schema for function 'private_marker_never_export'"}}),{status:400});
    }}));
    await once(server,"listening");
    const url="http://127.0.0.1:"+server.address().port+"/v1/responses";
    const request={model:"gpt-6-luna",instructions:privateMarker,tool_choice:"auto",
      input:[{role:"user",content:privateMarker}],stream:true,max_output_tokens:100,
      tools:[{type:"function",name:privateMarker,parameters:{type:"object"}}]};
    const send=p=>fetch(url,{method:"POST",headers:{authorization:"Bearer "+token},
      body:JSON.stringify(p)});
    const denied=await send({...request,previous_response_id:"resp_private"});
    assert.equal(denied.status,400);await denied.text();assert.equal(transports,0);
    const rejected=await send(request);assert.equal(rejected.status,502);await rejected.text();
    const unknown=await send(request);assert.equal(unknown.status,502);await unknown.text();
    assert.equal(transports,2);
    const proof=readFailureAudit(auditFile,head);
    assert.equal(proof.result,"FAILED");assert.equal(proof.acceptanceProof,false);
    assert.equal(proof.auditStatus,"available");assert.equal(proof.attempts,2);
    assert.equal(proof.deniedCount,1);assert.deepEqual(proof.policyDenials,["provider_expanded_context_forbidden"]);
    assert.ok(proof.reservedUpperMicros>0&&proof.reservedUpperMicros<=180000);
    assert.deepEqual(proof.receipts,[
      {ordinal:1,terminal:"provider_rejected",upstreamStatus:400,
        rejection:{type:"invalid_request_error",code:"invalid_function_parameters",param:"tools[0].parameters"}},
      {ordinal:2,terminal:"transport_unknown",upstreamStatus:null}]);
    const out=JSON.stringify(proof);
    for(const secret of [privateMarker,key,token,"resp_private","toolName","arguments"])
      assert.ok(!out.includes(secret),"Unexpected diagnostic content");
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});

test("failure diagnostics fail closed for missing, corrupt, stale, forged or oversized audit",async()=>{
  const {readFailureAudit,projectFailureAudit}=await import("./shared-luna-failure.mjs");
  const dir=mkdtempSync(join(tmpdir(),"luna-bad-audit-")),file=join(dir,"audit.json");
  const head="a".repeat(40);
  try{
    const base={head,attempts:0,reservedMicros:0,deniedCount:0,policyDenials:[],receipts:[]};
    const check=(proof,status)=>{
      assert.equal(proof.result,"FAILED");assert.equal(proof.acceptanceProof,false);
      assert.equal(proof.auditStatus,status);
      assert.ok(!JSON.stringify(proof).includes("secret_raw"));
    };
    check(readFailureAudit(file,head),"missing");
    writeFileSync(file,"secret_raw invalid JSON");
    check(readFailureAudit(file,head),"invalid");
    writeFileSync(file,JSON.stringify({...base,head:"b".repeat(40)}));
    check(readFailureAudit(file,head),"invalid");
    writeFileSync(file,JSON.stringify({...base,attempts:1}));
    check(readFailureAudit(file,head),"invalid");
    const forged={...base,attempts:1,reservedMicros:100,deniedCount:1,
      policyDenials:["secret_raw"],receipts:[{ordinal:1,model:"gpt-6-luna",
        terminal:"provider_rejected",upstreamStatus:400,reservedMicros:100,
        rejection:{type:"secret_raw",code:"secret_raw",param:"secret_raw",toolName:"secret_raw"},
        raw:"secret_raw"}]};
    const clean=projectFailureAudit(forged,head);check(clean,"available");
    assert.deepEqual(clean.policyDenials,["unknown"]);
    assert.deepEqual(clean.receipts[0].rejection,{type:"unknown",code:"unknown",param:"unknown"});
    check(projectFailureAudit({...forged,reservedMicros:101},head),"invalid");
    check(projectFailureAudit({...forged,receipts:[{...forged.receipts[0],terminal:"secret_raw"}]},head),"invalid");
    writeFileSync(file,"x".repeat(128*1024+1));
    check(readFailureAudit(file,head),"invalid");
    rmSync(file);symlinkSync("/dev/null",file);
    check(readFailureAudit(file,head),"invalid");
    rmSync(file);writeFileSync(file,JSON.stringify(base));
    check(readFailureAudit(file,head),"available");
  }finally{rmSync(dir,{recursive:true,force:true})}
});

// Structured workflow fixture: evaluate only the expression grammar needed by
// the diagnostic/acceptance tail. Unknown conditions fail, never silently skip.
// Run real shell steps and model the upload action using its actual with inputs.
function runDiagnosticTail(steps,root,{failed,brokerOutcome}){
  const dir=mkdtempSync(join(tmpdir(),"luna-failure-workflow-"));
  const artifacts=[];
  const head="a".repeat(40),scenario="14c";
  const outcomes={"luna-broker":brokerOutcome};
  const jobFailed=failed;
  const unwrap=x=>String(x).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/,"$1");
  function evaluate(raw){
    const expr=unwrap(raw??"success()");
    const evaluateAtom=atom=>{
      const a=atom.trim();
      if(a==="always()")return true;
      if(a==="failure()")return jobFailed;
      if(a==="success()")return !jobFailed;
      const match=/^steps\.([\w-]+)\.outcome\s*==\s*'([^']+)'$/.exec(a);
      if(match)return outcomes[match[1]]===match[2];
      throw Error("Unsupported workflow test condition: "+a);
    };
    // Evaluate every clause, including inactive alternatives, to reject unknown
    // expressions rather than accidentally allowing untested workflow logic.
    const values=expr.split("||").map(or=>or.split("&&").map(evaluateAtom));
    return values.some(and=>and.every(Boolean));
  }
  function interpolate(value){
    return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,(_,expr)=>{
      if(expr==="runner.temp")return dir;
      if(expr==="matrix.scenario")return scenario;
      throw Error("Unsupported workflow test interpolation: "+expr);
    });
  }
  try{
    symlinkSync(root,join(dir,"coordinator"),"dir");
    // Represents a prior trusted attestation only on a successful scenario.
    const accepted={result:"PASS",fixture:"independent-attestation"};
    if(!failed)writeFileSync(join(dir,"luna-sanitized-result.json"),JSON.stringify(accepted));
    // A private host audit and candidate log must never be selected for upload.
    const audit={head,attempts:0,reservedMicros:0,deniedCount:0,policyDenials:[],receipts:[],
      private:"never_export_raw_audit"};
    if(brokerOutcome==="success")writeFileSync(join(dir,"luna-host-audit.json"),JSON.stringify(audit));
    writeFileSync(join(dir,"next.log"),"never_export_candidate_log");
    for(const step of steps){
      if(!evaluate(step.if))continue;
      if(step.run){
        const run=spawnSync("bash",["-euo","pipefail","-c",step.run],{cwd:dir,encoding:"utf8",
          env:{...process.env,RUNNER_TEMP:dir,HEAD_SHA:head,GITHUB_RUN_ATTEMPT:"1"}});
        assert.equal(run.status,0,run.stderr);
      }else if(step.uses?.startsWith("actions/upload-artifact@")){
        const name=interpolate(step.with.name),path=interpolate(step.with.path);
        // Model single-file upload behavior. Reject wildcards, multiple paths
        // and escaping the fixture, rather than silently ignoring extra files.
        assert.ok(path.startsWith(dir+"/")&&!/[\n*?\[\]]/.test(path));
        let bytes;
        try{bytes=readFileSync(path,"utf8")}catch(e){
          if(e.code==="ENOENT"&&step.with["if-no-files-found"]==="warn")continue;
          throw e;
        }
        artifacts.push({name,file:path.slice(dir.length+1),payload:JSON.parse(bytes)});
      }else throw Error("Unexpected workflow tail step");
    }
    let diagnostic=null;
    try{diagnostic=JSON.parse(readFileSync(join(dir,"luna-failure-diagnostic.json"),"utf8"))}
    catch(e){if(e.code!=="ENOENT")throw e}
    return {artifacts,diagnostic,failed:jobFailed};
  }finally{rmSync(dir,{recursive:true,force:true})}
}

test("actual shared workflow tail executes and selects artifacts according to job and broker outcomes",()=>{
  const root=join(import.meta.dirname,"../..");
  // Ubuntu runner's Ruby stdlib YAML parser; no new npm install or paid calls.
  const parsed=spawnSync("ruby",["-rjson","-ryaml","-e",
    'puts JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0))))',
    join(root,".github/workflows/ai-cafe-luna-shared.yml")],{encoding:"utf8"});
  assert.equal(parsed.status,0,parsed.stderr);
  const all=JSON.parse(parsed.stdout).jobs["live-scenario"].steps;
  const first=all.findIndex(s=>s.name==="Upload only the sanitized independent verdict");
  const last=all.findIndex(s=>s.name==="Destroy broker and the disposable database");
  assert.ok(first>=0&&last>first,"Missing executable workflow tail boundaries");
  const tail=all.slice(first,last);
  const success=runDiagnosticTail(tail,root,{failed:false,brokerOutcome:"success"});
  assert.deepEqual(success,{failed:false,diagnostic:null,artifacts:[
    {name:"luna-14c-exact-head-host-proof",file:"luna-sanitized-result.json",
      payload:{result:"PASS",fixture:"independent-attestation"}}]});
  for(const brokerOutcome of ["skipped","failure","cancelled"]){
    assert.deepEqual(runDiagnosticTail(tail,root,{failed:true,brokerOutcome}),
      {failed:true,diagnostic:null,artifacts:[]});
  }
  const failure=runDiagnosticTail(tail,root,{failed:true,brokerOutcome:"success"});
  assert.deepEqual(failure.diagnostic,{
    schemaVersion:1,result:"FAILED",acceptanceProof:false,head:"a".repeat(40),
    auditStatus:"available",attempts:0,reservedUpperMicros:0,deniedCount:0,
    policyDenials:[],receipts:[]});
  assert.equal(failure.failed,true);
  assert.deepEqual(failure.artifacts,[{name:"luna-14c-failure-diagnostic",
    file:"luna-failure-diagnostic.json",payload:failure.diagnostic}]);
  // Mutation controls prove that the behavioral runner catches overly broad
  // or disabled conditions and a substituted artifact, not a spelling match.
  const changed=(index,patch)=>tail.map((step,i)=>i===index?{...step,...patch}:step);
  const record=tail.findIndex(s=>s.name==="Record a failure-only sanitized trusted broker diagnostic");
  const upload=tail.findIndex(s=>s.name==="Upload failure diagnostic separately from acceptance proof");
  assert.ok(record>=0&&upload>=0);
  const tooBroad=runDiagnosticTail(changed(record,{if:"always()"}),root,
    {failed:false,brokerOutcome:"success"});
  assert.notEqual(tooBroad.diagnostic,null,"Mutation must create a forbidden success diagnostic");
  // Upload is still required, so an absent diagnostic must fail the runner.
  assert.throws(()=>runDiagnosticTail(changed(record,{if:"success()"}),root,
    {failed:true,brokerOutcome:"success"}),{code:"ENOENT"});
  const raw=runDiagnosticTail(changed(upload,{with:{...tail[upload].with,
    path:"${{ runner.temp }}/luna-host-audit.json"}}),root,
    {failed:true,brokerOutcome:"success"});
  assert.equal(raw.artifacts[0].payload.private,"never_export_raw_audit");
  assert.notDeepEqual(raw.artifacts,failure.artifacts);
});

test("functional groups and explicit subsets select only registered scenarios",()=>{
 const found=["13c","13d","14b","14c","15c","14d","14-integration","140a"];
 assert.deepEqual(selectLunaScenarios(found,"group-14"),["14-integration","14b","14c","14d"]);
 assert.deepEqual(selectLunaScenarios(found,"15c,13d"),["13d","15c"]);
 assert.deepEqual(selectLunaScenarios(found,"13c"),["13c"]);
 assert.deepEqual(selectLunaScenarios(found,"all"),[...found].sort());
 for(const invalid of ["group-16","group-014","group-14,13c","14*","14","14c,14c","14c,","14c, 14b","all,14c","unknown",""]){
   assert.throws(()=>selectLunaScenarios(found,invalid),undefined,invalid);
 }
 for(const bad of [[],["14c","14c"],["group-14"],["all"],["14 c"],Array.from({length:257},(_,i)=>"case-"+i)]){
   assert.throws(()=>selectLunaScenarios(bad,"all"),/inventory/);
 }
});

// Registration must not itself consume or expand a trusted paid-run budget.
test("large registered catalog retains the strict selected-run limit",()=>{
 const found=Array.from({length:25},(_,i)=>"case-"+i);
 assert.deepEqual(selectLunaScenarios(found,"case-24"),["case-24"]);
 assert.equal(selectLunaScenarios(found,found.slice(0,20).join(",")).length,20);
 assert.throws(()=>selectLunaScenarios(found,"all"),/Requested scenario/);
 assert.throws(()=>selectLunaScenarios(found,found.slice(0,21).join(",")),/Requested scenario/);
 const grouped=Array.from({length:21},(_,i)=>"17-case-"+i);
 assert.throws(()=>selectLunaScenarios(grouped,"group-17"),/Requested scenario/);
});

test("16E permits its documented alternative sales tool but still requires presentation",async()=>{
 const {expectedToolsObserved}=await import("./shared-luna.mjs");
 const m={id:"16e",expectedTools:["get_sales","present_response"]};
 assert.equal(expectedToolsObserved(m,["query_data","present_response"]),true);
 assert.equal(expectedToolsObserved(m,["query_data"]),false);
 assert.equal(expectedToolsObserved({...m,id:"other"},["query_data","present_response"]),false);
});
test("trusted 16E readback rejects altered stored numeric results and wrong currency",async()=>{
 const {attestTask17B}=await import("./luna-attest-17b.mjs");
 const id=n=>"aaaaaaaa-aaaa-4aaa-8aaa-"+String(n).padStart(12,"0");
 const scope={businessId:id(1),ownerUserId:id(2),threadId:id(3),plainReplyId:id(4),richReplyId:id(5),firstDay:"2026-01-01",lastDay:"2026-01-02"};
 const panel={kind:"line",unit:"cents",currency:"USD",from:scope.firstDay,to:scope.lastDay,points:[{label:scope.firstDay,value:1234},{label:scope.lastDay,value:5678}]};
 const query=sql=>{
  if(sql.includes("public.businesses"))return [{currency:"USD"}];
  if(sql.includes("daily_rollups"))return [{net_sales_cents:sql.includes(scope.firstDay)?1234:5678}];
  if(sql.includes(scope.plainReplyId))return [{blocks:[{type:"text",text:"Yes."}]}];
  return [{blocks:[{type:"text",text:"Sales rose."},{type:"rich_presentation",version:1,panels:[structuredClone(panel)]}]}];
 };
 assert.equal(attestTask17B("16e",scope,query).length,2);
 panel.points[1].value=5679;assert.throws(()=>attestTask17B("16e",scope,query));
 panel.points[1].value=5678;panel.currency="EUR";assert.throws(()=>attestTask17B("16e",scope,query));
});
