import {describe,it,expect} from "vitest";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";

// Preserve #513's original executed 13D host-oracle negative matrix against
// the actual extracted shared #520 attester, not a copy or a separate paid
// workflow. All database/provider inputs below are synthetic offline fixtures.
// This cannot authorize provider spend or substitute for genuine Luna proof.
const sha="a".repeat(40);
function temp(){
 return mkdtempSync(join(tmpdir(),"aicafe-13d-security-"));
}
function mockCommand(root:string,name:string,script:string){
 const dir=join(root,"bin");mkdirSync(dir,{recursive:true});
 const path=join(dir,name);writeFileSync(path,"#!/bin/sh\n"+script+"\n",{mode:0o700});
 chmodSync(path,0o700);
 return dir;
}
describe("Task13D trusted host attester (no secrets, no provider)",()=>{
 it("executes the actual host SQL attester; rejects invented leave, scope and model evidence",()=>{
  const root=temp();
  try{
   const id=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
   const scope={
    businessId:id(1),foreignBusinessId:id(2),
    ownerUserId:id(3),foreignOwnerUserId:id(4),
    threadId:id(5),employeeId:id(6),shiftId:id(7),caseId:id(8),
    taskId:"staff-coordination:test-case:owner",leaveDate:"2026-11-17",
    expectedProviderCalls:2,
   };
   const receipt={
    terminal:"completed",model:"gpt-6-luna",
    actualInputTokens:120,actualOutputTokens:85,
    toolNames:["get_investigation_source","get_staff_coordination_cases","get_schedule"],
   };
   const audit={
    head:sha,attempts:2,reservedMicros:18_000,
    receipts:[receipt,receipt],
   };
   const proof={
    head_sha:sha,status:"passed",observed_model:"gpt-6-luna",
    negative_no_automatic_leave_effect:true,
    cross_cafe_owner_denied:true,persisted_followup:true,
    source_verified_human_applied_leave:true,
    actual_supervisor_leave_effect:false,
   };
   const facts={
    caseState:"completed",ownerDecision:"approve",
    approvedSourceRows:1,verifiedCaseEvidence:1,ownerPosts:1,
    currentAssignee:scope.employeeId,taskStatus:"handled",
    taskEvidenceVerified:"true",investigationPhase:"resolved",
    completedQuota:2,foreignOwnerMembership:0,
   };
   const proofDir=join(root,"task13d-candidate-proof");
   mkdirSync(proofDir,{recursive:true});
   const write=(data:unknown,name:string)=>writeFileSync(
    name,JSON.stringify(data)+"\n");
   const auditFile=join(root,"task13d-host-audit.json");
   const scopeFile=join(proofDir,"13d-live-scope.json");
   const proofFile=join(proofDir,"13d-live-proof.json");
   const resultFile=join(root,"task13d-sanitized-result.json");
   const bin=mockCommand(root,"psql",'printf "%s\\n" "$SQL_FACTS"');
   const realAttest=resolve("scripts/acceptance/luna-attest-13d.mjs");
   const run=(source:typeof facts,oneScope:typeof scope=scope,
    modelAudit:typeof audit=audit,modelProof:typeof proof=proof)=>{
    rmSync(resultFile,{force:true});
    write(modelAudit,auditFile);
    write(modelProof,proofFile);
    write(oneScope,scopeFile);
    const executed=spawnSync(process.execPath,[realAttest],{
     encoding:"utf8",
     env:{...process.env,PATH:bin+":"+process.env.PATH,
      RUNNER_TEMP:root,HEAD_SHA:sha,SQL_FACTS:JSON.stringify(source)},
    });
    return {...executed,
     result:existsSync(resultFile)?JSON.parse(readFileSync(resultFile,"utf8")):null};
   };
   const good=run(facts);
   expect(good.status,good.stderr).toBe(0);
   expect(good.result).toMatchObject({
    task:"13D",head:sha,model:"gpt-6-luna",
    independentOwnerDatabaseProof:true,actualExternalEffectPerformed:false});
   // Candidate prose cannot substitute for independent SQL corroboration.
   for(const changed of [
    {approvedSourceRows:0},{verifiedCaseEvidence:0},
    {ownerPosts:0},{caseState:"waiting_evidence"},
    {ownerDecision:"defer"},{currentAssignee:id(99)},
    {taskStatus:"watching"},{taskEvidenceVerified:"false"},
    {investigationPhase:"awaiting_owner"},{completedQuota:1},
    {foreignOwnerMembership:1},
   ]){
    const denied=run({...facts,...changed});
    expect(denied.status,JSON.stringify(changed)).not.toBe(0);
    expect(denied.result).toBe(null);
   }
   const badScope=run(facts,{...scope,leaveDate:"2026-11-17'; drop table x;--"});
   expect(badScope.status).not.toBe(0);
   expect(badScope.result).toBe(null);
   const noRealTool=run(facts,scope,{...audit,
    receipts:[{...receipt,toolNames:["get_sales"]}, {...receipt,toolNames:["get_sales"]}]});
   expect(noRealTool.status).not.toBe(0);
   expect(noRealTool.result).toBe(null);
   const forgery=run({...facts,approvedSourceRows:0},scope,audit,proof);
   expect(forgery.status).not.toBe(0);
   expect(forgery.result).toBe(null);
  }finally{rmSync(root,{recursive:true,force:true})}
 },30_000);
});

/** Execute the real shared workflow shell with offline command doubles. */
function sharedShellStep(name:string,next:string){
 const yaml=readFileSync(".github/workflows/ai-cafe-luna-shared.yml","utf8");
 const a=yaml.indexOf("      - name: "+name+"\n");
 const b=yaml.indexOf("      - name: "+next+"\n",a+1);
 if(a<0||b<=a)throw Error("Shared workflow steps unavailable");
 const section=yaml.slice(a,b),prefix="        run: |\n";
 const start=section.indexOf(prefix);
 if(start<0)throw Error("Shared workflow shell unavailable");
 return section.slice(start+prefix.length).split("\n")
  .map(line=>line.startsWith("          ")?line.slice(10):line).join("\n").trimEnd();
}
describe("Task13D shared workflow isolation (no secrets, no provider)",()=>{
 it("executes the shared candidate Docker launch without inheriting host provider credentials",()=>{
  const root=temp();
  try{
   const capture=join(root,"docker-args.txt");
   const bin=mockCommand(root,"docker",'printf "%s\\n" "$@" > "$DOCKER_CAPTURE"');
   const actual=sharedShellStep(
    "Real registered Supervisor scenario in unprivileged candidate Docker",
    "Independently verify model receipts and source/owner data on trusted host");
   const hostSecret="sk-MOCK_REAL_PROVIDER_KEY_NEVER_PASS";
   const ran=spawnSync("bash",["-euo","pipefail","-c",actual],{
    encoding:"utf8",env:{...process.env,PATH:bin+":"+process.env.PATH,
     DOCKER_CAPTURE:capture,RUNNER_TEMP:root,GITHUB_WORKSPACE:root,
     HEAD_SHA:sha,SCENARIO:"13d",OPENAI_API_KEY:hostSecret,
     OPENAI_API_KEYS:hostSecret,AICAFE_14B_BROKER_TOKEN:"Z".repeat(80),
     GH_TOKEN:"mock-host-github-token"},
   });
   expect(ran.status,ran.stderr).toBe(0);
   const argv=readFileSync(capture,"utf8").trimEnd().split("\n");
   expect(argv.filter(x=>x==="OPENAI_API_KEY"||x.startsWith("OPENAI_API_KEY=")))
    .toEqual(["OPENAI_API_KEY=sk-local_disposable_proxy_key_not_real"]);
   expect(argv).toContain("--cap-drop");
   expect(argv).toContain("ALL");
   expect(argv).toContain("--security-opt");
   expect(argv).toContain("no-new-privileges");
   expect(argv).toContain("AICAFE_SHARED_LUNA_CANDIDATE=1");
   expect(argv).toContain("SCENARIO");
   expect(argv).toContain(root+"/candidate/.git:/candidate/.git:ro");
   expect(argv).toContain(root+"/coordinator/scripts/acceptance/task14b-fetch-shim.cjs:/trusted/task14b-fetch-shim.cjs:ro");
   expect(argv).toContain(root+"/coordinator/scripts/acceptance/shared-luna.mjs:/trusted/shared-luna.mjs:ro");
   expect(argv).toContain(root+"/luna-locked-manifest.json:/trusted/luna-manifest.json:ro");
   expect(argv).toContain("/trusted/shared-luna.mjs");
   for(const forbidden of ["--env-file","--privileged","--pid=host"])expect(argv).not.toContain(forbidden);
   for(const arg of argv){
    for(const forbidden of [hostSecret,"OPENAI_API_KEYS","GH_TOKEN","mock-host-github-token","luna-host-audit.json"])
     expect(arg).not.toContain(forbidden);
   }
  }finally{rmSync(root,{recursive:true,force:true})}
 });
 it("executes shared pre-spend migration, readiness and SQL denials before any broker launch",()=>{
  const root=temp();
  try{
   const actual=sharedShellStep("Migrate a fresh disposable local Supabase only",
    "Export masked disposable keys and a random capped proxy token");
   const bin=mockCommand(root,"supabase",
    'if [ "$1" = "status" ]; then printf "{}\\n"; fi\nif [ "$1" = "db" ] && [ "$FAIL_MIGRATION" = "1" ]; then exit 42; fi\nexit 0');
   mockCommand(root,"pg_isready",'if [ "$FAIL_READY" = "1" ]; then exit 43; fi\nexit 0');
   mockCommand(root,"psql",'if [ "$FAIL_SQL" = "1" ]; then exit 44; fi\nprintf "true\\n"');
   const run=(migration:boolean,ready:boolean,sql:boolean)=>spawnSync("bash",["-euo","pipefail","-c",
    actual+"\necho BROKER_STARTED"],{encoding:"utf8",
    env:{...process.env,PATH:bin+":"+process.env.PATH,RUNNER_TEMP:root,
     FAIL_MIGRATION:migration?"1":"0",FAIL_READY:ready?"1":"0",FAIL_SQL:sql?"1":"0"}});
   for(const [migration,ready,sql] of [[true,false,false],[false,true,false],[false,false,true]]){
    const denied=run(migration,ready,sql);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).not.toContain("BROKER_STARTED");
    expect(existsSync(join(root,"luna-local-supabase.json"))).toBe(false);
   }
   const good=run(false,false,false);
   expect(good.status,good.stderr).toBe(0);
   expect(good.stdout).toContain("BROKER_STARTED");
   expect(existsSync(join(root,"luna-local-supabase.json"))).toBe(true);
   expect(existsSync(join(root,"luna-host-audit.json"))).toBe(false);
   // The shared coordinator also independently tests an invalid SQL result
   // and a nonzero exit even when the result looks successful.
  }finally{rmSync(root,{recursive:true,force:true})}
 });
});
