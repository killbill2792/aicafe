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
