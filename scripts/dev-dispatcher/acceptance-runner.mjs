#!/usr/bin/env node
// Trusted-main runner: execute exactly the named test files without a shell.
import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const testPath=/^(?:tests|e2e|lib|app|scripts)\/[a-zA-Z0-9_./-]+\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
export const acceptanceDigest=rows=>createHash('sha256').update(JSON.stringify(rows.map(({id,command,test_file})=>({id,command,test_file})))).digest('hex');
export function parseEvidence(body){
 if(typeof body!=='string'||body.length>100000)return null;
 const found=[...body.matchAll(/<!-- aicafe-acceptance-evidence\s*([\s\S]*?)\s*-->/g)];
 if(found.length!==1||found[0][1].length>20000)return null;
 try{const value=JSON.parse(found[0][1]);return Array.isArray(value?.acceptance)?value:null;}catch{return null;}
}
export function executeEvidence({event,cwd=process.cwd(),runId=process.env.GITHUB_RUN_ID,output=resolve(process.env.RUNNER_TEMP||cwd,'acceptance-proof.json'),invoke=spawnSync}={}){
 const pr=event?.pull_request;if(!pr)throw Error('PR event required');
 const evidence=parseEvidence(pr.body);if(!evidence)return {skipped:true};
 const rows=evidence.acceptance;
 if(evidence.head_sha!==pr.head?.sha||evidence.base_sha!==pr.base?.sha||
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(evidence.task_id||'')||
  !rows.length||rows.length>40||!runId)throw Error('Unverified task/head/base');
 for(const [i,item] of rows.entries()){
  const file=item?.test_file;
  if(item.id!==String(i+1)||item.result!=='passed'||typeof file!=='string'||
    !testPath.test(file)||file.includes('..'))throw Error('Invalid acceptance row');
  const full=resolve(cwd,file);
  if(!full.startsWith(resolve(cwd)+sep)||!lstatSync(full).isFile()||realpathSync(full)!==full)
   throw Error('Untrusted acceptance test path');
  const nodeTest=/\.[cm]?js$/.test(file);
  const command=(nodeTest?'node --test ':'npx vitest run ')+file;
  if(item.command!==command)throw Error('Acceptance command not allowlisted');
  const bin=nodeTest?process.execPath:resolve(cwd,'node_modules/.bin/vitest');
  const args=nodeTest?['--test',file]:['run',file];
  const result=invoke(bin,args,{cwd,stdio:'inherit',shell:false});
  if(result.error||result.status!==0)throw Error('Acceptance '+item.id+' failed');
 }
 const proof={version:1,task_id:evidence.task_id,run_id:Number(runId),head_sha:evidence.head_sha,
  base_sha:evidence.base_sha,acceptance_digest:acceptanceDigest(rows),
  acceptance:rows.map(({id,command,test_file})=>({id,command,test_file,result:'passed'}))};
 writeFileSync(output,JSON.stringify(proof)+'\n',{mode:0o600});
 return {skipped:false,proof};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const result=executeEvidence({event});
  console.log(result.skipped?'No acceptance marker; no proof produced':
   'Executed '+result.proof.acceptance.length+' accepted scenarios');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
