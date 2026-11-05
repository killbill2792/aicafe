/**
 * Fail-closed Promptfoo CLI with concise assertion diagnostics. All outputs are
 * synthetic, and the temporary JSON is removed without publishing artifacts.
 */
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const dir=mkdtempSync(join(tmpdir(),"aicafe-supervisor-eval-"));
const file=join(dir,"results.json");
try{
  const bin=process.platform==="win32"?"node_modules/.bin/promptfoo.cmd":"node_modules/.bin/promptfoo";
  const cmd=spawnSync(bin,["eval","--config","evals/supervisor/promptfooconfig.yaml",
    "--no-cache","--no-share","--output",file],{stdio:"inherit",env:process.env});
  try{
    const report=JSON.parse(readFileSync(file,"utf8"));
    const rows=report.results?.results??[];
    for(const row of rows){
      if(row.success)continue;
      const id=row.testCase?.vars?.caseId??row.test?.vars?.caseId??"unknown";
      const failures=row.gradingResult?.componentResults?.filter(x=>x.pass===false)??[];
      console.error("EVAL_FAIL "+id+" "+JSON.stringify({
        reason:row.gradingResult?.reason??row.error??null,
        assertions:failures.map(x=>x.reason),
        unverified:(()=>{try{return JSON.parse(row.response?.output??"{}").unverified??[]}catch{return []}})()
      }).slice(0,850));
    }
  }catch(error){
    console.error("Eval report unavailable: "+(error instanceof Error?error.message:"unknown"));
  }
  if(cmd.error)throw cmd.error;
  if(cmd.status!==0)process.exitCode=cmd.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
