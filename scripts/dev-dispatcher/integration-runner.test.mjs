import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeMainIntegration} from './integration-runner.mjs';
const sha='a'.repeat(40), repo='owner/cafe';
function fixture(){
 const cwd=mkdtempSync(join(tmpdir(),'aicafe-main-'));
 mkdirSync(join(cwd,'scripts'));
 writeFileSync(join(cwd,'scripts/proof.test.mjs'),"import test from 'node:test';test('ok',()=>{});\n");
 const evidence={task_id:'6',head_sha:'old',base_sha:'old-base',acceptance:[
  {id:'1',command:'node --test scripts/proof.test.mjs',test_file:'scripts/proof.test.mjs',result:'passed'}]};
 const pr={merged_at:'2026-11-01',merge_commit_sha:sha,body:'<!-- aicafe-acceptance-evidence '+JSON.stringify(evidence)+' -->'};
 const queue={tasks:[{id:'6',architecture_approval:{approved:true},acceptance:['one accepted scenario']}]};
 return {cwd,pr,queue,cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
}
test('merged-main proof reruns each acceptance file and strips token from test child',async()=>{
 const f=fixture();try{
  const calls=[];
  const proof=await executeMainIntegration({sha,repo,token:'private-example',runId:'24',
   cwd:f.cwd,queue:f.queue,output:join(f.cwd,'integration-proof.json'),
   fetchFn:async()=>({ok:true,json:async()=>[f.pr]}),
   invoke:(bin,args,options)=>{calls.push({bin,args,options});return {status:0};}});
  assert.equal(proof.skipped,false);
  assert.equal(proof.proof.head_sha,sha);
  assert.equal(proof.proof.run_id,24);
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.env.GITHUB_TOKEN,undefined);
 }finally{f.cleanup();}
});
test('unassociated PR skips safely and missing approved scenario proof fails closed',async()=>{
 const f=fixture();try{
  const base={sha,repo,token:'private-example',runId:'24',cwd:f.cwd,queue:f.queue};
  const absent=await executeMainIntegration({...base,fetchFn:async()=>({ok:true,json:async()=>[]})});
  assert.equal(absent.reason,'no_merged_pr');
  await assert.rejects(executeMainIntegration({...base,queue:{tasks:[]},
   fetchFn:async()=>({ok:true,json:async()=>[f.pr]})}),/approved acceptance/);
 }finally{f.cleanup();}
});
