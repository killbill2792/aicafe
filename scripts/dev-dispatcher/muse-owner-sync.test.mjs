import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,utimesSync,unlinkSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
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
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'no_token');
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

test('offline or unauthorized GitHub write cannot let an older receipt erase a local answer',()=>{
 for(const blocked of ['no_token','blocked_auth']){
  const f=fixture();try{
   edit(f.path,'answer','A newer private answer remains authoritative');
   const old={event_id:q.id+'-r1-aaaaaaaaaaaaaaaa',question_id:q.id,
    state:'resolved',comment_id:123456999,url:urlFor(123456999),
    created_at:at,actor:'killbill2792',sequence:1};
   const state=readMuseQuestions(f.path);
   state.entries[q.id].github_sync.status=blocked;
   writeFileSync(f.path,JSON.stringify(state));
   const imported=syncMuseQuestions(f.path,facts({...source(),ack_events:[old]}),at);
   assert.equal(imported.entries[q.id].status,'answered');
   assert.equal(imported.entries[q.id].answer,'A newer private answer remains authoritative');
   assert.ok(imported.entries[q.id].github_sync_conflict);
   assert.equal(imported.entries[q.id].github_sync.status,blocked);
  }finally{f.cleanup();}
 }
});
test('dead publication process lock recovers without resending an uncertain POST',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Keep ignored locally');
  const pending=readMuseQuestions(f.path).entries[q.id].github_sync;
  writeFileSync(f.path+'.publish.lock',JSON.stringify({
   version:1,pid:999999999,observed_at:at,
   in_flight:{question_id:q.id,event_id:pending.event_id}})+'\n');
  let sends=0;
  const out=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'mock',
   now:at,fetchImpl:async()=>{sends++;throw Error('must not blindly repeat');}});
  assert.equal(out.blocked,0);
  assert.equal(sends,0);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'uncertain');
  assert.equal(existsSync(f.path+'.publish.lock'),false);
 }finally{f.cleanup();}
});
test('active publisher lock is retained rather than stolen by another process',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Keep locally');
  writeFileSync(f.path+'.publish.lock',JSON.stringify({
   version:1,pid:process.pid,observed_at:at,in_flight:null})+'\n');
  const out=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'mock',
   now:at,fetchImpl:async()=>{throw Error('unexpected publication');}});
  assert.equal(out.blocked,1);
  assert.equal(existsSync(f.path+'.publish.lock'),true);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'pending');
 }finally{f.cleanup();}
});
test('legacy orphaned empty lock is recovered without risking duplicate requests',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Keep locally');
  const lock=f.path+'.publish.lock';
  writeFileSync(lock,'');
  const old=new Date(Date.now()-20*60*1000);
  utimesSync(lock,old,old);
  const out=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'mock',
   now:at,fetchImpl:async()=>{throw Error('must inspect GitHub first');}});
  assert.equal(out.blocked,0);
  assert.equal(existsSync(lock),false);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'uncertain');
 }finally{f.cleanup();}
});

test('crashed local question-state transaction lock does not stall future owner decisions',()=>{
 const f=fixture();try{
  const lock=f.path+'.lock';
  writeFileSync(lock,JSON.stringify({pid:999999999,created_at:at})+'\n');
  const edited=edit(f.path,'ignore','This owner request can be ignored');
  assert.equal(edited.entries[q.id].status,'ignored');
  assert.equal(existsSync(lock),false);
 }finally{f.cleanup();}
});
test('live question-state transaction is not overwritten by a second process',()=>{
 const f=fixture();try{
  const lock=f.path+'.lock';
  writeFileSync(lock,JSON.stringify({pid:process.pid,created_at:at})+'\n');
  assert.throws(()=>edit(f.path,'ignore','Do not ignore while another writer is active'),
   /lock held by another process/);
  assert.equal(readMuseQuestions(f.path).entries[q.id].status,'open');
 }finally{f.cleanup();}
});

test('recovery treats an interrupted no-token send as uncertain, not safely retryable',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Keep dismissed');
  const without=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:null,now:at});
  assert.equal(without.unconfigured,1);
  const state=readMuseQuestions(f.path).entries[q.id];
  assert.equal(state.github_sync.status,'no_token');
  writeFileSync(f.path+'.publish.lock',JSON.stringify({
   version:1,pid:999999999,observed_at:at,
   in_flight:{question_id:q.id,event_id:state.github_sync.event_id}})+'\n');
  let sends=0;
  const recovered=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'now-enabled',now:at,
   fetchImpl:async()=>{sends++;throw Error('must not send again');}});
  assert.equal(recovered.blocked,0);
  assert.equal(sends,0);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'uncertain');
 }finally{f.cleanup();}
});
test('successful POST with a blocked outcome save remains uncertain and is never repeated',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Dismiss request');
  let sent=0;
  const fetchImpl=async()=>{
   sent++;
   // Simulate the second Muse process holding the question-store lock
   // exactly after GitHub accepted the POST, before the result is saved.
   writeFileSync(f.path+'.lock',JSON.stringify({pid:process.pid})+'\n');
   return {status:201,json:async()=>({id:123456911,html_url:urlFor(123456911)})};
  };
  const attempted=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),
   token:'token',now:at,fetchImpl});
  assert.equal(attempted.uncertain,1);
  assert.equal(sent,1);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'uncertain');
  unlinkSync(f.path+'.lock');
  const again=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),
   token:'token',now:at,fetchImpl:async()=>{sent++;throw Error('should never duplicate');}});
  assert.equal(sent,1);
  assert.equal(again.published,0);
 }finally{f.cleanup();}
});
test('failure to record write-ahead uncertainty prevents POST entirely',async()=>{
 const f=fixture();try{
  edit(f.path,'ignore','Dismiss request');
  writeFileSync(f.path+'.lock',JSON.stringify({pid:process.pid})+'\n');
  let sends=0;
  const out=await publishMuseQuestionAcks({repo,path:f.path,facts:facts(),token:'token',now:at,
   fetchImpl:async()=>{sends++;throw Error('not allowed');}});
  assert.equal(out.blocked,1);
  assert.equal(sends,0);
  assert.equal(readMuseQuestions(f.path).entries[q.id].github_sync.status,'pending');
 }finally{f.cleanup();}
});

test('question write-ahead state survives immediate forced child-process exit',()=>{
 const f=fixture();try{
  const child=`import {readMuseQuestions,writeMuseQuestion} from './scripts/dev-dispatcher/muse-owner-questions.mjs';
   const path=process.env.MUSE_CHILD_Q_PATH;
   const before=readMuseQuestions(path).entries['comment-123456801'];
   writeMuseQuestion(path,{id:before.id,expected_revision:before.revision,
    action:'ignore',detail:'Durably recorded before GitHub POST'},
    {role:'muse',now:'2026-11-23T20:00:00Z',notes:{entries:{}}});
   process.exit(99);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',child],{
   cwd:process.cwd(),env:{...process.env,MUSE_CHILD_Q_PATH:f.path},encoding:'utf8'});
  assert.equal(result.status,99,result.stderr);
  const saved=readMuseQuestions(f.path).entries[q.id];
  assert.equal(saved.status,'ignored');
  assert.equal(saved.github_sync.status,'pending');
  assert.match(saved.github_sync.event_id,/^comment-123456801-r\d+-[a-f0-9]{16}$/);
  const stray=readdirSync(f.path.slice(0,f.path.lastIndexOf('/'))).
   filter(name=>name.includes('.tmp-')||name.endsWith('.lock'));
  assert.deepEqual(stray,[],'no unflushed temporary or stale local lock remains');
 }finally{f.cleanup();}
});
