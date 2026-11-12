import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubFacts } from './github.mjs';
import { GitHubLedger } from './ledger.mjs';
import { decideNudge, reconcileGithub } from './core.mjs';
import { approvalSignature, approvalMatches, createDelivery } from './delivery.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mergeApprovedPr } from './effects.mjs';

const task = {
  id:'6', title:'Task 6', goal:'Keep signed permissions',
  state:'architecture_approved',
  architecture_approval:{approved:true},
  exclusive_files:['scripts/owned.mjs'],
  depends_on:[], brief:'docs/plans/universal-supervisor-task-briefs.md#task-6',
  acceptance:['run tests']
};
test('v2 approval excludes read-only uses but invalidates changed write scope', () => {
  const signed = approvalSignature(task);
  assert.match(signed,/^[0-9a-f]{64}$/);
  assert.equal(approvalSignature({...task,uses:['scripts/other.mjs']}),signed);
  assert.equal(approvalMatches({...task,uses:['scripts/other.mjs']},signed),true);
  assert.equal(approvalMatches({...task,exclusive_files:['scripts/new.mjs']},signed),false);
  assert.equal(approvalMatches({...task,edits:['scripts/other.mjs']},signed),false);
});
test('historical task-6 approval remains valid when only uses is added', async () => {
  const {createHash} = await import('node:crypto');
  const oldFields = [task.id,task.state,task.architecture_approval,task.exclusive_files,
    task.depends_on,task.title,task.goal,task.brief,task.acceptance];
  const signed=createHash('sha256').update(JSON.stringify(oldFields)).digest('hex');
  assert.equal(approvalMatches({...task,uses:['scripts/read-only.mjs']},signed),true);
  assert.equal(approvalMatches({...task,edits:['scripts/unsigned.mjs']},signed),false);
});
test('GitHub proof runs and jobs paginate beyond 100, retaining older exact proof',async()=>{
  const seen=[];
  const gh=new GitHubFacts({repo:'owner/repo',token:'test',fetchFn:async url=>{
    seen.push(url);
    const page=Number(new URL(url).searchParams.get('page'));
    const isJobs=url.includes('/jobs?');
    return {ok:true,json:async()=>isJobs
      ? {jobs:page===1?Array.from({length:100},(_,i)=>({id:i})): [{id:101,name:'Required merged-main integration checks'}]}
      : {workflow_runs:page===1?Array.from({length:100},(_,i)=>({id:i})): [{id:101,name:'AI CAFE Integration Proof'}]}};
  }});
  const runs=await gh.workflowRuns('ai-cafe-integration-proof.yml','branch=main');
  const jobs=await gh.workflowJobs(10);
  assert.equal(runs.length,101);
  assert.equal(jobs.length,101);
  assert.ok(seen.some(s=>s.includes('page=2')));
});
test('owner approved comment removes owner question hold even with stale label',async()=>{
  const gh=new GitHubFacts({repo:'owner/repo',token:'test'});
  const pr={number:11,labels:[{name:'needs-owner-decision'}],body:'<!-- aicafe-owner-question need decision -->',
    html_url:'https://github.com/owner/repo/pull/11',
    updated_at:'2026-11-10T10:00:00Z'};
  const comments=[{author_association:'OWNER',body:'Owner approved',created_at:'2026-11-10T10:01:00Z'}];
  assert.equal((await gh.ownerDecision(pr,comments)).question,null);
  assert.notEqual((await gh.ownerDecision(pr,[{...comments[0],body:'Still reviewing'}])).question,null);
});
test('parent_merged planned action keeps exact child head for courier validation',()=>{
  const source=readFileSync(new URL('./run.mjs',import.meta.url),'utf8');
  assert.match(source,/head_sha: rec\.head_sha \|\| null,/);
  assert.doesNotMatch(source,/head_sha: proposal\.action === 'parent_merged' \? null/);
});
test('dispatcher cron and Integration Proof completion wake are configured',()=>{
  const source=readFileSync(new URL('../../.github/workflows/ai-cafe-dev-dispatcher.yml',import.meta.url),'utf8');
  assert.match(source,/cron: '3\/5 \* \* \* \*'/);
  assert.match(source,/workflows: \[[^\n]*'AI CAFE Integration Proof'/);
});
test('PR-list mergeability must be confirmed by matching live detail SHA/base',async()=>{
  const head='a'.repeat(40),base='b'.repeat(40),calls=[];
  const pr={number:42,head:{sha:head,ref:'feat/check'},base:{sha:base,ref:'main'},
    draft:false,labels:[],body:'',updated_at:'2026-11-10T10:00:00Z'};
  const gh=new GitHubFacts({repo:'o/r',token:'dummy',fetchFn:async url=>{
    calls.push(url);
    let data;
    if(url.endsWith('/pulls/42'))data={...pr,mergeable:true};
    else if(url.includes('/check-runs?'))data={total_count:0,check_runs:[]};
    else if(url.includes('/reviews?'))data=[];
    else if(url.includes('/issues/42/comments?'))data=[];
    else if(url.includes('/commits/'+head))data={commit:{committer:{date:'2026-11-10T10:00:00Z'}}};
    else if(url.includes('/compare/'))data={behind_by:0,files:[]};
    else if(url.endsWith('/graphql'))data={data:{repository:{pullRequest:{
      reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}}}}};
    else throw Error('Unexpected '+url);
    return {ok:true,json:async()=>data};
  }});
  assert.equal((await gh.one(pr)).mergeable,true);
  assert.ok(calls.some(url=>url.endsWith('/pulls/42')));
});

test('later PR-body owner question is not cleared by approval of an older comment',async()=>{
  const gh=new GitHubFacts({repo:'owner/repo',token:'test'});
  const pr={number:20,labels:[{name:'needs-owner-decision'}],
    body:'<!-- aicafe-owner-question New question B -->',
    html_url:'https://github.com/owner/repo/pull/20',
    updated_at:'2026-11-10T11:00:00Z'};
  const comments=[
    {author_association:'COLLABORATOR',body:'<!-- aicafe-owner-question Question A -->',
      created_at:'2026-11-10T09:00:00Z'},
    {author_association:'OWNER',body:'Owner approved',
      created_at:'2026-11-10T10:00:00Z'}
  ];
  assert.equal((await gh.ownerDecision(pr,comments)).approved,undefined);
  assert.match((await gh.ownerDecision(pr,comments)).question,/New question B/);
});

test('stale branch update failure cannot create conflict work on a clean PR',()=>{
  const rec={task_id:'T',pr_number:405,github_state:'open',approved:true,
    conversation_ref:'https://chatgpt.com/c/test',head_sha:'a'.repeat(40),
    branch_maintenance_result:'update_failed_needs_coder',
    mergeable:true,mergeable_state:'clean',ci_state:'success',codex_state:'clean'};
  assert.equal(decideNudge(rec).reason,'no_coder_work');
  const state={version:1,tasks:{T:rec},actions:{}};
  const refreshed=reconcileGithub(state,[{...rec,pr_number:405,draft:false,
    base_sha:'b'.repeat(40)}]);
  assert.equal(refreshed.tasks.T.branch_maintenance_result,null);
  assert.equal(decideNudge(refreshed.tasks.T).reason,'no_coder_work');
  assert.equal(decideNudge({...rec,mergeable:false}).action,'repair_conflict');
  assert.equal(decideNudge({...rec,mergeable_state:'dirty'}).action,'repair_conflict');
});
test('owner approval tied to earlier question identity never approves a replacement',async()=>{
  const {createHash}=await import('node:crypto');
  const gh=new GitHubFacts({repo:'owner/repo',token:'test'});
  const digest=createHash('sha256').update('Question A').digest('hex');
  const pr={number:25,labels:[{name:'needs-owner-decision'}],
    body:'<!-- aicafe-owner-question Question B -->',
    html_url:'https://github.com/owner/repo/pull/25',
    updated_at:'2026-11-10T10:00:00Z'};
  const comments=[{author_association:'OWNER',
    body:'Owner approved\\n<!-- aicafe-owner-approved-question '+digest+' -->',
    created_at:'2026-11-10T11:00:00Z'}];
  assert.match((await gh.ownerDecision(pr,comments)).question,/Question B/);
  const active=createHash('sha256').update('Question B').digest('hex');
  const accepted=await gh.ownerDecision(pr,[{...comments[0],
    body:'Owner approved\\n<!-- aicafe-owner-approved-question '+active+' -->'}]);
  assert.equal(accepted.approved,true);
});
test('private ledger retries transient 500 reads and writes, not CAS collisions',async()=>{
  let reads=0,writes=0,collisions=0;
  const gh=new GitHubLedger({repo:'private/ledger',token:'test',fetchFn:async (_url,options)=>{
    if(options.method==='PUT'){
      writes++;
      return {ok:writes>=3,status:writes>=3?200:503,
        json:async()=>({content:{sha:'x'}})};
    }
    reads++;
    return {ok:reads>=2,status:reads>=2?200:500,json:async()=>({private:true})};
  }});
  assert.equal((await gh.request('')).private,true);
  await gh.request('/contents/dispatcher/state.json',{method:'PUT',body:'{}'});
  assert.equal(reads,2);
  assert.equal(writes,3);
  const collided=new GitHubLedger({repo:'private/ledger',token:'test',fetchFn:async()=>{
    collisions++;
    return {ok:false,status:409};
  }});
  await assert.rejects(collided.request('/contents/dispatcher/state.json',{method:'PUT'}),
    error=>error.code==='CONFLICT');
  assert.equal(collisions,1);
});

function workflowRouting(){
 const lines=readFileSync(new URL('../../.github/workflows/ai-cafe-dev-dispatcher.yml',import.meta.url),'utf8').split(/\r?\n/);
 const events=new Map();let inOn=false,event=null;
 for(const line of lines){
  if(line==='on:'){inOn=true;continue;}
  if(inOn && /^[^\s#]/.test(line))inOn=false;
  if(!inOn)continue;
  const m=line.match(/^  ([a-z_]+):\s*$/);
  if(m){event=m[1];events.set(event,null);continue;}
  const types=line.match(/^    types:\s*\[(.*)\]\s*$/);
  if(types&&event)events.set(event,types[1].split(',').map(x=>x.trim()));
 }
 const section=name=>{
  const start=lines.indexOf('  '+name+':');
  assert.ok(start>=0);
  const end=lines.findIndex((x,i)=>i>start && /^  [a-z_-]+:\s*$/.test(x));
  return lines.slice(start,end<0?lines.length:end);
 };
 const folded=(lines,key)=>{
  const i=lines.findIndex(x=>x.trim()===key+': >-');
  assert.ok(i>=0);
  const indent=lines[i].length-lines[i].trimStart().length;
  const parts=[];
  for(const line of lines.slice(i+1)){
   if(!line.trim())continue;
   if(line.length-line.trimStart().length<=indent)break;
   parts.push(line.trim());
  }
  return parts.join(' ');
 };
 const reconcileLines=section('reconcile');
 const persist=reconcileLines.find(x=>x.trim().startsWith('PERSIST: '));
 const ix=reconcileLines.findIndex(x=>x.includes('- name: Publish opaque wake-up signal'));
 assert.ok(persist&&ix>=0);
 const signal=reconcileLines.slice(ix+1).find(x=>x.trim().startsWith('if: '));
 assert.ok(signal);
 return {events,unit:folded(section('unit'),'if'),reconcile:folded(reconcileLines,'if'),
  persist:persist.trim().slice('PERSIST: '.length).slice(3,-2).trim(),
  signal:signal.trim().slice(4).trim()};
}
function evaluateWorkflow(expr,{event,enabled='true',manual=false,trusted=true,app='github-actions'}={}){
 const github={event_name:event,ref:'refs/heads/main',repository:'owner/repo',repository_owner:'owner',
  event:{workflow_run:{event:'pull_request',name:'AI CAFE Pull Request Baseline',head_repository:{full_name:'owner/repo'}},
   check_run:{app:{slug:app}},check_suite:{app:{slug:app}},
   pull_request:{head:{repo:{full_name:'owner/repo'}}},
   review:{author_association:trusted?'COLLABORATOR':'NONE'},
   issue:{pull_request:{},number:423},
   comment:{author_association:trusted?'COLLABORATOR':'NONE',user:{login:'owner'}}}};
 return !!runInNewContext(expr,{github,vars:{DISPATCH_LEDGER_AUTO_PERSIST:enabled},
  inputs:{persist_private_ledger:manual},fromJSON:JSON.parse,contains:(a,b)=>a.includes(b)},{timeout:500});
}
test('supported events reconcile, persist and publish Muse wake signals',()=>{
 const {events,unit,reconcile,persist,signal}=workflowRouting();
 // Check completions generated by the dispatcher itself are recursive noise,
 // not fresh CI evidence; named workflow completion remains an event trigger.
 assert.equal(events.has('check_suite'),false);
 assert.equal(events.has('check_run'),false);
 for(const [event,type] of [['pull_request_review','submitted'],['issue_comment','created'],
  ['workflow_run','completed']]){
  assert.ok(events.has(event),event);
  assert.ok(events.get(event)?.includes(type),event+' '+type);
  assert.equal(evaluateWorkflow(unit,{event}),true,event+' unit');
  assert.equal(evaluateWorkflow(reconcile,{event}),true,event+' reconcile');
  assert.equal(evaluateWorkflow(persist,{event}),true,event+' persist');
  assert.equal(evaluateWorkflow(signal,{event}),true,event+' signal');
  assert.equal(evaluateWorkflow(persist,{event,enabled:'false'}),false,event+' disabled persist');
  assert.equal(evaluateWorkflow(signal,{event,enabled:'false'}),false,event+' disabled signal');
 }
 // Raw PR updates may run tests but must not persist the private ledger.
 assert.ok(events.get('pull_request')?.includes('synchronize'));
 assert.equal(evaluateWorkflow(unit,{event:'pull_request'}),true);
 assert.equal(evaluateWorkflow(reconcile,{event:'pull_request'}),false);
 assert.equal(evaluateWorkflow(persist,{event:'pull_request'}),false);
 assert.equal(evaluateWorkflow(signal,{event:'pull_request'}),false);
 assert.equal(evaluateWorkflow(unit,{event:'pull_request_review',trusted:false}),false);
 assert.equal(evaluateWorkflow(reconcile,{event:'check_run'}),false);
 assert.equal(evaluateWorkflow(persist,{event:'check_suite'}),false);
 assert.equal(evaluateWorkflow(signal,{event:'check_run'}),false);
 assert.equal(evaluateWorkflow(signal,{event:'workflow_dispatch',manual:true}),true);
 assert.equal(evaluateWorkflow(signal,{event:'workflow_dispatch',manual:false}),false);
});
test('mergeApprovedPr emits ancestry-preserving merge commit API request',async()=>{
 const sha='a'.repeat(40),base='b'.repeat(40),merged='c'.repeat(40);
 const record={task_id:'POS0d',pr_number:407,head_sha:sha,base_sha:base,draft:false,
  ci_state:'success',codex_state:'clean',codex_reviewed_sha:sha,threads_resolved:true,mergeable:true};
 const pr={state:'open',merged:false,draft:false,mergeable:true,head:{sha},base:{sha:base,ref:'main'},labels:[]};
 const calls=[];
 const github={request:async(path,options={})=>{
  calls.push({path,options});
  if(path==='/pulls/407')return pr;
  if(path==='/pulls/407/merge')return {merged:true,sha:merged};
  if(path==='/actions/workflows/ai-cafe-integration-proof.yml/dispatches')return {ok:true};
  throw Error('Unexpected '+path);
 },one:async()=>({head_sha:sha,ci_state:'success',codex_state:'clean',
  codex_reviewed_sha:sha,threads_resolved:true,sensitive_owner_block:false})};
 const outcome=await mergeApprovedPr({github,record,enabled:true});
 assert.equal(outcome.status,'merged_unproven');
 const merges=calls.filter(x=>x.path==='/pulls/407/merge');
 assert.equal(merges.length,1);
 assert.equal(merges[0].options.method,'PUT');
 assert.deepEqual(JSON.parse(merges[0].options.body),
  {merge_method:'merge',sha,commit_title:'AI CAFE approved task POS0d (#407)'});
 assert.equal(calls.some(x=>x.path==='/pulls/407/update-branch'),false);
});

test('only one five-minute GitHub schedule, with no second dispatcher cron',()=>{
 const yaml=readFileSync(new URL('../../.github/workflows/ai-cafe-dev-dispatcher.yml',import.meta.url),'utf8');
 const entries=yaml.match(/^\s*- cron:\s*['"][^'"]+['"]/gm)||[];
 assert.deepEqual(entries.map(x=>x.trim()),["- cron: '3/5 * * * *'"]);
 assert.match(yaml,/repository_dispatch:/);
 assert.match(yaml,/DISPATCH_LEDGER_GIT_WRITES: 'true'/);
});
test('old overflow notification repair is only part of successful trusted reconciliation',()=>{
 const code=readFileSync(new URL('./run.mjs',import.meta.url),'utf8');
 const position=code.indexOf('const withRecoveredNotices=resolveObsoleteLedgerOverflowNotices(restored)');
 const successful=code.indexOf('const projection=await ledger.transaction(latest=>');
 assert.ok(position>successful);
 assert.ok(code.indexOf('const projected=recordLifecycleTransitions(withRecoveredNotices,queue);')>position);
 assert.ok(code.indexOf('main().catch')>position);
});
