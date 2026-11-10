import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueue, dispatchFrontier, resolveTaskBase, decideNudge, readyGate } from './core.mjs';
import { createDelivery } from './delivery.mjs';
import { renderOwnerView } from './owner-view.mjs';
import { updateChildAfterParentMerge } from './effects.mjs';
import { sanitizeLedger } from './ledger.mjs';
import { GitHubFacts } from './github.mjs';
import { readFileSync } from 'node:fs';

const now = Date.parse('2026-11-09T22:00:00Z');
const old = new Date(now-11*60_000).toISOString();
const task = (id, deps=[], edits=[`scripts/${id}.mjs`], uses=[]) => ({
  id, depends_on:deps, edits, uses, architecture_approval:{approved:true},
  state:'architecture_approved', acceptance:['executable'], title:id,
  goal:'Implement safely', brief:'docs/plans/universal-supervisor-task-briefs.md#task-6'
});
const queue = tasks => ({tasks,merged_code_only:[],capacity:{chatgpt:5,claude:0}});
const active = extras => ({ task_id:'child', approved:true, agent:'chatgpt',
  conversation_ref:'https://chatgpt.com/c/test-123', pr_number:408,
  github_state:'open', head_sha:'a'.repeat(40), base_branch:'main',
  last_commit_at:old, prompt_version:'v2', ci_state:'success',
  codex_state:'pending', draft:true, ...extras});

test('base resolves to main with no dependency, open parent head branch while open, main on parent merge',()=>{
  const parent={status:'draft_open',github_state:'open',pr_number:404,
    branch:'feat/a',head_sha:'b'.repeat(40)};
  assert.equal(resolveTaskBase(task('a'),{}).base_branch,'main');
  assert.deepEqual(resolveTaskBase(task('b',['a']),{a:parent}),
    {base_branch:'feat/a',prerequisite_pr:404,waiting_for_parent:true});
  assert.equal(resolveTaskBase(task('b',['a']),{a:{...parent,status:'merged',
    github_state:'merged',merge_sha:'c'.repeat(40)}}).base_branch,'main');
  const assigned=dispatchFrontier(queue([task('a'),task('b',['a'])]),{a:parent});
  assert.equal(assigned[0].base_branch,'feat/a');
});

test('edits are exclusive; uses can import open sibling edits with no owner question',()=>{
  const a=task('a',[],['lib/shared.mjs']);
  const b=task('b',[],['lib/b.mjs'],['lib/shared.mjs']);
  assert.equal(validateQueue(queue([a,b])).size,2);
  assert.equal(dispatchFrontier(queue([a,b]),{}).length,2);
  assert.throws(()=>validateQueue(queue([a,task('c',[],['lib/shared.mjs'])])),
    /Overlapping exclusive file ownership/);
  assert.throws(()=>validateQueue(queue([a,task('c',[],['lib/c.mjs'],['../bad'])])),
    /Invalid read-only file usage/);
});

test('parent-open child keeps coding and CI: no rebase or Codex wait nudge',()=>{
  const rec=active({base_branch:'feat/parent',parent_open:true,ci_state:'success'});
  assert.equal(decideNudge(rec,now).action,'idle_continue');
  assert.equal(decideNudge({...rec,waiting_only_for_parent:true},now).kind,'hold');
  assert.equal(decideNudge({...rec,ci_state:'failure',waiting_only_for_parent:true,
    ci_failure_job:'unit',ci_failure_url:'https://github.com/example/a/actions/runs/99'},now).action,'ci_failed');
  assert.equal(readyGate({...rec,coder_done:true}).eligible,false);
});

test('parent merge results in exactly one rebase prompt keyed by merge SHA, not by child head',()=>{
  const sha='f'.repeat(40);
  const rec=active({parent_merged_sha:sha,base_branch:'main',branch_maintenance_merge_sha:sha});
  const first=decideNudge(rec,now);
  assert.equal(first.action,'parent_merged');
  assert.match(first.key,/parent_merged/);
  assert.equal(decideNudge({...rec,last_parent_rebase_sha:sha,waiting_only_for_parent:true},now).kind,'hold');
  assert.equal(decideNudge({...rec,head_sha:'e'.repeat(40)},now).key,first.key);
});

test('each reason produces a single short explicit prompt with its actual evidence',()=>{
  const t=task('child');
  const samples=[
    ['codex_comments',{codex_state:'findings',unresolved_codex_comments:[
      {body:'Guard the null case',url:'https://github.com/example/a/pull/408#discussion_r1'}]},/Guard the null case/],
    ['ci_failed',{ci_state:'failure',ci_failure_job:'unit checks',
      ci_failure_url:'https://github.com/example/a/actions/runs/99'},/unit checks/],
    ['parent_merged',{parent_merged_sha:'f'.repeat(40),base_branch:'feat/parent'},/retargeted this child to main/i],
    ['owner_answered',{owner_answer_text:'Use existing path only'},/Use existing path only/],
    ['idle_continue',{},/Continue/],
  ];
  for(const [action,extra,expected] of samples){
    const d=createDelivery({task:t,record:active(extra),action,actionId:'v2:'+action});
    assert.match(d.prompt,expected);
    assert.ok(d.prompt.trim().split(/\s+/).length<120,action);
    assert.equal(d.intent,'continue_existing_chat');
    assert.equal(d.prompt_hash.length,64);
  }
  assert.equal(decideNudge(active({codex_state:'findings'}),now).action,'codex_comments');
  assert.equal(decideNudge(active({ci_state:'failure',codex_state:'findings'}),now).action,'ci_failed');
  assert.equal(decideNudge(active({owner_answer_text:'Yes'}),now).action,'owner_answered');
});

test('ready is possible after green CI and coder-done, not before; merge Codex gate remains independent',()=>{
  const base=active({draft:true,coder_done:true,ci_state:'success',base_current:true,
    acceptance_proven:true,threads_resolved:true});
  assert.equal(readyGate(base).eligible,true);
  assert.equal(readyGate({...base,coder_done:false}).eligible,false);
  assert.equal(readyGate({...base,ci_state:'failure'}).eligible,false);
  assert.equal(readyGate({...base,base_branch:'feat/parent'}).eligible,false);
  assert.equal(readyGate({...base,draft:false}).eligible,false);
  const unreviewed=active({draft:false,coder_done:true,ci_state:'success',codex_state:'pending',
    review_requested_sha:'a'.repeat(40),last_commit_at:new Date(now-1_200_000).toISOString()});
  assert.equal(decideNudge(unreviewed,now).action,'idle_continue',
    'never mistake a prompt for an actual Codex request');
});

test('owner view calls stale cancellations superseded and planned overdue actions courier unconfirmed',()=>{
  const state={version:1,updated_at:old,
    tasks:{child:{pr_number:408,github_state:'open',draft:true}},
    actions:{
      cancelled:{task_id:'child',status:'cancelled_stale_head',type:'idle_continue',created_at:old},
      overdue:{task_id:'child',status:'planned',type:'idle_continue',
        delivery_owner:'muse',created_at:new Date(now-21*60_000).toISOString()}
    }};
  const view=renderOwnerView(state,{repo:'example/a',asOf:new Date(now).toISOString()});
  assert.match(view,/superseded/);
  assert.match(view,/courier unconfirmed/);
  assert.doesNotMatch(view,/cancelled_stale_head/);
});


test('default branch maintenance verifies live parent merge before retarget, then requests update-branch in order',async()=>{
  const merged='f'.repeat(40),head='a'.repeat(40);
  const parent={pr_number:400,branch:'feat/parent',status:'merged',merge_sha:merged};
  const child={pr_number:408,head_sha:head,github_state:'open'};
  let updated=false;
  const calls=[];
  const github={request:async(path,options)=>{
    calls.push([path,options?.method]);
    if(path==='/pulls/400')return {merged_at:'2026-11-09T22:00:00Z',
      merge_commit_sha:merged,head:{ref:'feat/parent'}};
    if(path==='/pulls/408' && options?.method==='PATCH'){updated=true;return {};}
    if(path==='/pulls/408')return {state:'open',merged:false,head:{sha:head},
      base:{ref:updated?'main':'feat/parent'}};
    if(path==='/pulls/408/update-branch') return {message:'Update branch requested'};
    throw Error('Unexpected request '+path);
  }};
  const v=await updateChildAfterParentMerge({github,dependent:child,predecessor:parent});
  assert.equal(v.status,'update_requested');
  assert.deepEqual(calls.map(([p,m])=>p+' '+(m||'GET')),[
    '/pulls/400 GET','/pulls/408 GET','/pulls/408 PATCH','/pulls/408 GET',
    '/pulls/408/update-branch PUT'
  ]);
  const rejected=await updateChildAfterParentMerge({github,dependent:child,
    predecessor:{...parent,merge_sha:'b'.repeat(40)}});
  assert.equal(rejected.reason,'parent_merge_not_verified_live');
  assert.equal(calls.filter(([p,m])=>m==='PATCH').length,1);
});

test('already-main child requests update without a second retarget; conflicts surface without release',async()=>{
  const merged='f'.repeat(40),head='a'.repeat(40);
  const calls=[];
  const github={request:async(path,options)=>{
    calls.push([path,options?.method]);
    if(path==='/pulls/400')return{merged_at:'yes',merge_commit_sha:merged,head:{ref:'feat/parent'}};
    if(path==='/pulls/408')return {state:'open',merged:false,head:{sha:head},base:{ref:'main'}};
    if(path.endsWith('/update-branch'))throw new Error('Cannot update due to conflicts');
    throw Error(path);
  }};
  const v=await updateChildAfterParentMerge({github,dependent:{pr_number:408,head_sha:head,
    github_state:'open'},predecessor:{pr_number:400,branch:'feat/parent',
      status:'merged',merge_sha:merged}});
  assert.equal(v.status,'update_failed_needs_coder');
  assert.ok(calls.some(([p,m])=>p.endsWith('/update-branch')&&m==='PUT'));
  assert.equal(calls.some(([,m])=>m==='PATCH'),false);
  const run=readFileSync(new URL('./run.mjs',import.meta.url),'utf8');
  const workflow=readFileSync(new URL('../../.github/workflows/ai-cafe-dev-dispatcher.yml',
    import.meta.url),'utf8');
  assert.match(run,/if \(commit && ledger\) \{\s*const currentTasks/);
  assert.match(run,/updateChildAfterParentMerge/);
  assert.match(run,/main branch update will retry/);
  assert.doesNotMatch(run,/process\.env\.DISPATCH_BRANCH_MAINTENANCE/);
  assert.doesNotMatch(workflow,/DISPATCH_BRANCH_MAINTENANCE/);
});

test('all delivery steps stay under 2 KB and planning links concise Superpowers flow',()=>{
  const t=task('child',[],Array.from({length:24},(_,i)=>'lib/shared'+i+'.mjs'));
  for(const action of ['assign','pre_pr_reminder','codex_comments','ci_failed',
    'parent_merged','owner_answered','idle_continue','plan','brainstorm']){
    const d=createDelivery({task:t,record:active(),action,actionId:'compact:'+action});
    assert.ok(Buffer.byteLength(d.prompt,'utf8')<=2048,action);
    assert.match(d.prompt,/AGENTS\.md/);
    assert.match(d.prompt,/PROGRESS\.md/);
    assert.match(d.prompt,/SKILL\.md/);
    assert.match(d.prompt,/Signed queue/);
    assert.equal(d.prompt.includes('source text of AGENTS'),false);
    if(['plan','brainstorm'].includes(action)){
      assert.match(d.prompt,/one question at a time/);
      assert.match(d.prompt,/Mermaid diagrams/);
      assert.match(d.prompt,/merge order/);
    }
  }
});

test('ledger keeps text while planned but drops it after verified receipt, preserving hash',()=>{
  const state={version:1,updated_at:null,tasks:{},actions:{
    a:{status:'planned',delivery:{prompt:'pending',prompt_hash:'a'.repeat(64)}},
    b:{status:'submitted',receipt:{courier:'muse'},delivery:{
      prompt:'delivered private text',prompt_hash:'b'.repeat(64)}},
    c:{status:'cancelled_stale_head',superseded_receipt:{submitted_at:old},delivery:{
      prompt:'historically submitted',prompt_hash:'c'.repeat(64)}}
  }};
  sanitizeLedger(state);
  assert.equal(state.actions.a.delivery.prompt,'pending');
  assert.equal(state.actions.b.delivery.prompt,undefined);
  assert.equal(state.actions.c.delivery.prompt,undefined);
  assert.equal(state.actions.b.delivery.prompt_hash,'b'.repeat(64));
});


test('a freshly merged parent cannot trigger an idle nudge before automatic retarget/update-branch',()=>{
  const parentSha='f'.repeat(40);
  const pending=active({base_branch:'feat/parent',parent_merged_sha:parentSha,
    ci_state:'failure',ci_failure_job:'unit checks'});
  const result=decideNudge(pending,now);
  assert.deepEqual(result,{kind:'hold',reason:'awaiting_automatic_parent_branch_maintenance'});
  const updated={...pending,branch_maintenance_merge_sha:parentSha,base_branch:'main'};
  const next=decideNudge(updated,now);
  assert.equal(next.action,'parent_merged');
  assert.equal(next.key,decideNudge({...updated,head_sha:'c'.repeat(40)},now).key);
});


test('CI-failed nudge names the actual failed GitHub check with its verified link',async()=>{
  const head='a'.repeat(40),base='b'.repeat(40);
  const jobUrl='https://github.com/example/a/actions/runs/99/job/21';
  const responses={
    ['/commits/'+head+'/check-runs?per_page=100']:{total_count:2,check_runs:[
      {name:'AI CAFE PR baseline',status:'completed',conclusion:'failure',
        html_url:'https://github.com/example/a/actions/runs/99'},
      {name:'TypeScript, full ESLint and patch hygiene',status:'completed',
        conclusion:'failure',html_url:jobUrl}]},
    '/pulls/42/reviews?per_page=100':[],
    ['/commits/'+head]:{commit:{committer:{date:old}}},
    ['/compare/'+base+'...'+head]:{behind_by:0,files:[]},
    '/issues/42/comments?per_page=100':[]
  };
  const facts=new GitHubFacts({repo:'example/a',token:'test-only',
    fetchFn:async(url)=>{
      const data=url==='https://api.github.com/graphql'
        ? {data:{repository:{pullRequest:{reviewThreads:{
            pageInfo:{hasNextPage:false},nodes:[]}}}}}
        : responses[url.replace('https://api.github.com/repos/example/a','')];
      if(data===undefined)throw Error('Unexpected GitHub read '+url);
      return {ok:true,status:200,json:async()=>data};
    }});
  const p={number:42,head:{sha:head,ref:'feat/child'},
    base:{sha:base,ref:'main'},labels:[],body:'',updated_at:old,
    html_url:'https://github.com/example/a/pull/42',draft:true};
  const observed=await facts.one(p);
  assert.equal(observed.ci_state,'failure');
  assert.equal(observed.ci_failure_job,'TypeScript, full ESLint and patch hygiene');
  assert.equal(observed.ci_failure_url,jobUrl);
  const delivery=createDelivery({task:task('child'),record:active({
    ci_failure_job:observed.ci_failure_job,ci_failure_url:observed.ci_failure_url,
    ci_state:'failure'}),action:'ci_failed',actionId:'failing-job'});
  assert.match(delivery.prompt,/TypeScript, full ESLint and patch hygiene/);
  assert.match(delivery.prompt,/actions\/runs\/99\/job\/21/);
});
