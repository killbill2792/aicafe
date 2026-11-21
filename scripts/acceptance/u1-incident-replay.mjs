import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,resolve,join} from "node:path";
import {pathToFileURL} from "node:url";

export const historicalRefs=[
 "2c7c7a905a7581db63c668eac92e77189e91e2f4",
 "7fdcaafa977504db999f976c139be7a6374d1802",
 "e81c6ac4cec774d5ae1157d75022a291ba55eb91",
];
const missingDateName="does not ask for an unrequested year of sales after today's closed day is missing";
export function extractIncidentFixture(source){
 const first=source.indexOf('describe("recorded Responses streaming fixtures"');
 const start=source.indexOf('describe("U1 incident regression:');
 const timing=source.indexOf('describe("U1 controlled incident timing fixture');
 if(first<=0||start<=first||timing<=start||!source.includes(missingDateName))throw Error("U1 fixture boundaries missing");
 // This is the approved same recorded provider fixture, without copying or
 // modifying any historical runtime sources.
 return source.slice(0,first)+source.slice(start);
}
export function evaluateReplay(report,expectOldDefect){
 const cases=report.testResults?.flatMap(file=>file.assertionResults??[])??[];
 if(cases.length!==4)throw Error("Expected all four matched incident assertions");
 const missing=cases.find(t=>t.title===missingDateName);
 if(!missing)throw Error("Missing historical date regression");
 const other=cases.filter(t=>t!==missing);
 if(other.some(t=>t.status!=="passed"))throw Error("Non-target incident regression failed: "+other.filter(t=>t.status!=="passed").map(t=>t.title).join("; "));
 if(expectOldDefect){
  if(missing.status!=="failed"||!(missing.failureMessages??[]).some(s=>s.includes("expected false to be true")))
   throw Error("Old ref must reproduce the exact year-scan assertion, not an unrelated failure");
 }else if(missing.status!=="passed")throw Error("Candidate did not remove the unsolicited history scan");
 return {tests:cases.length,expectedYearScanFailure:expectOldDefect,passed:cases.filter(t=>t.status==="passed").length};
}
function command(cwd,bin,args,{timeout=120000,allowFailure=false}={}){
 const result=spawnSync(bin,args,{cwd,encoding:"utf8",timeout,maxBuffer:16*1024*1024,
  env:{...process.env,OPENAI_API_KEY:"",SUPERVISOR_PRIVATE_TRACE_ENABLED:"false",SUPERVISOR_DEBUG_RAW_LOGGING:"false"}});
 if(result.error||(!allowFailure&&result.status!==0))throw Error(bin+" failed: "+(result.error?.message??result.stderr?.slice(-1800)??result.status));
 return result;
}
export function runReplay(root){
 const git=(args,options)=>command(root,"git",args,options).stdout.trim();
 const head=git(["rev-parse","HEAD"]);
 if(!/^[0-9a-f]{40}$/.test(head))throw Error("Invalid checkout head");
 const fixture=extractIncidentFixture(readFileSync(join(root,"lib/ai/agent/loop.server.test.ts"),"utf8"));
 const scratch=mkdtempSync(join(tmpdir(),"aicafe-u1-replay-"));
 const receipt=[];
 const originalLock=readFileSync(join(root,"package-lock.json"),"utf8");
 try{
  for(const [index,ref] of [...historicalRefs,head].entries()){
   const dir=join(scratch,"ref-"+index);
   if(command(root,"git",["cat-file","-e",ref+"^{commit}"],{allowFailure:true}).status!==0)
    git(["fetch","--no-tags","--depth=1","origin",ref],{timeout:90000});
   git(["worktree","add","--detach",dir,ref]);
   try{
    if(command(dir,"git",["rev-parse","HEAD"]).stdout.trim()!==ref)throw Error("Historical source mismatch");
    // Never silently change historical dependency versions.
    if(readFileSync(join(dir,"package-lock.json"),"utf8")===originalLock)
     symlinkSync(join(root,"node_modules"),join(dir,"node_modules"),"dir");
    else command(dir,"npm",["ci","--ignore-scripts","--no-audit","--no-fund"],{timeout:180000});
    const file=join(dir,"lib/ai/agent/u1HistoricalReplay.test.ts");
    writeFileSync(file,fixture,{flag:"wx"});
    const reportPath=join(scratch,"report-"+index+".json");
    const result=command(dir,process.execPath,[join(dir,"node_modules/vitest/vitest.mjs"),"run","lib/ai/agent/u1HistoricalReplay.test.ts","--reporter=json","--outputFile",reportPath],{timeout:90000,allowFailure:true});
    if(!existsSync(reportPath))throw Error("Historical fixture did not execute: "+result.stderr?.slice(-1500));
    const expectedOld=index<2;
    if(result.status!==(expectedOld?1:0))throw Error("Unexpected replay process exit for "+ref);
    const checked=evaluateReplay(JSON.parse(readFileSync(reportPath,"utf8")),expectedOld);
    receipt.push({ref,...checked});
    console.log("U1_MATCHED_REPLAY "+JSON.stringify(receipt.at(-1)));
   }finally{git(["worktree","remove","--force",dir]);}
  }
 }finally{rmSync(scratch,{recursive:true,force:true});}
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 runReplay(resolve(dirname(process.argv[1]),"../.."));
