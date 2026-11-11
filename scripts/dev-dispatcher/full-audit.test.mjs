import test from 'node:test';
import assert from 'node:assert/strict';
import {settings} from './settings.mjs';
import {loadQueue} from './queue-source.mjs';
import {queueOwnerAlerts} from './alerts.mjs';
import {noticeOperationalIssues} from './notifications.mjs';
import {applyReceipts} from './inbox.mjs';
import {protectedChanges} from './safety.mjs';
import {readyGate,mergeGate} from './core.mjs';
import {combinedDashboard,renderDashboard} from './dashboard.mjs';
import {dispatcherOnlyFiles} from './github.mjs';
import {mergeApprovedPr} from './effects.mjs';
import {signalFor} from './signal.mjs';

test('external studio plan loads through its own configured repo without reading code repo queue',async()=>{
 const config=structuredClone(settings);config.repo='killbill2792/MVPStyli';
 config.queue={repo:'killbill2792/studio',path:'studio/ideas/stylit-agent/tasks.json',ref:'main'};
 let requests=0;
 const plan={merge_order:['styli-1'],tasks:[{id:'styli-1',edits:['src/job.ts'],
  acceptance:['must pass'],depends_on:[],status:'proposed'}]};
 const actual=await loadQueue({config,github:{request:async(url)=>{
  requests++;assert.match(url,/killbill2792\/studio\/contents\/studio\/ideas\/stylit-agent\/tasks.json/);
  return {type:'file',encoding:'base64',content:Buffer.from(JSON.stringify(plan)).toString('base64')};
 }},readLocal:()=>{throw Error('must not read AI CAFE queue');}});
 assert.equal(actual.tasks[0].brief,'https://github.com/killbill2792/studio/blob/main/studio/ideas/stylit-agent/tasks.json#task-styli-1');
 assert.equal(actual.tasks[0].architecture_approval.approved,false);
 assert.deepEqual(actual.merged_code_only,[]);
 assert.equal(actual.sequential_edit_overlap,true);assert.equal(requests,1);
 const {validateQueue}=await import('./core.mjs');assert.ok(validateQueue(actual));
 await assert.rejects(loadQueue({config,github:{request:async()=>({type:'dir'})}}),/missing or not a JSON file/);
});

test('unlinked human PR receives one owner Muse ask each tick, and a registered branch link resolves it',()=>{
 const pr={pr_number:427,branch:'feat/change',title:'Independent worker',chat_marker:null};
 const state={tasks:{},actions:{},owner_alerts:{}};
 const one=queueOwnerAlerts(state,{unmappedPrs:[427],openPrs:[pr]});
 const twice=queueOwnerAlerts(one,{unmappedPrs:[427],openPrs:[pr]});
 const notes=Object.values(twice.owner_alerts);
 assert.equal(notes.length,1);assert.equal(notes[0].kind,'missing_chat_link');
 assert.equal(notes[0].recipient,'owner');assert.equal(notes[0].delivery_owner,'muse');
 assert.match(notes[0].question,/PR #427 on branch feat\/change titled Independent worker has no chat/);
 const linked={...twice,branch_chat_links:{'feat/change':{conversation_url:'https://chatgpt.com/c/abc-123'}}};
 const resolved=queueOwnerAlerts(linked,{unmappedPrs:[427],openPrs:[pr]});
 assert.equal(Object.values(resolved.owner_alerts)[0].status,'resolved');
 assert.equal(resolved.adhoc_unlinked_logged,undefined);
});

test('authenticated Muse instruction links a branch but never executes unrelated free-form text',()=>{
 const state={tasks:{},actions:{}},real={kind:'owner_instruction',event_id:'evt-1',
  text:'https://chatgpt.com/c/abc-123',target:{branch:'feat/linked'}};
 const accepted=applyReceipts(state,[{receipt:real,actor:'muse-bot'}],{'muse-bot':'muse'});
 assert.equal(accepted.branch_chat_links['feat/linked'].conversation_url,real.text);
 assert.equal(accepted.owner_instruction_events['evt-1'].chat_registered,true);
 const rejected=applyReceipts(state,[{receipt:real,actor:'stranger'}],{'muse-bot':'muse'});
 assert.deepEqual(rejected,state);
 const arbitrary=applyReceipts(state,[{receipt:{...real,event_id:'evt-2',text:'delete production'},actor:'muse-bot'}],
  {'muse-bot':'muse'});
 assert.equal(arbitrary.branch_chat_links,undefined);
 assert.equal(arbitrary.owner_instruction_events['evt-2'].chat_registered,undefined);
});

test('every supported missing-data, skip and error class produces one deduped owner Muse notice',()=>{
 const state={tasks:{
  ci:{task_id:'ci',pr_number:1,github_state:'open',head_sha:'a'.repeat(40),ci_state:'pending',last_commit_at:'2026-11-10T10:00:00Z'},
  red:{task_id:'red',pr_number:2,github_state:'open',head_sha:'b'.repeat(40),ci_state:'failure'},
  proof:{task_id:'proof',pr_number:3,status:'merged',merge_sha:'c'.repeat(40)},
  stall:{task_id:'stall',pr_number:4,stall_escalate:true,head_sha:'d'.repeat(40)},
  chat:{task_id:'chat',pr_number:5,chat_recovery_blocker:'bad_signature'},
  guard:{task_id:'guard',pr_number:6,protected_file_violation:[{file:'src/locked.ts'}]}
 },actions:{one:{task_id:'ci',status:'uncertain'}},owner_alerts:{},
 schedule_health:{missed_schedule:{last_schedule_at:'2026-11-10T10:00:00Z',gap_minutes:32}}};
 const scan={complete:false,scan_error:'receipt_directory_unavailable',
  rejected:[{file:'bad.json',code:'unapproved_git_actor'}]};
 const one=noticeOperationalIssues(state,{scan}),again=noticeOperationalIssues(one,{scan});
 const expected=['receipt_scan_incomplete','receipt_rejected','missed_schedule','ci_unavailable',
  'ci_no_chat','proof_unavailable','stall_owner_escalation','chat_receipt_repair',
  'protected_file_blocked','courier_action_failed'];
 const notes=Object.values(again.owner_alerts);
 for(const kind of expected)assert.equal(notes.filter(n=>n.kind===kind).length,1,kind);
 assert.equal(notes.length,Object.values(one.owner_alerts).length);
 assert.ok(notes.every(n=>n.recipient==='owner'&&n.delivery_owner==='muse'&&n.question.includes('Needed:')));
});

test('protected GitHub changed files block ready and merge; unrelated file stays allowed',()=>{
 const protections=[{owner:'Lakshmi',source_repo:'killbill2792/studio',source_pr:4,paths:['src/lakshmi/**','studio/design.md']}];
 const file=protectedChanges([{filename:'src/lakshmi/worker.ts'},{filename:'other/test.ts'}],protections);
 assert.equal(file.length,1);assert.equal(file[0].owner,'Lakshmi');
 assert.equal(protectedChanges([{filename:'src/other.ts'}],protections).length,0);
 const record={pr_number:1,head_sha:'a'.repeat(40),draft:true,ci_state:'success',protected_file_violation:file};
 assert.ok(readyGate(record).reasons.includes('protected_file_owner_hold'));
 assert.ok(mergeGate({...record,draft:false,codex_state:'clean',codex_reviewed_sha:record.head_sha,
  threads_resolved:true,mergeable:true}).reasons.includes('protected_file_owner_hold'));
});

test('combined owner dashboard reads independent ledgers only and never writes',async()=>{
 const target=structuredClone(settings);target.repo='killbill2792/MVPStyli';
 target.ledger.repo='killbill2792/stylit-ledger';target.chatgpt.project_name='Stylit';
 const urls=[],encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
 const api=async(repo,path,opts)=>{
  assert.equal(opts,undefined);urls.push([repo,path]);
  if(repo===target.repo)return {content:encode(target)};
  if(repo===settings.ledger.repo)return {content:encode({tasks:{a:{status:'integrated_proven'}}})};
  if(repo===target.ledger.repo)return {content:encode({tasks:{b:{status:'blocked_needs_owner'}}})};
  throw Error('unexpected repository '+repo);
 };
 const rows=await combinedDashboard({api,manifest:{repositories:[target.repo]}});
 assert.equal(rows.length,2);assert.equal(rows[0].proven,1);assert.equal(rows[1].blocked,1);
 assert.ok(renderDashboard(rows).includes('killbill2792/MVPStyli'));
 assert.equal(urls.filter(x=>x[0]===settings.ledger.repo).length,1);
 assert.equal(urls.filter(x=>x[0]===target.ledger.repo).length,1);
});

test('studio merge_order serializes overlapping file ownership without granting unapproved coding',async()=>{
 const {normalizeExternalPlan}=await import('./queue-source.mjs');
 const {validateQueue,dispatchFrontier}=await import('./core.mjs');
 const source={repo:'killbill2792/studio',ref:'main',path:'studio/ideas/stylit-agent/tasks.json'};
 const normalized=normalizeExternalPlan({merge_order:['0a','0b'],tasks:[
  {id:'0a',depends_on:[],acceptance:['check A'],edits:['app/main.ts'],status:'proposed'},
  {id:'0b',depends_on:['0a'],acceptance:['check B'],edits:['app/main.ts'],status:'proposed'}]},source);
 assert.equal(normalized.tasks[1].depends_on.includes('0a'),true);
 assert.equal(validateQueue(normalized).size,2);
 assert.deepEqual(dispatchFrontier(normalized,{}),[]);
 const wrong={...normalized,tasks:normalized.tasks.map(t=>({...t,depends_on:[]}))};
 assert.throws(()=>validateQueue(wrong),/Overlapping exclusive file ownership/);
});

test('fatal dispatcher request error is saved as one owner Muse alert before an immediate wake',async()=>{
 const {reportFatalDispatcherError}=await import('./notifications.mjs');
 let state={tasks:{},actions:{},owner_alerts:{}},wakes=0;
 const ledger={transaction:async fn=>{const next=fn(state);
  if(next===null)return {committed:false,state}; // real CAS no-op contract
  const committed=JSON.stringify(next)!==JSON.stringify(state);
  if(committed)state=next;return {committed,state};}};
 await reportFatalDispatcherError({ledger,sha:'a'.repeat(40),message:'403 request denied',
  wake:async()=>{wakes++;}});
 await reportFatalDispatcherError({ledger,sha:'a'.repeat(40),message:'403 request denied',
  wake:async()=>{wakes++;}});
 const issues=Object.values(state.owner_alerts);
 assert.equal(issues.length,1);assert.equal(issues[0].kind,'dispatcher_uncaught');
 assert.equal(issues[0].recipient,'owner');assert.equal(issues[0].delivery_owner,'muse');
 assert.equal(wakes,1);
});

test('one dispatcher file among unrelated guard changes is always owner-merge-only',async()=>{
 const changed=[
  {filename:'scripts/dev-dispatcher/run.mjs'},
  {filename:'scripts/guards/pr-size.mjs'},
  {filename:'src/unrelated.ts'}
 ];
 assert.equal(dispatcherOnlyFiles(changed),true);
 assert.equal(dispatcherOnlyFiles([{filename:'src/unrelated.ts'}]),false);
 const sha='f'.repeat(40),base='e'.repeat(40);
 const record={task_id:'ADHOC-427',adhoc:true,dispatcher_only:false,
   pr_number:427,head_sha:sha,base_sha:base,base_branch:'main',
   draft:false,ci_state:'success',codex_state:'clean',codex_reviewed_sha:sha,
   threads_resolved:true,mergeable:true,github_state:'open'};
 const gh={request:async path=>{
   if(path==='/pulls/427')return {state:'open',draft:false,merged:false,
     head:{sha},base:{sha:base,ref:'main'},mergeable:true};
   throw Error('Unexpected mutating GitHub request '+path);
 },one:async()=>({...record,dispatcher_only:dispatcherOnlyFiles(changed)})};
 // Even a stale ledger classification is overridden by live exact GitHub paths.
 const outcome=await mergeApprovedPr({github:gh,record,enabled:true,action:'merge'});
 assert.deepEqual(outcome,{status:'blocked',reasons:['owner_merge_required']});
 assert.deepEqual(await mergeApprovedPr({github:gh,record:{...record,dispatcher_only:true},
   enabled:true,action:'merge'}),{status:'blocked',reasons:['owner_merge_required']});
});

test('operational failure stays owner-directed and wakes Muse through an opaque signal',()=>{
 const original={version:1,tasks:{X:{task_id:'X',pr_number:427,
   github_state:'open',head_sha:'a'.repeat(40),stall_escalate:true}},
   actions:{},owner_alerts:{}};
 const one=noticeOperationalIssues(original);
 const routed=queueOwnerAlerts(one);
 const alert=Object.values(routed.owner_alerts).find(n=>n.kind==='stall_owner_escalation');
 assert.ok(alert);assert.equal(alert.recipient,'owner');
 assert.equal(alert.delivery_owner,'muse');
 const secret='secret'.repeat(8);
 const wake=signalFor(routed,secret);
 assert.ok(wake.pending_count>=1);
 assert.doesNotMatch(JSON.stringify(wake),/stall_owner_escalation|task_id|pr_number/);
 const legacy=structuredClone(routed);
 for(const notice of Object.values(legacy.owner_alerts))delete notice.identity;
 assert.equal(signalFor(legacy,secret).pending_count,wake.pending_count);
 const again=queueOwnerAlerts(noticeOperationalIssues(routed));
 const same=Object.values(again.owner_alerts).filter(n=>n.kind==='stall_owner_escalation');
 assert.equal(same.length,1);assert.equal(same[0].recipient,'owner');
});
