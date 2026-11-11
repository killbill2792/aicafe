import test from 'node:test';
import assert from 'node:assert/strict';
import {selectObservation,canReusePr,shouldRecheckMergedLanding} from './event-selection.mjs';
const head='a'.repeat(40),base='b'.repeat(40),main='c'.repeat(40);
const prior={last_full_audit_at:'2026-11-11T10:00:00Z',
 tasks:{T:{pr_number:77,head_sha:head}}};
const now=Date.parse('2026-11-11T10:10:00Z');
test('CI completion checks only PR identified by verified head',()=>{
 assert.deepEqual(selectObservation({eventName:'workflow_run',state:prior,now,
   payload:{workflow_run:{event:'pull_request',head_sha:head,pull_requests:[]}}}),
   {fullAudit:false,focusNumbers:[77]});
});
test('owner comments and review events target one PR; integration proof audits dependencies',()=>{
 assert.deepEqual(selectObservation({eventName:'issue_comment',state:prior,now,
   payload:{issue:{number:88}}}).focusNumbers,[88]);
 assert.deepEqual(selectObservation({eventName:'pull_request_review',state:prior,now,
   payload:{pull_request:{number:99}}}).focusNumbers,[99]);
 assert.equal(selectObservation({eventName:'workflow_run',state:prior,now,
   payload:{workflow_run:{event:'workflow_dispatch'}}}).fullAudit,true);
});
test('periodic backup audit catches lost events; push main always audits',()=>{
 assert.equal(selectObservation({eventName:'schedule',state:prior,now}).fullAudit,false);
 assert.equal(selectObservation({eventName:'schedule',state:prior,
   now:Date.parse('2026-11-11T10:31:00Z')}).fullAudit,true);
 assert.equal(selectObservation({eventName:'push',state:prior,now}).fullAudit,true);
});
test('unchanged cached PR is reused only on exact head, base, and update timestamp',()=>{
 const pr={number:77,head:{sha:head},base:{sha:base},draft:true,
   updated_at:'2026-11-11T10:00:00Z'};
 const old={pr_number:77,head_sha:head,base_sha:base,main_sha:main,draft:true,
   last_github_activity:pr.updated_at,github_state:'open',same_repo:true};
 assert.equal(canReusePr(pr,old,main),true);
 assert.equal(canReusePr(pr,old,main,[77]),false);
 assert.equal(canReusePr(pr,old,'d'.repeat(40)),false);
 assert.equal(canReusePr({...pr,head:{sha:'d'.repeat(40)}},old,main),false);
 assert.equal(canReusePr({...pr,updated_at:'2026-11-11T10:05:00Z'},old,main),false);
});

test('recent merged PRs remain observed for late landing failures',()=>{
 const now=Date.parse('2026-11-11T12:00:00Z');
 const mergedAt='2026-11-11T11:30:00Z';
 const rec={pr_number:407,github_state:'merged',status:'merged',
   merge_sha:head,merged_at:mergedAt,last_landing_check_at:'2026-11-11T11:40:00Z'};
 assert.equal(shouldRecheckMergedLanding(rec,{now}),true);
 assert.equal(shouldRecheckMergedLanding({...rec,landing_failure:'bot verified failure'},{now}),false);
});
test('old merged/unproven PRs get bounded audit checks without losing verified merge',()=>{
 const now=Date.parse('2026-11-11T12:00:00Z');
 const rec={pr_number:407,github_state:'merged',status:'merged',merge_sha:head,
   merged_at:'2026-11-10T07:00:00Z',last_landing_check_at:'2026-11-11T10:00:00Z'};
 assert.equal(shouldRecheckMergedLanding(rec,{now}),false);
 assert.equal(shouldRecheckMergedLanding(rec,{now,fullAudit:true}),true);
 assert.equal(shouldRecheckMergedLanding({...rec,last_landing_check_at:'2026-11-11T11:30:00Z'},
   {now,fullAudit:true}),false);
 assert.equal(shouldRecheckMergedLanding({...rec,status:'integrated_proven'},{now,fullAudit:true}),false);
 assert.equal(shouldRecheckMergedLanding({...rec,merged_at:null},{now}),true);
});
