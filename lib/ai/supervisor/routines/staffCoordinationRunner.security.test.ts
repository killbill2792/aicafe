import {describe,it,expect} from "vitest";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";

/** Execute the REAL owner gate and candidate shell from the trusted workflow.
 * No string-only "the YAML mentions the word secure" test: each denial
 * actually executes and must exit before any GitHub grant is consumed. */
const yaml=readFileSync(".github/workflows/ai-cafe-13d-owner-live.yml","utf8");
const sha="a".repeat(40);
const grant="<!-- aicafe-task13d-trusted-paid-run-v1 "+sha+" -->";
const consumed="<!-- aicafe-task13d-authorization-consumed:pr508:pilot-v1 -->";
function ownerScript(){
 const match=yaml.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/);
 if(!match)throw Error("Owner grant must execute actual trusted script");
 return match[1].split("\n").map(line=>line.replace(/^ {10}/,"")).join("\n");
}
function shellStep(name:string,next:string){
 const a=yaml.indexOf("      - name: "+name);
 const b=yaml.indexOf("      - name: "+next,a+1);
 if(a<0||b<=a)throw Error("Actual workflow steps unavailable");
 const section=yaml.slice(a,b);
 const prefix="        run: |\n";
 const start=section.indexOf(prefix);
 if(start<0)throw Error("Actual executable shell step unavailable");
 return section.slice(start+prefix.length).split("\n")
  .map(line=>line.startsWith("          ")?line.slice(10):line).join("\n").trimEnd();
}
function temp(){
 return mkdtempSync(join(tmpdir(),"aicafe-13d-security-"));
}
function event(body:string,patch:Record<string,unknown>={}){
 const data={
  action:"edited",sender:{login:"killbill2792"},
  repository:{full_name:"killbill2792/aicafe"},
  changes:{body:{from:"Earlier safe body"}},
  pull_request:{number:508,user:{login:"killbill2792"},
   head:{sha,ref:"feat/task13d-employee-communication",
    repo:{full_name:"killbill2792/aicafe"}},
   base:{ref:"main"},body},
 };
 return {...data,...patch};
}
function simulateOwner(root:string,options:{
 previous?:string;body?:string;previousGrant?:boolean;
 movedHead?:boolean;actor?:string;runAttempt?:string;triggeredBy?:string;
 eventPatch?:Record<string,unknown>;postStatus?:number;
}={}){
 const body=options.body??("Owner authorization\n"+grant);
 const ev=event(body,options.eventPatch);
 if(options.actor)ev.sender={login:options.actor};
 ev.changes={body:{from:options.previous??"Earlier safe body"}};
 const eventFile=join(root,"event.json"),outputFile=join(root,"output.txt");
 rmSync(outputFile,{force:true});
 writeFileSync(eventFile,JSON.stringify(ev));
 const latest={head:{sha:options.movedHead?"b".repeat(40):sha},
  base:{ref:"main"},body,state:"open"};
 const old=options.previousGrant?[{body:consumed}]:[];
 const prelude="const mockLatest="+JSON.stringify(latest)+";\n"+
  "const mockOld="+JSON.stringify(old)+";\n"+
  "const mockPostStatus="+JSON.stringify(options.postStatus??201)+";\n"+
  "globalThis.fetch=async(url,init={})=>{\n"+
  " const u=String(url);\n"+
  " if(u.endsWith('/pulls/508'))return new Response(JSON.stringify(mockLatest),{status:200});\n"+
  " if(u.includes('/issues/508/comments?'))return new Response(JSON.stringify(mockOld),{status:200});\n"+
  " if(u.endsWith('/issues/508/comments')&&init.method==='POST'){\n"+
  "  process.stdout.write('POST_CONSUMED\\n');\n"+
  "  return new Response('{}',{status:mockPostStatus});\n"+
  " }\n throw Error('Unexpected mocked GitHub request');\n};\n";
 const result=spawnSync(process.execPath,["--input-type=module"],{
  input:prelude+ownerScript(),encoding:"utf8",
  env:{...process.env,GH_TOKEN:"mock-no-real-github-key",
   GITHUB_EVENT_PATH:eventFile,GITHUB_OUTPUT:outputFile,
   GITHUB_RUN_ATTEMPT:options.runAttempt??"1",
   GITHUB_TRIGGERING_ACTOR:options.triggeredBy??"killbill2792"},
 });
 return {...result,output:existsSync(outputFile)?readFileSync(outputFile,"utf8"):null};
}
function mockCommand(root:string,name:string,script:string){
 const dir=join(root,"bin");mkdirSync(dir,{recursive:true});
 const path=join(dir,name);writeFileSync(path,"#!/bin/sh\n"+script+"\n",{mode:0o700});
 chmodSync(path,0o700);
 return dir;
}
describe("Task13D owner-gated real Luna security behavior",()=>{
 it("paid job itself rejects job-only rerun after successful owner consumption",()=>{
  const root=temp();
  try{
   // Simulate a successful, already-consumed authorization from the first
   // attempt. Rerunning only the paid job retains its successful dependency.
   const authorized=simulateOwner(root);
   expect(authorized.status,authorized.stderr).toBe(0);
   expect(authorized.output).toBe("head="+sha+"\n");
   const realPreflight=shellStep(
    "Fail closed on attempted paid job replay before any checkout",
    "Checkout ONLY trusted broker from main, without write credentials");
   const attempt=(n:string)=>spawnSync("bash",["-euo","pipefail","-c",
    realPreflight+"\necho BROKER_STARTED"],{
    encoding:"utf8",
    env:{...process.env,GITHUB_RUN_ATTEMPT:n},
   });
   const original=attempt("1");
   expect(original.status,original.stderr).toBe(0);
   expect(original.stdout).toContain("BROKER_STARTED");
   for(const runAttempt of ["2","3",""]){
    const denied=attempt(runAttempt);
    expect(denied.status,denied.stderr).not.toBe(0);
    expect(denied.stdout).not.toContain("BROKER_STARTED");
   }
  }finally{rmSync(root,{recursive:true,force:true})}
 });
 it("real owner grant code consumes exactly one valid head, and rejects unsafe grants before posting",()=>{
  const root=temp();
  try{
   const good=simulateOwner(root);
   expect(good.status,good.stderr).toBe(0);
   expect(good.output).toBe("head="+sha+"\n");
   expect(good.stdout).toContain("POST_CONSUMED");
   const rejected=[
    {body:grant+"\n"+grant},
    {body:"Prior authorization only"},
    {previous:"Older body\n"+grant},
    {actor:"untrusted-contributor"},
    {runAttempt:"2"},
    {triggeredBy:"untrusted-contributor"},
    {movedHead:true},
    {previousGrant:true},
    {eventPatch:{action:"synchronize"}},
    {eventPatch:{repository:{full_name:"attacker/repo"}}},
    {eventPatch:{pull_request:{...event("x").pull_request,number:506}}},
    {postStatus:403},
   ];
   for(const [index,scenario] of rejected.entries()){
    const denied=simulateOwner(root,scenario);
    expect(denied.status,"scenario "+index).not.toBe(0);
    expect(denied.output,"scenario "+index).toBe(null);
    if(index!==11)expect(denied.stdout).not.toContain("POST_CONSUMED");
   }
  }finally{rmSync(root,{recursive:true,force:true})}
 },30_000);
 it("actual candidate Docker launch cannot inherit a real provider key even if the host has one",()=>{
  const root=temp();
  try{
   const capture=join(root,"docker-args.txt");
   const bin=mockCommand(root,"docker",'printf "%s\\n" "$@" > "$DOCKER_CAPTURE"');
   const actual=shellStep(
    "Run the real registered Supervisor inside unprivileged candidate Docker",
    "Redacted host broker failure diagnostics");
   const hostSecret="sk-THIS_IS_A_MOCK_REAL_PROVIDER_KEY_NEVER_PASS";
   const ran=spawnSync("bash",["-euo","pipefail","-c",actual],{
    encoding:"utf8",
    env:{...process.env,PATH:bin+":"+process.env.PATH,
     DOCKER_CAPTURE:capture,RUNNER_TEMP:root,
     GITHUB_WORKSPACE:root,HEAD_SHA:sha,
     OPENAI_API_KEY:hostSecret,
     AICAFE_14B_BROKER_TOKEN:"Z".repeat(80),
     AI_CAFE_LIVE_ACCEPTANCE:"OWNER_APPROVED_LOCAL_ONLY",
     APP_URL:"http://127.0.0.1:3000",
     SUPERVISOR_OPENAI_MODEL:"gpt-6-luna",
     NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:54321",
     NEXT_PUBLIC_SUPABASE_ANON_KEY:"local-test-anon",
     SUPABASE_SERVICE_ROLE_KEY:"local-test-service"},
   });
   expect(ran.status,ran.stderr).toBe(0);
   const argv=readFileSync(capture,"utf8");
   const providerEnv=argv.split("\n").filter(x=>
    x==="OPENAI_API_KEY"||x.startsWith("OPENAI_API_KEY="));
   expect(providerEnv).toEqual(["OPENAI_API_KEY=sk-local_disposable_proxy_key_not_real"]);
   expect(argv).toContain("task14b-fetch-shim.cjs:ro");
   expect(argv).toContain("--cap-drop");
   expect(argv).toContain("--security-opt");
   expect(argv).toContain("no-new-privileges");
   expect(argv).toContain("AICAFE_13D_HOST_ATTEST_DB=1");
   expect(argv).not.toContain(hostSecret);
   expect(argv).not.toContain("OPENAI_API_KEYS");
   expect(argv).not.toContain("task13d-host-audit.json");
   expect(argv).not.toContain("--env-file");
   expect(argv).not.toContain("--privileged");
   expect(argv).not.toContain("--pid=host");
  }finally{rmSync(root,{recursive:true,force:true})}
 });
 it("executed pre-spend database preflight fails closed on unavailable SQL; no provider startup",()=>{
  const root=temp();
  try{
   const dbStep=shellStep("Start and migrate ONLY disposable local two-café Supabase",
    "Load only disposable credentials and generate ephemeral proxy token");
   const bin=mockCommand(root,"supabase",
    'if [ "$1" = "status" ]; then printf "{}\\n"; fi\nexit 0');
   mockCommand(root,"pg_isready","exit 0");
   mockCommand(root,"psql",
    'if [ "$FAIL_SQL_PREFLIGHT" = "1" ]; then exit 42; fi\nprintf "true\\n"');
   const run=(fail:boolean)=>spawnSync("bash",["-euo","pipefail","-c",
    dbStep+"\necho BROKER_STARTED"],{
    encoding:"utf8",env:{...process.env,PATH:bin+":"+process.env.PATH,
     FAIL_SQL_PREFLIGHT:fail?"1":"0",RUNNER_TEMP:root},
   });
   const fail=run(true);
   expect(fail.status).not.toBe(0);
   expect(fail.stderr).not.toContain("OPENAI");
   expect(fail.stdout).not.toContain("BROKER_STARTED");
   const good=run(false);
   expect(good.status,good.stderr).toBe(0);
   expect(good.stdout).toContain("BROKER_STARTED");
   expect(existsSync(join(root,"task13d-local-supabase.json"))).toBe(true);
   // The subsequent host-broker step is a separate trusted action. CI
   // executes it ONLY after preflight exits successfully; this negative
   // case has not launched any broker or contacted any provider.
   expect(existsSync(join(root,"task13d-host-audit.json"))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true})}
 });
});


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
   const realAttest=shellStep(
    "TRUSTED host attestation of paid Luna tools and source/owner results",
    "Upload sanitized objective proof only");
   const run=(source:typeof facts,oneScope:typeof scope=scope,
    modelAudit:typeof audit=audit,modelProof:typeof proof=proof)=>{
    rmSync(resultFile,{force:true});
    write(modelAudit,auditFile);
    write(modelProof,proofFile);
    write(oneScope,scopeFile);
    const executed=spawnSync("bash",["-euo","pipefail","-c",realAttest],{
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
