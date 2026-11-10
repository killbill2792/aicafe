#!/usr/bin/env node
// One-shot helper for the EXISTING Muse courier. Repairs GitHub attribution of
// an existing receipt; NEVER sends a browser instruction or invents a receipt.
import {createHash} from 'node:crypto';
import {validTarget} from './bridge.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repairable=new Set(['unattributed_git_actor','unapproved_git_actor','assignment_receipt_missing']);
const MAX=5;
export async function reattestMuseReceipts({repo,token,fetchFn=fetch,now=new Date().toISOString(),
  configuredActors=null}={}){
  if(!repoPattern.test(repo||'')||!token)throw Error('Private repo and existing Muse token required');
  const headers={Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
    'X-GitHub-Api-Version':'2022-11-28'};
  async function api(path,options={}){
    const res=await fetchFn('https://api.github.com'+path,{
      ...options,headers:{...headers,...(options.headers||{})}});
    if(!res.ok)throw Error('GitHub receipt API HTTP '+res.status);
    return res.json();
  }
  const identity=await api('/user');
  const login=identity?.login;
  if(typeof login!=='string'||!login)throw Error('Token has no authenticated GitHub user');
  if(configuredActors && configuredActors[login]!=='muse')
    throw Error('Authenticated token is not mapped to Muse courier');
  const info=await api('/repos/'+repo);
  if(info.private!==true)throw Error('Refusing to read or write a public receipt repository');
  const file=await api('/repos/'+repo+'/contents/dispatcher/state.json?ref=main');
  if(typeof file.content!=='string')throw Error('Missing private ledger');
  const state=JSON.parse(Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8'));
  if(state.version!==1||!state.actions||!state.tasks||!state.receipt_feedback)
    throw Error('Invalid private receipt state');
  const jobs=Object.entries(state.receipt_feedback)
    .filter(([,f])=>f.status==='rejected'&&repairable.has(f.code)).slice(0,MAX);
  const results=[];
  for(const [actionId,feedback] of jobs){
    const action=state.actions[actionId],task=state.tasks[feedback.task_id];
    const d=action?.delivery;
    const safeResult=(status)=>({action_id:actionId,status});
    // Never restore a closed, revoked or superseded task, and never infer a
    // browser submission from a missing receipt.
    if(!action||!task||action.task_id!==feedback.task_id||
      action.delivery_owner!=='muse'||!task.approved||task.github_state!=='open'||
      !Number.isInteger(task.pr_number)||
      (d?.intent==='start_new_chat'&&task.conversation_ref)||
      (d?.intent==='continue_existing_chat'&&!task.conversation_ref)||
      action.status==='submitted'||action.receipt||
      !['planned','cancelled_stale_head'].includes(action.status)){
      results.push(safeResult('ineligible'));continue;
    }
    if(!d||typeof d.prompt!=='string'||typeof d.prompt_hash!=='string'||
      sha(d.prompt)!==d.prompt_hash||d.approval_hash!==task.approval_hash||
      d.action_id!==actionId||d.task_id!==action.task_id){
      results.push(safeResult('identity_mismatch'));continue;
    }
    const name=sha(actionId+':'+d.prompt_hash)+'.json';
    const path='dispatcher/receipts/'+name;
    let original;
    try{original=await api('/repos/'+repo+'/contents/'+path+'?ref=main');}
    catch{results.push(safeResult('original_receipt_missing'));continue;}
    if(!original.sha||typeof original.content!=='string'||original.content.length>40000){
      results.push(safeResult('original_receipt_invalid'));continue;
    }
    let receipt;
    try{receipt=JSON.parse(Buffer.from(original.content.replace(/\s/g,''),'base64').toString('utf8'));}
    catch{results.push(safeResult('original_receipt_invalid'));continue;}
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)){
      results.push(safeResult('original_receipt_invalid'));continue;
    }
    const project=receipt.project?.id||receipt.project_id;
    if(receipt.action_id!==actionId||receipt.prompt_hash!==d.prompt_hash||
      receipt.approval_hash!==d.approval_hash||receipt.provider!==d.provider||
      project!==d.project?.id||
      !validTarget(d.provider,receipt.conversation_url)||
      (d.intent==='continue_existing_chat'&&
       (receipt.conversation_url!==d.conversation_url||
        receipt.conversation_url!==task.conversation_ref))||
      (receipt.status&&receipt.status!=='submitted')||
      (receipt.intent&&receipt.intent!==d.intent)){
      results.push(safeResult('receipt_validation_failed'));continue;
    }
    const meta=await api('/repos/'+repo+'/commits?path='+encodeURIComponent(path)+'&per_page=1');
    if(meta?.[0]?.author?.login===login){
      results.push(safeResult('already_attributed'));continue;
    }
    const latest=meta?.[0];
    if(latest?.commit?.message?.startsWith('chore(muse): reattest original receipt') &&
      Date.parse(now)-Date.parse(latest.commit?.committer?.date||'')<3600000){
      results.push(safeResult('previous_attestation_unverified'));continue;
    }
    // Same action, same URL, same hashes. Only a harmless audit stamp changes.
    const amended={...receipt,reconfirmed_at:now};
    await api('/repos/'+repo+'/contents/'+path,{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({branch:'main',sha:original.sha,
        message:'chore(muse): reattest original receipt via GitHub identity',
        content:Buffer.from(JSON.stringify(amended,null,2)+'\n').toString('base64')})
    });
    const check=await api('/repos/'+repo+'/commits?path='+encodeURIComponent(path)+'&per_page=1');
    results.push(safeResult(check?.[0]?.author?.login===login
      ? 'reattributed_waiting_for_dispatcher' : 'git_actor_still_unattributed'));
  }
  return {authenticated_login:login,checked:jobs.length,results};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const actors=Object.fromEntries((process.env.DISPATCH_COURIER_ACTORS||'')
    .split(',').filter(Boolean).map(x=>x.split('=')));
  reattestMuseReceipts({
    repo:process.env.DISPATCH_LEDGER_REPO,
    token:process.env.MUSE_GITHUB_TOKEN||process.env.GH_TOKEN,
    configuredActors:Object.keys(actors).length?actors:null
  }).then(x=>{
    // No private paths, receipts, chat URLs or GitHub tokens in stdout.
    console.log('Receipt repairs inspected: '+x.checked);
    for(const r of x.results)console.log('Action status: '+r.status);
  }).catch(e=>{console.error('Muse receipt repair blocked: '+e.message);process.exitCode=1;});
}
