import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acceptanceDigest,parseEvidence,executeEvidence} from './acceptance-runner.mjs';
function fixture(){
 const cwd=mkdtempSync(join(tmpdir(),'aicafe-acceptance-'));
 mkdirSync(join(cwd,'scripts'));
 writeFileSync(join(cwd,'scripts/proof.test.mjs'),"import test from 'node:test'; test('true',()=>{});\n");
 const row={id:'1',test_file:'scripts/proof.test.mjs',command:'node --test scripts/proof.test.mjs',result:'passed'};
 const evidence={task_id:'6',head_sha:'head',base_sha:'base',acceptance:[row]};
 const event={pull_request:{head:{sha:'head'},base:{sha:'base'},
   body:'<!-- aicafe-acceptance-evidence '+JSON.stringify(evidence)+' -->'}};
 return {cwd,row,evidence,event,cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
}
test('executes allowed exact test and writes bound head/base digest',()=>{
 const f=fixture();try{
  const calls=[];
  const r=executeEvidence({event:f.event,cwd:f.cwd,runId:'10',output:join(f.cwd,'proof.json'),
   invoke:(bin,args,options)=>{calls.push({bin,args,options});return {status:0};}});
  assert.equal(r.proof.acceptance_digest,acceptanceDigest([f.row]));
  assert.equal(r.proof.run_id,10);
  assert.deepEqual(calls[0].args,['--test','scripts/proof.test.mjs']);
  assert.equal(calls[0].options.shell,false);
 }finally{f.cleanup();}
});
test('rejects changed SHA, arbitrary commands and failed assertions',()=>{
 const f=fixture();try{
  const changed={...f.event,pull_request:{...f.event.pull_request,head:{sha:'different'}}};
  assert.throws(()=>executeEvidence({event:changed,cwd:f.cwd,runId:'2'}),/Unverified/);
  const malicious={...f.evidence,acceptance:[{...f.row,command:'node --test scripts/proof.test.mjs; echo unsafe'}]};
  const event={pull_request:{...f.event.pull_request,body:'<!-- aicafe-acceptance-evidence '+JSON.stringify(malicious)+' -->'}};
  assert.throws(()=>executeEvidence({event,cwd:f.cwd,runId:'2'}),/allowlisted/);
  assert.throws(()=>executeEvidence({event:f.event,cwd:f.cwd,runId:'2',invoke:()=>({status:1})}),/failed/);
 }finally{f.cleanup();}
});
test('missing and multiple evidence records never produce proof',()=>{
 const f=fixture();try{
  assert.equal(parseEvidence('no marker'),null);
  assert.equal(parseEvidence(f.event.pull_request.body+f.event.pull_request.body),null);
  assert.equal(executeEvidence({event:{pull_request:{...f.event.pull_request,body:'no marker'}},cwd:f.cwd,runId:'2'}).skipped,true);
 }finally{f.cleanup();}
});
