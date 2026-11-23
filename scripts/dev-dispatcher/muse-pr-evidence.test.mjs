import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPrComments,readablePrSummary} from './muse-pr-evidence.mjs';
import {importMuseQuestions,applyQuestionEdit} from './muse-owner-questions.mjs';
const repo='killbill2792/aicafe',head='a'.repeat(40),merge='b'.repeat(40);
const at='2026-11-19T10:00:00Z',mergedAt='2026-11-20T10:00:00Z';
const mk=(id,body,{trusted=true,createdAt=at,author='maintainer'}={})=>({
 body,createdAt,authorAssociation:trusted?'OWNER':'NONE',author:{login:author},
 url:'https://github.com/'+repo+'/pull/488#issuecomment-'+id});
function pr(comments=[],{merged=false,reviewThreads=[]}={}){
 return {number:488,title:'Staff questions',url:'https://github.com/'+repo+'/pull/488',
  headRefOid:head,headRepository:{nameWithOwner:repo},mergedAt:merged?mergedAt:null,
  mergeCommit:merged?{oid:merge}:null,
  comments:{pageInfo:{hasPreviousPage:false},nodes:comments},
  reviewThreads:{pageInfo:{hasNextPage:false},nodes:reviewThreads}};
}
const marker=(text)=>'<!-- aicafe-owner-request:v1 '+head+' -->\n'+text;
test('ordinary unlabeled owner question is captured; routine status chatter and Codex bots ignored',()=>{
 const input=pr([mk(123456701,'Please approve the additional two test files; CI found an unadvertised capability.'),
  mk(123456702,'CI is green and Codex review is running. No owner approval requested.'),
  mk(123456703,'Please approve my changes',{trusted:false}),
  mk(123456704,'Please approve this!',{author:'codex[bot]'})]);
 const observed=inspectPrComments(input,repo);
 assert.equal(observed.comments.length,4,'preserve all valid-source comments');
 assert.deepEqual(observed.owner_requests.map(q=>q.id),['comment-123456701']);
 assert.equal(observed.owner_requests[0].source,'inferred_from_text');
 assert.equal(observed.attention.length,1);
 assert.equal(readablePrSummary({...observed,number:488,title:'A'}).pending_owner_requests,1);
});
test('explicit marker is accepted, even without owner-action keywords; untrusted comments rejected',()=>{
 const p=pr([mk(123456705,marker('Which architecture option do you want?')),
  mk(123456706,marker('Spoof'),{trusted:false})]);
 assert.equal(inspectPrComments(p,repo).owner_requests.length,1);
});
test('an explicit resolution reports closure without inventing an approval',()=>{
 const p=pr([mk(123456707,'Please approve the architecture.'),
  mk(123456708,'Owner approved in the originating chat. Resolves request #123456707.')]);
 const observed=inspectPrComments(p,repo);
 assert.equal(observed.owner_requests.length,1);
 assert.equal(observed.owner_requests[0].disposition,'resolved_reported');
 assert.equal(observed.attention.length,0);
 const questions=importMuseQuestions({version:1,entries:{}},
  {version:1,prs:[{...observed,number:488,url:p.url}],merged_prs:[]});
 assert.equal(questions.entries['comment-123456707'].status,'resolved_reported');
 assert.match(questions.entries['comment-123456707'].closure,/no owner authorization inferred/);
});
test('historical development questions on a merged PR leave active inbox, preserve audit',()=>{
 const p=pr([mk(123456709,marker('Approve the test-only file scope.'))],{merged:true});
 const observed=inspectPrComments(p,repo,{merged:true});
 assert.equal(observed.owner_requests[0].disposition,'historical_after_merge');
 assert.equal(observed.attention.length,0);
 const state=importMuseQuestions({version:1,entries:{}},
  {version:1,prs:[],merged_prs:[{...observed,number:488,url:p.url,merged_at:mergedAt}]});
 assert.equal(state.entries['comment-123456709'].status,'archived');
 assert.equal(state.entries['comment-123456709'].question,'Approve the test-only file scope.');
});
test('merge archives previously open developmental question, but not an explicit release grant',()=>{
 const initial=inspectPrComments(pr([mk(123456710,marker('Approve the test scope.')),
  mk(123456711,marker('Please authorize one production migration.'))]),repo);
 let state=importMuseQuestions({version:1,entries:{}},
  {version:1,prs:[{...initial,number:488,url:'https://github.com/'+repo+'/pull/488'}],merged_prs:[]});
 assert.equal(state.entries['comment-123456710'].status,'open');
 const joined=inspectPrComments(pr([mk(123456710,marker('Approve the test scope.')),
  mk(123456711,marker('Please authorize one production migration.'))],{merged:true}),repo,{merged:true});
 state=importMuseQuestions(state,{version:1,prs:[],
  merged_prs:[{...joined,number:488,url:'https://github.com/'+repo+'/pull/488'}]});
 assert.equal(state.entries['comment-123456710'].status,'archived');
 assert.equal(state.entries['comment-123456711'].status,'open');
 assert.equal(joined.attention.length,1);
 const repeated=importMuseQuestions(state,{version:1,prs:[],
  merged_prs:[{...joined,number:488,url:'https://github.com/'+repo+'/pull/488'}]});
 assert.deepEqual(repeated,state,'poll is idempotent');
});
test('a post-merge owner request is not hidden just because the PR merged',()=>{
 const p=pr([mk(123456712,'Please run workflow in the protected environment.',
  {createdAt:'2026-11-21T10:00:00Z'})],{merged:true});
 const result=inspectPrComments(p,repo,{merged:true});
 assert.equal(result.owner_requests[0].classification,'release_or_live_approval');
 assert.equal(result.attention.length,1);
});
test('local recorded response, delivery, and close retain original evidence',()=>{
 const p=pr([mk(123456713,marker('May I proceed with the approved scope?'))]);
 const observed=inspectPrComments(p,repo);
 let state=importMuseQuestions({version:1,entries:{}},
  {version:1,prs:[{...observed,number:488,url:p.url}],merged_prs:[]});
 state=applyQuestionEdit(state,{id:'comment-123456713',expected_revision:1,
  action:'answer',detail:'Authorized testing only'},{role:'owner',now:at});
 assert.equal(state.entries['comment-123456713'].status,'answered');
 const completed=inspectPrComments(pr([mk(123456713,marker('May I proceed with the approved scope?'))],{merged:true}),repo,{merged:true});
 state=importMuseQuestions(state,{version:1,prs:[],merged_prs:[{...completed,number:488,url:p.url}]});
 assert.equal(state.entries['comment-123456713'].answer,'Authorized testing only');
});
test('post-merge reports are visible, but do not prove executed acceptance',()=>{
 const body='<!-- aicafe-integration-result:v1 '+JSON.stringify({
  merge_sha:merge,status:'PROVEN',evidence_urls:['https://github.com/'+repo+'/actions/runs/123']})+
  ' -->\nChatGPT reports proof; inspect actual logs';
 const p=pr([mk(123456714,body)],{merged:true});
 const observed=inspectPrComments(p,repo,{merged:true});
 assert.equal(observed.integration_reports.length,1);
 assert.equal(observed.integration_reports[0].merge_sha,merge);
 assert.equal(observed.integration_reports[0].independently_verified,false);
 assert.equal(observed.integration_reports[0].source_comment_id,'comment-123456714');
 assert.equal(observed.attention.length,0);
 const stale=pr([mk(123456715,body.replace(merge,head))],{merged:true});
 assert.notEqual(inspectPrComments(stale,repo,{merged:true}).integration_reports[0].merge_sha,merge);
});
test('unresolved review comments are exposed as facts; no action chosen',()=>{
 const p=pr([], {reviewThreads:[{id:'thread1',isResolved:false,
  comments:{nodes:[{body:'P1: tenant data leak',url:'https://github.com/'+repo+'/pull/488#discussion_r123',
   author:{login:'reviewer'}}]}},{id:'thread2',isResolved:true,comments:{nodes:[]}}]});
 const observed=inspectPrComments(p,repo);
 assert.equal(observed.unresolved_review_threads.length,1);
 assert.equal(observed.unresolved_review_threads[0].summary,'P1: tenant data leak');
 assert.equal('recommended_action' in observed,false);
});
test('incomplete and untrusted scans never imply no open owner decision',()=>{
 const p=pr([mk(123456716,'Please approve the migration.',{trusted:false})]);
 p.comments.pageInfo.hasPreviousPage=true;p.reviewThreads.pageInfo.hasNextPage=true;
 const observed=inspectPrComments(p,repo);
 assert.equal(observed.attention.length,0);
 assert.equal(observed.owner_request_read_incomplete,true);
 assert.equal(observed.review_scan_incomplete,true);
});

test('an unmarked explicit execution action stays visible after merge',()=>{
 const p=pr([mk(123456717,'Single remaining execution action: an authenticated user must select Run workflow in the protected environment.',
  {createdAt:'2026-11-21T10:00:00Z'})],{merged:true});
 const out=inspectPrComments(p,repo,{merged:true});
 assert.equal(out.owner_requests[0].classification,'release_or_live_approval');
 assert.equal(out.attention.length,1);
});

test('one unlinked owner approval report clears only the one earlier scope request',()=>{
 const earlier=mk(123456718,'Please approve Task 17B architecture and exact file scope.');
 const reply=mk(123456719,'Owner approval received in originating chat; scope approved. Continue.',
  {createdAt:'2026-11-19T11:00:00Z'});
 const observed=inspectPrComments(pr([earlier,reply]),repo);
 assert.equal(observed.attention.length,0);
 assert.equal(observed.owner_requests[0].disposition,'resolved_reported');
 assert.equal(observed.owner_requests[0].resolution_source_url,reply.url);
});
test('unlinked approval cannot clear two different outstanding owner requests',()=>{
 const observed=inspectPrComments(pr([
  mk(123456720,'Please approve Task A architecture.'),
  mk(123456721,'Please approve Task B separate scope.'),
  mk(123456722,'Owner approval recorded in the originating chat.',
   {createdAt:'2026-11-19T11:00:00Z'})
 ]),repo);
 assert.equal(observed.attention.length,2);
});
