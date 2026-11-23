import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importMuseQuestions,readMuseQuestions,syncMuseQuestions,writeMuseQuestion} from './muse-owner-questions.mjs';
import {publishMuseQuestionAcks,githubAttentionComment} from './muse-owner-sync.mjs';
const repo='killbill2792/aicafe',at='2026-11-23T20:00:00Z';
const prUrl='https://github.com/'+repo+'/pull/488';
const q={id:'comment-123456801',pr_number:488,head_sha:'a'.repeat(40),
 question:'Please approve the test files?',url:prUrl+'#issuecomment-123456801'};
const source=()=>({number:488,url:prUrl,owner_requests:[q],
 owner_request_read_incomplete:false,ack_events:[]});
const facts=(p=source())=>({version:1,observed_at:at,prs:[p],merged_prs:[]});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'muse-ack-')),path=join(dir,'owner-questions.json');
 syncMuseQuestions(path,facts(),at);
 return {path,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const edit=(path,action,detail='Owner answered in the original chat')=>{
 const state=readMuseQuestions(path);
 return writeMuseQuestion(path,{id:q.id,expected_revision:state.entries[q.id].revision,
 action,detail},{role:'muse',now:at,notes:{entries:{}}});
};
const urlFor=id=>prUrl+'#issuecomment-'+id;
test('local ignore is immediately effective; GitHub receipt is private-data-free and idempotent',async()=>{
 const f=fixture();try{
  let state=edit(f.path,'ignore','Do not ask me about these files again');
  assert.equal(state.entries[q.id].status,'ignored');
  assert.equal(state.entries[q.id].github_sync.status,'pending');
  assert.doesNotMatch(githubAttentionComment(state.entries[q.id]),/Do not ask me about these files again/);
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,opts});
   return {status:201,json:async()=>({id:123456802,html_url:urlFor(123456802)})};};
  const first=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),
   token:'mock-write-token',fetchImpl,now:at});
  assert.equal(first.published,1);
  assert.equal(calls.length,1);
  assert.equal(calls[0].opts.method,'POST');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer mock-write-token');
  assert.doesNotMatch(calls[0].opts.body,/Do not ask me about these files again/);
  state=readMuseQuestions(f.path);
  assert.equal(state.entries[q.id].github_sync.status,'published_unverified');
  const second=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'mock-write-token',
   fetchImpl,now:at});
  assert.equal(second.published,0);
  assert.equal(calls.length,1,'never blindly replay a successful but unobserved publish');
  const receipt={event_id:state.entries[q.id].github_sync.event_id,
   question_id:q.id,state:'ignored',comment_id:123456802,url:urlFor(123456802),
   created_at:at,actor:'killbill2792'};
  syncMuseQuestions(f.path,facts({...source(),ack_events:[receipt]}),at);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'verified');
  assert.equal(readMuseQuestions(f.path).entries[q.id].status,'ignored');
 }finally{f.cleanup();}
});
test('missing token leaves question locally ignored and pending for later configuration',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Ignore until reopened');
  const first=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:null,now:at});
  assert.equal(first.unconfigured,1);
  assert.equal(readMuseQuestions(f.path).entries[q.id].status,'ignored');
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'pending');
  const sent=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),
   token:'configured',now:at,fetchImpl:async()=>({status:201,json:async()=>({
    id:123456803,html_url:urlFor(123456803)})})});
  assert.equal(sent.published,1);
 }finally{f.cleanup();}
});
test('uncertain network write is NOT retried, only verified on subsequent read',async()=>{
 const f=fixture();try{
  edit(f.path,'answer','Private owner answer');
  let count=0;
  await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'token',
   fetchImpl:async()=>{count++;throw Error('network interrupted after write');},now:at});
  const current=readMuseQuestions(f.path).entries[q.id];
  assert.equal(current.github_sync.status,'uncertain');
  await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'token',
   fetchImpl:async()=>{count++;throw Error('must not resend');},now:at});
  assert.equal(count,1);
  const receipt={event_id:current.github_sync.event_id,question_id:q.id,
   state:'answered',comment_id:123456804,url:urlFor(123456804),created_at:at,actor:'killbill2792'};
  syncMuseQuestions(f.path,facts({...source(),ack_events:[receipt]}),at);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'verified');
 }finally{f.cleanup();}
});
test('403 cannot silently become confirmed and stale read cannot cause a duplicate POST',async()=>{
 const f=fixture();try{
  edit(f.path,'acknowledge','Picked up by Muse');
  let count=0;
  const denied=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'wrong',
   fetchImpl:async()=>{count++;return {status:403};},now:at});
  assert.equal(denied.blocked,1);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'blocked_auth');
  await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'wrong',
   fetchImpl:async()=>{count++;return {status:201};},now:at});
  assert.equal(count,1);
 }finally{f.cleanup();}
});
test('remote GitHub ignore/reopen crosses hosts without granting owner authorization',()=>{
 const initial=importMuseQuestions({version:1,entries:{}},facts(),at);
 const ignore={event_id:q.id+'-r2',question_id:q.id,state:'ignored',
  comment_id:123456805,url:urlFor(123456805),created_at:at,actor:'killbill2792'};
 let local=importMuseQuestions(initial,facts({...source(),ack_events:[ignore]}),at);
 assert.equal(local.entries[q.id].status,'ignored');
 assert.equal(local.entries[q.id].github_sync.status,'verified');
 assert.equal(local.entries[q.id].answer,undefined);
 const reopened={...ignore,event_id:q.id+'-r3',state:'reopened',
  comment_id:123456806,url:urlFor(123456806)};
 local=importMuseQuestions(local,facts({...source(),ack_events:[ignore,reopened]}),at);
 assert.equal(local.entries[q.id].status,'open');
 assert.equal(local.entries[q.id].manually_reopened,true);
 assert.deepEqual(importMuseQuestions(local,facts({...source(),ack_events:[ignore,reopened]}),at),local);
});
test('local new decision remains authoritative while GitHub older sync is pending',()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Ignore');
  const remote={event_id:q.id+'-r2',question_id:q.id,state:'reopened',
   comment_id:123456807,url:urlFor(123456807),created_at:at,actor:'killbill2792'};
  syncMuseQuestions(f.path,facts({...source(),ack_events:[remote]}),at);
  const stored=readMuseQuestions(f.path).entries[q.id];
  assert.equal(stored.status,'ignored');
  assert.ok(stored.github_sync_conflict);
 }finally{f.cleanup();}
});

test('late older GitHub event cannot replace a newer explicit reopen',()=>{
 const initial=importMuseQuestions({version:1,entries:{}},facts(),at);
 const newest={event_id:q.id+'-r6-aaaaaaaaaaaaaaaa',question_id:q.id,
  state:'reopened',comment_id:123456920,url:urlFor(123456920),
  created_at:at,actor:'killbill2792'};
 const older={...newest,event_id:q.id+'-r5-bbbbbbbbbbbbbbbb',
  state:'ignored',comment_id:123456921,url:urlFor(123456921)};
 const next=importMuseQuestions(initial,facts({...source(),ack_events:[newest,older]}),at);
 assert.equal(next.entries[q.id].status,'open');
 assert.equal(next.entries[q.id].last_github_sequence,6);
});
test('same-revision concurrent couriers create a visible conflict rather than last-writer wins',()=>{
 const initial=importMuseQuestions({version:1,entries:{}},facts(),at);
 const one={event_id:q.id+'-r3-aaaaaaaaaaaaaaaa',question_id:q.id,
  state:'ignored',comment_id:123456922,url:urlFor(123456922),
  created_at:at,actor:'muse'};
 const two={...one,event_id:q.id+'-r3-bbbbbbbbbbbbbbbb',state:'reopened',
  comment_id:123456923,url:urlFor(123456923),actor:'grok'};
 const next=importMuseQuestions(initial,facts({...source(),ack_events:[one,two]}),at);
 assert.equal(next.entries[q.id].status,'ignored');
 assert.equal(next.entries[q.id].last_github_sequence,3);
 assert.ok(next.entries[q.id].github_sync_conflict);
});
