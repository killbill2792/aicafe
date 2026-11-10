import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubFacts } from './github.mjs';
import { approvalSignature, approvalMatches, createDelivery } from './delivery.mjs';
import { readFileSync } from 'node:fs';

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
  assert.match(source,/cron: '2\/5 \* \* \* \*'/);
  assert.match(source,/workflows: \[[^\n]*'AI CAFE Integration Proof'/);
});