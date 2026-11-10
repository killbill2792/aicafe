import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCodexReview } from './codex-review.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';

const head='a'.repeat(40), base='b'.repeat(40);
const row={id:'1',command:'node --test scripts/test.test.mjs',
  test_file:'scripts/test.test.mjs',job_url:'https://github.com/o/r/actions/jobs/1',
  result:'passed'};
const evidence={head_sha:head,base_sha:base,ci_run_id:10,acceptance_run_id:20,acceptance:[row]};
const rec=()=>({task_id:'child',pr_number:423,github_state:'open',draft:false,
  head_sha:head,base_sha:base,base_branch:'main',base_current:true,
  approved:true,coder_done:true,ci_state:'success',threads_resolved:true,
  acceptance_evidence:evidence,last_commit_at:'2026-11-10T10:00:00Z'});
const task={id:'child',depends_on:['parent'],acceptance:['scenario']};
function fakeGithub({comments=[],draft=false,ci='success'}={}) {
  const posted=[];
  const pr={number:423,state:'open',draft,
    head:{sha:head},base:{sha:base,ref:'main'}};
  return {posted,request:async(path,options)=>{
    if(path==='/pulls/423')return pr;
    if(path==='/actions/runs/10')return {id:10,head_sha:head,event:'pull_request',status:'completed',conclusion:'success'};
    if(path==='/actions/runs/20')return {id:20,head_sha:head,event:'pull_request',status:'completed',conclusion:'success'};
    if(path==='/issues/423/comments' && options?.method==='POST') {
      posted.push(JSON.parse(options.body).body); return {id:10};
    }
    throw Error('Unexpected path '+path);
  },one:async()=>({...rec(),ci_state:ci,codex_reviewed_sha:null,github_owner_question:null,
    acceptance_evidence:evidence}),
  workflowJobs:async(id)=>id===10
    ? [{name:'AI CAFE PR baseline',status:'completed',conclusion:'success'}]
    : [{name:'AI CAFE acceptance evidence',status:'completed',conclusion:'success',
       steps:[{name:'Run approved acceptance scenarios',status:'completed',conclusion:'success'}]}],
  acceptanceProof:async()=>({
    task_id:'child',run_id:20,head_sha:head,base_sha:base,
    acceptance_digest:acceptanceDigest([row]),acceptance:[row]
  }),
  paginated:async()=>comments
  };
}
test('only fully proven ready head causes one dispatcher Codex request',async()=>{
  const github=fakeGithub();
  const result=await requestCodexReview({github,record:rec(),task,
    records:{parent:{status:'integrated_proven'}}});
  assert.deepEqual(result,{status:'requested',head_sha:head});
  assert.equal(github.posted.length,1);
  assert.match(github.posted[0],/@codex review/);
  assert.match(github.posted[0],new RegExp(head));
});
test('existing current-head dispatcher request is not duplicated',async()=>{
  const github=fakeGithub({comments:[{
    author_association:'COLLABORATOR',body:'@codex review\n<!-- aicafe-dispatcher-codex-review:'+head+' -->',
    created_at:'2026-11-10T11:00:00Z'
  }]});
  const result=await requestCodexReview({github,record:rec(),task,
    records:{parent:{status:'integrated_proven'}}});
  assert.equal(result.status,'already_requested');
  assert.equal(github.posted.length,0);
});
test('draft, unproven dependency, old head, owner block and red CI hold request',async()=>{
  const gates=[
    [rec(),{parent:{status:'merged'}}],
    [{...rec(),draft:true},{parent:{status:'integrated_proven'}}],
    [{...rec(),ci_state:'failure'},{parent:{status:'integrated_proven'}}],
    [{...rec(),github_owner_question:'needs decision'},{parent:{status:'integrated_proven'}}],
    [{...rec(),codex_reviewed_sha:head},{parent:{status:'integrated_proven'}}],
  ];
  for(const [record,records] of gates){
    const github=fakeGithub();
    assert.equal((await requestCodexReview({github,record,task,records})).status,'held');
    assert.equal(github.posted.length,0);
  }
  assert.equal((await requestCodexReview({
    github:fakeGithub({ci:'failure'}),record:rec(),task,
    records:{parent:{status:'integrated_proven'}}
  })).status,'held_live');
});
