import {describe,it,expect} from "vitest";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";

/** Execute the REAL owner gate and candidate shell from the trusted workflow.
 * No string-only "the YAML mentions the word secure" test: each denial
 * actually executes and must exit before any GitHub grant is consumed. */
const yaml=readFileSync(".github/workflows/ai-cafe-13c-owner-live.yml","utf8");
const sha="a".repeat(40);
const grant="<!-- aicafe-task13c-trusted-paid-run-v1 "+sha+" -->";
const consumed="<!-- aicafe-task13c-authorization-consumed:pr501:pilot-v1 -->";
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
 return mkdtempSync(join(tmpdir(),"aicafe-13c-security-"));
}
function event(body:string,patch:Record<string,unknown>={}){
 const data={
  action:"edited",sender:{login:"killbill2792"},
  repository:{full_name:"killbill2792/aicafe"},
  changes:{body:{from:"Earlier safe body"}},
  pull_request:{number:501,user:{login:"killbill2792"},
   head:{sha,ref:"feat/task13c-employee-communication",
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
 const prelude="const latest="+JSON.stringify(latest)+";\n"+
  "const old="+JSON.stringify(old)+";\n"+
  "const postStatus="+JSON.stringify(options.postStatus??201)+";\n"+
  "globalThis.fetch=async(url,init={})=>{\n"+
  " const u=String(url);\n"+
  " if(u.endsWith('/pulls/501'))return new Response(JSON.stringify(latest),{status:200});\n"+
  " if(u.includes('/issues/501/comments?'))return new Response(JSON.stringify(old),{status:200});\n"+
  " if(u.endsWith('/issues/501/comments')&&init.method==='POST'){\n"+
  "  process.stdout.write('POST_CONSUMED\\n');\n"+
  "  return new Response('{}',{status:postStatus});\n"+
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
describe("Task13C owner-gated real Luna security behavior",()=>{
 it("real owner grant code consumes exactly one valid head, and rejects unsafe grants before posting",()=>{
  const root=temp();
  try{
   const good=simulateOwner(root);
   expect(good.status).toBe(0);
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
   expect(argv).toContain("AICAFE_13C_HOST_ATTEST_DB=1");
   expect(argv).not.toContain(hostSecret);
   expect(argv).not.toContain("OPENAI_API_KEYS");
   expect(argv).not.toContain("task13c-host-audit.json");
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
    dbStep+"\nprintf BROKER_STARTED\\n"],{
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
   expect(existsSync(join(root,"task13c-local-supabase.json"))).toBe(true);
   // The subsequent host-broker step is a separate trusted action. CI
   // executes it ONLY after preflight exits successfully; this negative
   // case has not launched any broker or contacted any provider.
   expect(existsSync(join(root,"task13c-host-audit.json"))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true})}
 });
});
