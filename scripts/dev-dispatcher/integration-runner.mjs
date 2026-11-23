#!/usr/bin/env node
import {settings} from './settings.mjs';
// After a squash merge, rerun the merged PR's acceptance tests on exact main SHA.
// No author-supplied "passed" flag is trusted; every declared test is executed.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseEvidence,executeEvidence} from './acceptance-runner.mjs';

export async function executeMainIntegration({sha,repo,token,runId=process.env.GITHUB_RUN_ID,
  cwd=process.cwd(),fetchFn=fetch,invoke=spawnSync,
  queue=JSON.parse(readFileSync(resolve(cwd,settings.queue.path),'utf8')),
  output=resolve(process.env.RUNNER_TEMP||cwd,'integration-proof.json')}={}){
 const recordSkip=(reason)=>{
  const status=reason==='no_merged_pr'?'NOT_APPLICABLE':'NOT_PROVEN';
  const summary={version:1,head_sha:sha,merge_sha:sha,run_id:runId?Number(runId):null,
   capability_acceptance:status,reason,proof_executed:false};
  writeFileSync(output,JSON.stringify(summary)+'\n',{mode:0o600});
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
   '\n### AI CAFE capability integration: '+status+'\n\n'+reason+
   ' (no executed capability proof; green regression checks do not change this).\n');
  return {skipped:true,reason,summary};
 };
 if(!/^[a-f0-9]{40}$/.test(sha||'')||!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!token)
  throw Error('Missing trusted main SHA/repository/token');
 const response=await fetchFn('https://api.github.com/repos/'+repo+'/commits/'+sha+'/pulls',{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
   'X-GitHub-Api-Version':'2022-11-28'}});
 if(!response.ok)throw Error('Cannot verify associated merged PR: '+response.status);
 const prs=await response.json();
 if(!Array.isArray(prs)||prs.length>100)throw Error('Ambiguous merged PR listing');
 const matching=prs.filter(pr=>pr.merged_at&&pr.merge_commit_sha===sha);
 if(matching.length===0)return recordSkip('no_merged_pr');
 if(matching.length!==1)throw Error('Ambiguous merged PR for main SHA');
 const meta=parseEvidence(matching[0].body);
 if(!meta)return recordSkip('no_acceptance_evidence');
 const task=queue.tasks?.find(t=>t.id===meta.task_id && t.architecture_approval?.approved===true);
 if(!task||!Array.isArray(task.acceptance)||task.acceptance.length!==meta.acceptance.length)
  throw Error('Merged task has no matching approved acceptance criteria');
 const body='<!-- '+settings.naming.marker_prefix+'-acceptance-evidence '+JSON.stringify({...meta,head_sha:sha,base_sha:sha})+' -->';
 // The trusted main runner needs a GitHub token to read PR metadata; test processes do not.
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>
  !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i.test(k)));
 const result=executeEvidence({event:{pull_request:{head:{sha},base:{sha},body}},
  cwd,runId,output,invoke:(bin,args,options)=>invoke(bin,args,{...options,env})});
 if(result.skipped)return recordSkip('no_scenario_proof');
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '\n### AI CAFE capability integration: EXECUTED\n\n'+
  result.proof.acceptance.length+' approved scenarios rerun on exact merged main. '+
  'This is not a real-model or production release proof.\n');
 return {...result,reason:'main_acceptance_executed'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 executeMainIntegration({sha:process.env.TARGET_MAIN_SHA || process.env.GITHUB_SHA,repo:process.env.GITHUB_REPOSITORY,
  token:process.env.GITHUB_TOKEN})
  .then(r=>console.log(r.skipped?'No capability proof: '+r.reason:
    'Reran '+r.proof.acceptance.length+' merged-task scenarios on main'))
  .catch(e=>{console.error(e.message);process.exitCode=1;});
}
