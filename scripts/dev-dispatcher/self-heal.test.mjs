import test from 'node:test'; import assert from 'node:assert/strict'; import {trackScheduleGap,verifiedMergedProof,recordDrift,acceptMuseOwnerReply,REQUIRED_INTEGRATION_STEPS} from './self-heal.mjs'; const sha='a'.repeat(40); const at='2026-11-10T19:00:00.000Z'; test('missed five-minute schedule is recorded once after >15 minutes without a second scheduler',()=>{ const original={tasks:{},actions:{},schedule_health:{last_schedule_at:'2026-11-10T18:40:00.000Z'}}; const first=trackScheduleGap(original,{eventName:'workflow_run',now:at}); assert.equal(first.schedule_health.missed_schedule.gap_minutes,20); const again=trackScheduleGap(first,{eventName:'issue_comment',now:'2026-11-10T19:05:00.000Z'}); assert.deepEqual(again.schedule_health.missed_schedule,first.schedule_health.missed_schedule); const recovered=trackScheduleGap(again,{eventName:'schedule',now:'2026-11-10T19:07:00.000Z'}); assert.equal(recovered.schedule_health.last_schedule_at,'2026-11-10T19:07:00.000Z'); const onTime=trackScheduleGap({tasks:{},actions:{},schedule_health:{last_schedule_at:'2026-11-10T18:50:00.000Z'}},{eventName:'schedule',now:at}); assert.equal(onTime.schedule_health.missed_schedule,undefined); });
test('owner merge promotes only exact-merge-SHA successful main proof with executed scenarios',async()=>{ const run={name:'AI CAFE Integration Proof',head_branch:'main',event:'push', status:'completed',conclusion:'success',head_sha:sha,id:38}; const job={name:'Required merged-main integration checks',status:'completed',conclusion:'success', steps:REQUIRED_INTEGRATION_STEPS.map(name=>({name,status:'completed',conclusion:'success'}))}; const rows=[{id:'1',command:'node --test scripts/x.test.mjs',test_file:'scripts/x.test.mjs',result:'passed'}]; const {acceptanceDigest}=await import('./acceptance-runner.mjs');
const artifact={version:1,task_id:'POS0d',run_id:38,head_sha:sha,base_sha:sha, acceptance_digest:acceptanceDigest(rows),acceptance:rows}; assert.equal(verifiedMergedProof({run,job,taskId:'POS0d',mergeSha:sha}),null);
const proof=verifiedMergedProof({run,job,artifact,taskId:'POS0d',mergeSha:sha}); assert.equal(proof.workflow_run_id,38);assert.equal(proof.proof_basis,'exact_sha_artifact'); assert.deepEqual(proof.required_scenarios,rows);
assert.equal(verifiedMergedProof({run,job,artifact:{...artifact,acceptance:[]},taskId:'POS0d',mergeSha:sha}),null); assert.equal(verifiedMergedProof({run,job,artifact:{...artifact,acceptance_digest:'bad'},taskId:'POS0d',mergeSha:sha}),null); assert.equal(verifiedMergedProof({run:{...run,head_sha:'b'.repeat(40)},job,artifact,taskId:'POS0d',mergeSha:sha}),null);
assert.equal(verifiedMergedProof({run,job:{...job,steps:job.steps.slice(1)},artifact,taskId:'POS0d',mergeSha:sha}),null); const dispatched={...run,event:'workflow_dispatch',head_sha:'c'.repeat(40)}; assert.equal(verifiedMergedProof({run:dispatched,job,taskId:'POS0d',mergeSha:sha}),null);
assert.equal(verifiedMergedProof({run:dispatched,job,taskId:'POS0d',mergeSha:sha,artifact}).proof_basis,'exact_sha_artifact'); }); test('live GitHub drift is fixed and logged, not treated as a new merge gate',()=>{ const old={tasks:{x:{pr_number:422,head_sha:'old',base_current:true,codex_state:'pending'}},actions:{}}; const now={tasks:{x:{pr_number:422,head_sha:'new',base_current:false,codex_state:'findings'}},actions:{}}; const fixed=recordDrift(now,old,[],at); assert.deepEqual(fixed.drift_fixed[0].changes.map(x=>x.field),['head_sha','base_current','codex_state']); assert.deepEqual(recordDrift(fixed,fixed,[],at).drift_fixed,fixed.drift_fixed); }); test('only authenticated Muse can write idempotent targeted owner_reply events',()=>{ const state={tasks:{POS0d:{task_id:'POS0d',pr_number:407}},actions:{}}; const receipt={kind:'owner_reply',event_id:'reply-1',text:'approved',target:{pr_number:407}}; assert.throws(()=>acceptMuseOwnerReply(state,receipt),/authenticated/); const saved=acceptMuseOwnerReply(state,receipt,{authenticatedCourier:'muse'}); assert.equal(saved.tasks.POS0d.owner_answer_text,'approved'); assert.deepEqual(acceptMuseOwnerReply(saved,receipt,{authenticatedCourier:'muse'}),saved); assert.equal(state.tasks.POS0d.owner_answer_text,undefined);
assert.throws(()=>acceptMuseOwnerReply(state,{...receipt,target:{pr_number:999}},{authenticatedCourier:'muse'}),/not found/); });
test('historical exact-SHA POS0f success backfills and queues Task 6 owner ask on next event wake',async()=>{
 const {integrationStatus}=await import('./effects.mjs');const {settings}=await import('./settings.mjs');
 const {queueOwnerAlerts}=await import('./alerts.mjs');
 const merge='150f497b9d3458052e5363bfc2d60ab6964e4865';
 const run={name:settings.required_checks.integration_workflow,id:42895382773,event:'push',head_branch:'main',
  head_sha:merge,created_at:'2026-11-10T20:26:58Z',status:'completed',conclusion:'success'};
 const job={name:'Required merged-main integration checks',status:'completed',conclusion:'success',
  steps:REQUIRED_INTEGRATION_STEPS.map(name=>({name,status:'completed',conclusion:'success'}))};
 const proof=verifiedMergedProof({run,job,taskId:'POS0f',mergeSha:merge,
  legacyBefore:settings.legacy_proof_before});
 assert.equal(proof.proof_basis,'legacy_exact_sha_required_checks');
 assert.equal(proof.task_acceptance,null);
 assert.equal(integrationStatus({merged_sha:merge,main_sha:merge,proof,expectedAcceptance:Array(12).fill('required')}),'integrated_proven');
 assert.equal(verifiedMergedProof({run:{...run,created_at:'2026-11-10T21:48:00Z'},job,taskId:'POS0f',
  mergeSha:merge,legacyBefore:settings.legacy_proof_before}),null);
 assert.equal(verifiedMergedProof({run,job,taskId:'POS0f',mergeSha:'f'.repeat(40),
  legacyBefore:settings.legacy_proof_before}),null);
 const task={id:'6',title:'Durable worker',goal:'Resume leased work',state:'architecture_approved',
  architecture_approval:{approved:true},exclusive_files:['lib/ai/x.ts'],depends_on:['5','POS0f']};
 const queue={tasks:[task],dispatch_rules:{priority_gate_task:'POS0f'}};
 const ledger={tasks:{'5':{status:'integrated_proven'},POS0f:{status:'merged',merge_sha:merge},
  '6':{status:'blocked_needs_owner',approved:false,priority_deferred:true}},actions:{},owner_alerts:{}};
 ledger.tasks.POS0f={...ledger.tasks.POS0f,status:'integrated_proven',integration_proof:proof};
 const once=queueOwnerAlerts(ledger,{queue}),twice=queueOwnerAlerts(once,{queue});
 assert.equal(Object.values(twice.owner_alerts).filter(n=>n.kind==='next_task_start').length,1);
 assert.equal(Object.values(twice.owner_alerts)[0].delivery_owner,'muse');
});
