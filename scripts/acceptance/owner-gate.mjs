#!/usr/bin/env node
/* Required Task 17a no-secret owner-domain acceptance on exact PR heads.
 * Live Luna quality is separate and is never inferred from this job. */
import {execFileSync,spawnSync} from "node:child_process";
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {parseNameStatus} from "../e2e/targeted.mjs";

export const SUITES=Object.freeze({
 supervisor:["lib/ai/agent/loop.server.test.ts","lib/ai/agent/tools/dataQuery.registered.test.ts"],
 inventory:["lib/ai/agent/tools/purchases.test.ts","lib/inventory/recordPurchases.server.test.ts"],
 staffing:["lib/ai/agent/tools/staffProposals.test.ts","lib/ai/supervisor/loop/staffProposals.partialWages.test.ts"],
 gmail:["lib/ai/agent/tools/gmail.test.ts","lib/connectors/gmail/oauth.test.ts","app/api/connectors/gmail/routes.test.ts"],
 routines:["lib/ai/agent/tools/routines.test.ts","lib/ai/supervisor/routines/dispatch.test.ts"],
 memory:["lib/ai/agent/memory.test.ts","lib/ai/agent/persist.memory.test.ts"],
 pos:["lib/ai/agent/tools/dataQuery.pos0e.test.ts","lib/ai/agent/tools/dataQuery.registered.test.ts"],
 acceptance:["scripts/acceptance/owner-gate.test.mjs"]
});
export const DOMAINS=Object.freeze(Object.keys(SUITES));
const sha=x=>typeof x==="string"&&/^[a-f0-9]{40}$/.test(x);
const fail=msg=>{throw Error("owner_acceptance:"+msg);};
const includes=(p,re)=>re.test(p.toLowerCase());

/** Map actual changed paths to canonical owner domains, including test-only edits.
 * New, unknown external connectors MUST get an explicit domain contract. */
export function domainsForPaths(paths){
 if(!Array.isArray(paths)||paths.some(p=>typeof p!=="string"||!p||p.includes("\0")))fail("invalid_changed_paths");
 const found=new Set();
 for(const p of paths){
  const sharedConnector=/^lib\/connectors\/(?:crypto|registry)(?:\.server|\.test)?\.[cm]?[jt]s$/.test(p);
  if(/^lib\/connectors\/|^app\/api\/connectors\//.test(p) &&
     !includes(p,/gmail/)&&!sharedConnector)
   fail("unknown_connector_contract");
  if(sharedConnector)found.add("gmail");
  if(/^scripts\/acceptance\/|^evals\/acceptance\/|^\.github\/workflows\/ai-cafe-pr-baseline\.yml$/.test(p))
   found.add("acceptance");
  const app=/^(?:app\/api\/|app\/\[locale\]\/|components\/)/.test(p);
  const backend=/^(?:lib\/|supabase\/migrations\/)/.test(p);
  if(!app&&!backend)continue;
  const seenBefore=found.size;
  if(/^lib\/ai\/|^app\/api\/ai\/|^components\/home\/Supervisor|^supabase\/migrations\//.test(p))found.add("supervisor");
  if(includes(p,/gmail/))found.add("gmail");
  if(includes(p,/inventor|pantry|purchas|receipt|suppl|recipe|attach|fileevidence/))found.add("inventory");
  if(includes(p,/staff|schedul|labor|shift|availability|demand|olivia/))found.add("staffing");
  if(includes(p,/routine|morning.?brief|briefing|proactive/))found.add("routines");
  if(includes(p,/memory|ownerfact|savedfact/))found.add("memory");
  if(includes(p,/toast|pos0|dataquery|canonical|menu|orders|sales/))found.add("pos");
  // All other business data / API changes receive a general Supervisor regression.
  if(/^lib\/(?:calc|data|actions|operating)\/|^app\/api\/|^supabase\/migrations\//.test(p)
     && found.size===seenBefore)found.add("supervisor");
 }
 return DOMAINS.filter(d=>found.has(d));
}
/** Same original baseline change categories; computed from local Git instead
 * of the rate-limited GitHub pull-request listFiles API. */
export function classifyBaselinePaths(paths){
 if(!Array.isArray(paths)||!paths.length)fail("empty_pull_request_diff");
 const docs=p=>p.startsWith("docs/")||p.endsWith(".md")||p.startsWith(".github/ISSUE_TEMPLATE/");
 const e2e=p=>p.startsWith("e2e/")||p.startsWith("tests/e2e/")||
  /(?:\.e2e\.|\.spec\.)/.test(p)||p.startsWith("playwright.config.")||
  /^scripts\/[^/]*(?:visual|screenshots)/.test(p)||
  /^\.github\/workflows\/[^/]*(?:visual|screenshots)\.yml$/.test(p);
 const code=paths.some(p=>!docs(p)),supervisor=paths.some(p=>p.startsWith("lib/ai/"));
 const hasE2e=paths.some(e2e),hasDocs=paths.some(docs);
 return {code,e2e:hasE2e,supervisor,"docs-only":hasDocs,"non-docs":code};
}
function classifyForGithub(){
 if(process.env.GITHUB_EVENT_NAME!=="pull_request")fail("classify_pr_only");
 const files=changedPaths(process.env.BASE_SHA,process.env.HEAD_SHA);
 const values=classifyBaselinePaths(files);
 if(!process.env.GITHUB_OUTPUT)fail("github_output_required");
 appendFileSync(process.env.GITHUB_OUTPUT,
  Object.entries(values).map(([key,value])=>key+"="+value+"\n").join(""));
 console.log("Git-local baseline changed paths:",JSON.stringify(values));
}

export function selectedFiles(domains){
 if(!Array.isArray(domains)||!domains.length||new Set(domains).size!==domains.length||
    domains.some(d=>!DOMAINS.includes(d)))fail("invalid_domains");
 return [...new Set(domains.flatMap(d=>SUITES[d]))].sort();
}
export function validateReport(report,files){
 if(!report||!Array.isArray(report.testResults)||!Number.isSafeInteger(report.numTotalTests)||
    report.numTotalTests<files.length||report.numPassedTests!==report.numTotalTests||
    report.numFailedTests!==0||report.numPendingTests!==0||report.numTodoTests!==0)
   fail("vitest_missing_failed_or_skipped");
 const observed=report.testResults;
 for(const file of files){
  const row=observed.find(r=>typeof r.name==="string"&&(r.name.replaceAll("\\","/")===file||r.name.replaceAll("\\","/").endsWith("/"+file)));
  if(!row||row.status!=="passed"||!Array.isArray(row.assertionResults)||
     row.assertionResults.length===0||row.assertionResults.some(t=>t.status!=="passed"))
   fail("vitest_file_not_executed_"+file.replaceAll("/","_"));
 }
 return {passed:report.numPassedTests,files:files.length};
}
export function validateTap(output){
 const value=k=>Number(output.match(new RegExp("(?:^|\\n)# "+k+" (\\d+)(?:\\n|$)"))?.[1]);
 const count=value("tests"),passed=value("pass");
 if(!Number.isSafeInteger(count)||count<1||passed!==count||value("fail")!==0||
    value("skipped")!==0||value("cancelled")!==0||value("todo")!==0)
  fail("node_tests_missing_failed_or_skipped");
 return count;
}
export function validateProof(proof,{head,domains}){
 if(!sha(head)||proof?.schema_version!==1||proof.head_sha!==head||
    proof.status!=="passed"||proof.provider_model_proof!==false||
    JSON.stringify(proof.domains)!==JSON.stringify(domains)||!Array.isArray(proof.files)||
    proof.files.length===0||!Number.isSafeInteger(proof.executed_tests)||proof.executed_tests<1)
  fail("invalid_or_wrong_head_proof");
 const expected=selectedFiles(domains);
 if(JSON.stringify(proof.files)!==JSON.stringify(expected))fail("missing_required_suite");
 return proof;
}
const git=(...args)=>execFileSync("git",args,{encoding:"utf8"}).trim();
function changedPaths(base,head){
 if(!sha(base)||!sha(head))fail("missing_exact_base_head");
 const ancestor=git("merge-base",base,head);
 const raw=execFileSync("git",["diff","--name-status","-z","-M",ancestor,head,"--"]);
 return parseNameStatus(raw);
}
function runCommand(bin,args,options){
 const result=spawnSync(bin,args,{encoding:"utf8",maxBuffer:16*1024*1024,...options});
 if(result.error||result.status!==0){
  process.stdout.write((result.stdout??"").slice(-2500));
  process.stderr.write((result.stderr??"").slice(-2500));
  fail("required_test_command_failed");
 }
 return result.stdout??"";
}
export function selection({eventName,base,head,paths}){
 if(!sha(head))fail("missing_exact_head");
 const domains=eventName==="workflow_dispatch"?DOMAINS:
  eventName==="pull_request"?domainsForPaths(paths??changedPaths(base,head)):
  fail("unsupported_event");
 return {head,domains,files:domains.length?selectedFiles(domains):[]};
}
function main(){
 const action=process.argv[2];
 if(action==="classify"){classifyForGithub();return;}
 if(action!=="run"&&action!=="verify")fail("usage_classify_run_or_verify");
 const root=realpathSync(process.cwd()),head=process.env.HEAD_SHA;
 if(!sha(head)||git("rev-parse","HEAD")!==head)fail("checkout_head_mismatch");
 const plan=selection({eventName:process.env.GITHUB_EVENT_NAME,
  base:process.env.BASE_SHA,head});
 const proofPath=resolve(root,"test-results/acceptance/owner-journey-proof.json");
 if(action==="verify"){
  const proof=JSON.parse(readFileSync(proofPath,"utf8"));
  if(!plan.domains.length){
   if(proof?.status!=="not_applicable"||proof.head_sha!==head||proof.executed_tests!==0)
    fail("invalid_n_a_proof");
  }else validateProof(proof,{head,domains:plan.domains});
  console.log("Owner journey acceptance proof verified:",proof.status,head);
  return;
 }
 const reportPath=resolve(root,"test-results/acceptance/domain-vitest.json");
 mkdirSync(dirname(proofPath),{recursive:true});
 let executed=0;
 if(plan.files.length){
  for(const file of plan.files){
   const full=resolve(root,file);
   if(!full.startsWith(root+sep)||!existsSync(full)||realpathSync(full)!==full)
    fail("required_test_file_missing_"+file.replaceAll("/","_"));
  }
  const nodeFiles=plan.files.filter(p=>p.endsWith(".mjs"));
  const vitestFiles=plan.files.filter(p=>!p.endsWith(".mjs"));
  if(nodeFiles.length)executed+=validateTap(runCommand(process.execPath,["--test",...nodeFiles]));
  if(vitestFiles.length){
   runCommand(resolve(root,"node_modules/.bin/vitest"),
    ["run",...vitestFiles,"--reporter=json","--outputFile="+reportPath]);
   executed+=validateReport(JSON.parse(readFileSync(reportPath,"utf8")),vitestFiles).passed;
  }
 }
 const proof={schema_version:1,head_sha:head,base_sha:process.env.BASE_SHA??null,
  status:plan.files.length?"passed":"not_applicable",domains:plan.domains,
  files:plan.files,executed_tests:executed,provider_model_proof:false,
  scope:"deterministic_registered_domain_regression_not_live_luna"};
 writeFileSync(proofPath,JSON.stringify(proof,null,2)+"\n",{mode:0o600});
 if(plan.files.length)validateProof(proof,{head,domains:plan.domains});
 console.log("Owner journey acceptance:",JSON.stringify(proof));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{main()}catch(err){console.error(err instanceof Error?err.message:"owner_acceptance:unexpected");process.exitCode=1;}
}
