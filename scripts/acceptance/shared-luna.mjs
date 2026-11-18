#!/usr/bin/env node
/**
 * Trusted-main shared Luna acceptance. This file is mounted read-only into a
 * disposable candidate container; only the trusted host runs "plan"/"attest".
 * No PR changes or arbitrary script parameters can grant provider credentials.
 */
import {readFileSync,writeFileSync,appendFileSync,copyFileSync,mkdirSync,existsSync,openSync,closeSync,readdirSync,lstatSync} from "node:fs";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
const REPO="killbill2792/aicafe", OWNER="killbill2792";
const shaRe=/^[0-9a-f]{40}$/, idRe=/^[a-z0-9][a-z0-9-]{0,31}$/;
const manifestPath=id=>".github/luna/scenarios/"+id+".json";
const legacy={
  "13c":{engine:"vitest",entrypoint:"lib/ai/supervisor/routines/staffCoverage.live.test.ts",proof:"13c-live-proof.json",scope:"13c-live-scope.json"},
  "13d":{engine:"vitest",entrypoint:"lib/ai/supervisor/routines/staffCoordination.live.test.ts",proof:"13d-live-proof.json",scope:"13d-live-scope.json"},
  "14b":{engine:"node-server",entrypoint:"evals/acceptance/live/task14b.mjs",proof:"task14b-live-proof.json"}
};
function ensure(value,message){if(!value)throw Error(message)}
function cleanPath(p){return typeof p==="string"&&p.length<200&&!p.includes("..")&&/^[a-zA-Z0-9/_.-]+$/.test(p)&&!p.startsWith("/")&&!p.includes("//")}
export function validateScenario(m,id){
  ensure(idRe.test(id)&&m&&typeof m==="object"&&!Array.isArray(m),"Invalid scenario manifest");
  ensure(m.id===id,"Scenario ID mismatch");
  if(Object.hasOwn(legacy,id)){
    ensure(m.mode==="legacy"&&Object.keys(legacy[id]).every(k=>m[k]===legacy[id][k]),"Legacy oracle/entrypoint may not be overridden");
    return {...legacy[id],id,mode:"legacy"};
  }
  ensure(m.mode==="generic"&&["vitest","node-server"].includes(m.engine),
    "Generic scenarios must use an isolated Vitest or local app server contract");
  ensure(cleanPath(m.entrypoint)&&(
    (m.engine==="vitest"&&m.entrypoint.endsWith(".live.test.ts"))||
    (m.engine==="node-server"&&
      /^evals\/acceptance\/live\/[a-zA-Z0-9_-]+\.mjs$/.test(m.entrypoint))),
    "Invalid generic test entrypoint");
  ensure(m.proof===id+"-proof.json"&&m.scope===id+"-scope.json","Invalid proof filenames");
  ensure(Array.isArray(m.expectedTools)&&m.expectedTools.length>=2&&m.expectedTools.length<=20&&
    m.expectedTools.every(t=>typeof t==="string"&&/^[a-z][a-z0-9_]{1,79}$/.test(t)),"Real registered tool names required");
  ensure(Array.isArray(m.assertions)&&m.assertions.length>=3&&m.assertions.length<=20,"Independent DB assertions required");
  const kinds=new Set();
  const names=new Set();
  for(const a of m.assertions){
    ensure(a&&typeof a==="object"&&["source","owner","isolation"].includes(a.kind),"Invalid readback category");
    ensure(typeof a.name==="string"&&/^[a-z][a-z0-9_-]{1,50}$/.test(a.name)&&!names.has(a.name),"Unique assertion names required");
    names.add(a.name);kinds.add(a.kind);
    ensure(typeof a.table==="string"&&/^public\.[a-z][a-z0-9_]*$/.test(a.table),"Only disposable public tables allowed");
    ensure(a.where&&typeof a.where==="object"&&!Array.isArray(a.where)&&Object.keys(a.where).length>=1&&Object.keys(a.where).length<=8,"Scoped WHERE required");
    for(const [column,condition] of Object.entries(a.where)){
      ensure(/^[a-z][a-z0-9_]*$/.test(column)&&condition&&typeof condition==="object"&&!Array.isArray(condition),"Unsafe predicate");
      const keys=Object.keys(condition);
      ensure(keys.length===1&&(keys[0]==="scope"||keys[0]==="eq"),"Only exact equality predicates");
      if(keys[0]==="scope")ensure(typeof condition.scope==="string"&&/^[a-z][A-Za-z0-9]{1,60}$/.test(condition.scope),"Invalid scoped key");
      else ensure(typeof condition.eq==="string"&&/^[A-Za-z0-9:_-]{1,100}$/.test(condition.eq),"Invalid literal");
    }
    ensure(Number.isSafeInteger(a.minCount)&&a.minCount>=0&&a.minCount<=10000&&
      Number.isSafeInteger(a.maxCount)&&a.maxCount>=a.minCount&&a.maxCount<=10000,"Bounded count assertion required");
    if(a.kind==="isolation")ensure(a.maxCount===0,"Isolation negative control must expect zero");
  }
  ensure(["source","owner","isolation"].every(k=>kinds.has(k)),"Source, owner and cross-scope negatives required");
  return m;
}
export function readScenario(root,id){
  ensure(idRe.test(id),"Invalid scenario ID");
  const p=resolve(root,manifestPath(id));
  const m=JSON.parse(readFileSync(p,"utf8"));
  return validateScenario(m,id);
}
function frozenFile(){
  if(process.env.AICAFE_SHARED_LUNA_CANDIDATE==="1")return "/trusted/luna-manifest.json";
  ensure(typeof process.env.RUNNER_TEMP==="string"&&process.env.RUNNER_TEMP.length>0,
    "Trusted runner temp path missing");
  return resolve(process.env.RUNNER_TEMP,"luna-locked-manifest.json");
}
function freeze(){
  ensure(shaRe.test(process.env.HEAD_SHA)&&idRe.test(process.env.SCENARIO),
    "Frozen manifest requires validated exact SHA and scenario ID");
  const root=resolve("candidate"),id=process.env.SCENARIO,p=manifestPath(id);
  const rev=spawnSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"});
  ensure(rev.status===0&&rev.stdout.trim()===process.env.HEAD_SHA,
    "Candidate HEAD does not match owner authorized SHA");
  const mode=spawnSync("git",["-C",root,"ls-tree","HEAD","--",p],{encoding:"utf8"});
  ensure(mode.status===0&&/^100644 blob [0-9a-f]{40}\t/.test(mode.stdout),
    "Scenario must be a regular source-controlled blob, not a symlink");
  const original=spawnSync("git",["-C",root,"show","HEAD:"+p],{
    encoding:"utf8",maxBuffer:256000});
  ensure(original.status===0&&original.stdout.length>0&&original.stdout.length<128000,
    "Source-controlled scenario manifest unavailable");
  const checkedOut=readFileSync(resolve(root,p),"utf8");
  ensure(original.stdout===checkedOut,"Working candidate manifest differs from approved SHA");
  const m=validateScenario(JSON.parse(original.stdout),id);
  ensure(existsSync(resolve(root,m.entrypoint)),"Scenario source file missing");
  const output=frozenFile();
  writeFileSync(output,original.stdout,{mode:0o400,flag:"wx"});
  const digest=createHash("sha256").update(original.stdout).digest("hex");
  console.log("Locked exact-head scenario "+id+" sha256="+digest);
}
function readFrozen(id){
  ensure(idRe.test(id),"Bad frozen scenario ID");
  const m=JSON.parse(readFileSync(frozenFile(),"utf8"));
  return validateScenario(m,id);
}
function validateAll(){
  const root=process.cwd(),folder=resolve(root,".github/luna/scenarios");
  const files=readdirSync(folder);
  ensure(files.length>=1&&files.length<=20,"Scenario inventory must be nonempty and budget bounded");
  for(const filename of files){
    ensure(filename.endsWith(".json")&&idRe.test(filename.slice(0,-5)),
      "Invalid registered scenario filename");
    const id=filename.slice(0,-5),filepath=resolve(folder,filename);
    ensure(lstatSync(filepath).isFile(),"Scenario manifest cannot be a symlink or directory");
    const scenario=readScenario(root,id);
    ensure(existsSync(resolve(root,scenario.entrypoint)),
      "Registered live scenario executable missing: "+id);
    console.log("Valid no-secret scenario: "+id);
  }
}
async function api(url,token){
  const response=await fetch(url,{headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});
  ensure(response.ok,"GitHub preflight HTTP "+response.status);
  return response.json();
}
async function plan(){
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));
  ensure(process.env.GITHUB_ACTOR===OWNER&&process.env.GITHUB_TRIGGERING_ACTOR===OWNER&&
    process.env.GITHUB_RUN_ATTEMPT==="1"&&
    event.repository?.full_name===REPO&&event.sender?.login===OWNER&&
    process.env.GITHUB_REF==="refs/heads/main","Explicit owner launch on trusted main required");
  const token=process.env.GH_TOKEN,base="https://api.github.com/repos/"+REPO;
  ensure(typeof token==="string"&&token.length>0,"Read-only GitHub token required");
  let inputs;
  if(process.env.GITHUB_EVENT_NAME==="workflow_dispatch"){
    inputs=event.inputs??{};
  }else{
    ensure(process.env.GITHUB_EVENT_NAME==="issue_comment"&&
      event.action==="created"&&event.issue?.pull_request&&
      event.comment?.user?.login===OWNER&&
      Number.isSafeInteger(event.comment.id)&&event.comment.id>0,
      "Only newly created owner-authored PR comment may authorize provider work");
    const command=String(event.comment.body??"");
    const match=/^\/aicafe-luna (pr|main) ([a-f0-9]{40}) (all|[a-z0-9][a-z0-9-]{0,31}) ((?:0|[1-3])\.[0-9]{2})$/.exec(command);
    ensure(match,"Exact owner comment syntax required: /aicafe-luna pr|main HEAD_SHA SCENARIO MAX_USD");
    // A deleted/edited command is a withdrawn grant; never use a stale event
    // payload. Only read a comment, and never execute untrusted comment text.
    const live=await api(base+"/issues/comments/"+event.comment.id,token);
    ensure(live.body===command&&live.user?.login===OWNER&&
      live.id===event.comment.id&&
      live.updated_at===event.comment.updated_at,
      "Owner comment changed or is no longer available");
    const prValue=match[1]==="pr"?String(event.issue.number):"0";
    inputs={head_sha:match[2],pr_number:prValue,
      scenario:match[3],max_budget_usd:match[4]};
  }
  const head=inputs.head_sha;
  ensure(shaRe.test(head),"Pinned 40-hex target head required");
  const prValue=String(inputs.pr_number??"0");
  ensure(/^(0|[1-9][0-9]{0,5})$/.test(prValue),"Invalid PR number");
  const number=Number(prValue);
  if(number){
    const pr=await api(base+"/pulls/"+number,token);
    ensure(pr.state==="open"&&pr.head?.sha===head&&pr.head?.repo?.full_name===REPO,
      "Only exact current same-repo PR heads manually approved by the owner may be tested");
  }else{
    const branch=await api(base+"/branches/main",token);
    ensure(branch.commit?.sha===head,"Integrated suite must target current main, not an older SHA");
  }
  const tree=await api(base+"/git/trees/"+head+"?recursive=1",token);
  ensure(tree.truncated===false&&Array.isArray(tree.tree),"Complete candidate file list required");
  const paths=new Set(tree.tree.filter(x=>x.type==="blob"&&x.mode==="100644").map(x=>x.path));
  const found=[...paths].map(p=>/^\.github\/luna\/scenarios\/([a-z0-9][a-z0-9-]{0,31})\.json$/.exec(p))
    .filter(Boolean).map(m=>m[1]).sort();
  const requested=String(inputs.scenario??"all");
  ensure(requested==="all"||idRe.test(requested),"Invalid scenario selection");
  const selected=requested==="all"?found:[requested];
  ensure(selected.length>0&&selected.length<=20&&selected.every(id=>found.includes(id)),"Requested scenario is not registered on exact candidate head");
  for(const id of selected){
    // This is an existence precheck. The locked coordinator validates contents
    // after checkout and before starting any paid broker.
    ensure(paths.has(manifestPath(id)),"Scenario manifest missing");
  }
  const budget=String(inputs.max_budget_usd??"0.20");
  ensure(/^(?:0|[1-3])\.[0-9]{2}$/.test(budget),
    "Owner budget must be exact dollars/cents from $0.00 through $3.99");
  const authorizedCents=Number(budget.replace(".",""));
  const reservedCents=selected.length*18;
  ensure(reservedCents<=authorizedCents,
    "Requested scenarios exceed manual owner budget authorization; choose fewer or approve more explicitly");
  const maxUSD=(reservedCents/100).toFixed(2);
  console.log("Owner-approved one-shot run "+process.env.GITHUB_RUN_ID+
    " at "+head+", cases="+selected.join(",")+
    ", authorized USD="+budget+", cumulative worst-case reserved USD="+maxUSD+
    ". Reruns forbidden; a new manual dispatch is a new authorization.");
  const out=process.env.GITHUB_OUTPUT;
  ensure(out,"Missing Actions output file");
  appendFileSync(out,"head="+head+"\n");
  appendFileSync(out,"matrix="+JSON.stringify(selected)+"\n");
  appendFileSync(out,"scenario_count="+selected.length+"\n");
}
function checkHead(){
  const x=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"});
  ensure(x.status===0&&x.stdout.trim()===process.env.HEAD_SHA,"Candidate checkout SHA changed");
}
function exec(bin,args,opts={}){
  const r=spawnSync(bin,args,{stdio:"inherit",timeout:720000,...opts});
  ensure(r.status===0,"Isolated candidate command failed: "+bin);
}
async function candidate(){
  checkHead();
  const id=process.env.SCENARIO,manifest=readFrozen(id);
  const dir="/proof";
  ensure(existsSync(dir),"Missing candidate proof mount");
  const env={...process.env,
    AICAFE_SHARED_LUNA:"1",
    AICAFE_SHARED_LUNA_HEAD:process.env.HEAD_SHA,
    AICAFE_SHARED_LUNA_SCENARIO:id,
    AICAFE_SHARED_LUNA_PROOF_DIR:dir,
    AI_CAFE_LIVE_ACCEPTANCE:"OWNER_APPROVED_LOCAL_ONLY",
    SUPERVISOR_OPENAI_MODEL:"gpt-6-luna",
    SUPERVISOR_OPENAI_FALLBACK_MODEL:"gpt-4.1-mini",
    APP_URL:"http://127.0.0.1:3000",
    ACCEPTANCE_DATABASE_URL:"postgresql://postgres:postgres@127.0.0.1:54322/postgres"};
  if(id==="13c"){
    env.AICAFE_13C_HOST_ATTEST_DB="1";
    env.AICAFE_13C_AGENTIC_LIVE="1";
    env.AICAFE_13C_LOCAL_DB_URL=env.ACCEPTANCE_DATABASE_URL;
    env.AICAFE_13C_LIVE_HEAD=process.env.HEAD_SHA;
  }
  if(id==="13d"){
    env.AICAFE_13D_HOST_ATTEST_DB="1";
    env.AICAFE_13D_AGENTIC_LIVE="1";
    env.AICAFE_13D_LOCAL_DB_URL=env.ACCEPTANCE_DATABASE_URL;
    env.AICAFE_13D_LIVE_HEAD=process.env.HEAD_SHA;
  }
  if(id==="14b")env.SUPERVISOR_CHAT_ENABLED="true";
  if(manifest.engine==="node-server"){
    const log=openSync(dir+"/next.log","w");
    const server=spawn("npm",["run","dev","--","--webpack","--hostname","127.0.0.1","--port","3000"],{env,stdio:["ignore",log,log]});
    try{
      let ready=false;
      for(let i=0;i<90;i++){
        try{const r=await fetch("http://127.0.0.1:3000/en/login");if(r.ok){ready=true;break}}catch{}
        await new Promise(r=>setTimeout(r,2000));
      }
      ensure(ready,"Disposable candidate web server did not start");
      exec("node",[manifest.entrypoint,"--output",dir+"/"+manifest.proof,
        ...(manifest.scope?["--scope-output",dir+"/"+manifest.scope]:[])],{env});
      ensure(existsSync(dir+"/"+manifest.proof),"Missing exact-run local-server proof");
      if(manifest.scope)ensure(existsSync(dir+"/"+manifest.scope),
        "Missing exact-run local-server scoped proof");
    }finally{server.kill();closeSync(log)}
  }else{
    exec("npx",["vitest","run",manifest.entrypoint,"--reporter=verbose"],{env});
    const src=resolve("/candidate/test-results/acceptance",manifest.proof);
    ensure(existsSync(src),"Missing exact-run candidate proof");
    copyFileSync(src,dir+"/"+manifest.proof);
    if(manifest.scope){
      const scope=resolve("/candidate/test-results/acceptance",manifest.scope);
      ensure(existsSync(scope),"Missing scoped candidate proof");
      copyFileSync(scope,dir+"/"+manifest.scope);
    }
  }
}
function sqlLiteral(value){ensure(typeof value==="string"&&/^[A-Za-z0-9:_-]{1,150}$/.test(value),"Unsafe scoped value");return "'"+value+"'";}
function dbCount(table,where,scope){
  const conditions=Object.entries(where).map(([col,val])=>
    '"'+col+'"='+sqlLiteral(Object.hasOwn(val,"scope")?scope[val.scope]:val.eq));
  const query="SELECT count(*) FROM "+table+" WHERE "+conditions.join(" AND ")+";";
  // One SQL statement, one integer output. The session itself is read-only;
  // a BEGIN/COMMIT string would make psql -c return the wrong final result.
  const r=spawnSync("psql",["-X","-q","-t","-A","-h","127.0.0.1","-p","54322","-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1","-c",query],
    {encoding:"utf8",env:{...process.env,PGPASSWORD:"postgres",PGOPTIONS:"-c default_transaction_read_only=on"},timeout:15000,maxBuffer:100000});
  ensure(r.status===0&&/^[0-9]+$/.test(r.stdout.trim()),"Host SQL readback failed");
  return Number(r.stdout.trim());
}
function attest(){
  ensure(process.env.GITHUB_RUN_ATTEMPT==="1"&&shaRe.test(process.env.HEAD_SHA),"Immutable authorized attempt required");
  const id=process.env.SCENARIO,manifest=readFrozen(id);
  const dir=process.env.RUNNER_TEMP,source=dir+"/luna-candidate-proof/";
  const audit=JSON.parse(readFileSync(dir+"/luna-host-audit.json","utf8"));
  const proof=JSON.parse(readFileSync(source+manifest.proof,"utf8"));
  ensure(audit.head===process.env.HEAD_SHA&&audit.attempts>=1&&audit.attempts<=18&&
    audit.reservedMicros>0&&audit.reservedMicros<=180000&&
    audit.receipts?.length===audit.attempts&&
    audit.receipts.every(r=>r.terminal==="completed"&&r.model==="gpt-6-luna"&&
      Number.isSafeInteger(r.actualInputTokens)&&r.actualInputTokens>0&&
      Number.isSafeInteger(r.actualOutputTokens)&&r.actualOutputTokens>=0),"Provider identity or bounded paid receipt unverified");
  if(manifest.mode==="legacy"){
    const prefix="task"+id;
    copyFileSync(dir+"/luna-host-audit.json",dir+"/"+prefix+"-host-audit.json");
    mkdirSync(dir+"/"+prefix+"-candidate-proof",{recursive:true});
    copyFileSync(source+manifest.proof,dir+"/"+prefix+"-candidate-proof/"+manifest.proof);
    if(manifest.scope)copyFileSync(source+manifest.scope,dir+"/"+prefix+"-candidate-proof/"+manifest.scope);
    const r=spawnSync("node",["scripts/acceptance/luna-attest-"+id+".mjs"],{cwd:resolve("coordinator"),
      stdio:"inherit",env:{...process.env}});
    ensure(r.status===0,"Legacy host oracle failed");
    copyFileSync(dir+"/"+prefix+"-sanitized-result.json",dir+"/luna-sanitized-result.json");
    return;
  }
  ensure((proof.head_sha??proof.headSha)===process.env.HEAD_SHA&&
    (proof.status==="passed"||proof.passed===true)&&
    (proof.observed_model??proof.model)==="gpt-6-luna","Unverified generic live outcome");
  const scope=JSON.parse(readFileSync(source+manifest.scope,"utf8"));
  ensure(scope.expectedProviderCalls===audit.attempts,"Model quota/source mismatch");
  const observed=audit.receipts.flatMap(r=>Array.isArray(r.toolNames)?r.toolNames:[]);
  ensure(manifest.expectedTools.every(t=>observed.includes(t)),"Provider did not select claimed registered tools");
  const checks=manifest.assertions.map(a=>{
    const count=dbCount(a.table,a.where,scope);
    ensure(count>=a.minCount&&count<=a.maxCount,"Independent DB assertion failed: "+a.name);
    return {name:a.name,kind:a.kind,passed:true};
  });
  const safe={scenario:id,head:audit.head,provider:"openai_responses",model:"gpt-6-luna",
    attempts:audit.attempts,reservedUpperUSD:audit.reservedMicros/1_000_000,
    providerSelectedTools:[...new Set(observed)].sort(),
    independentDatabaseReadbacks:checks,realModelAndDatabaseProof:true,
    independentOwnerUIAttestation:false,fullTask17IntegrationProof:false,
    note:"Scenario assertions are defined in the reviewed candidate PR; host independently executes SQL readbacks."};
  writeFileSync(dir+"/luna-sanitized-result.json",JSON.stringify(safe,null,2)+"\n",{mode:0o600,flag:"wx"});
}
if(process.argv[1]&&import.meta.url===new URL("file://"+resolve(process.argv[1])).href){
  const cmd=process.argv[2];
  if(cmd==="plan")await plan();
  else if(cmd==="candidate")await candidate();
  else if(cmd==="attest")attest();
  else if(cmd==="validate-all")validateAll();
  else if(cmd==="freeze")freeze();
  else throw Error("Unknown trusted Luna command");
}
