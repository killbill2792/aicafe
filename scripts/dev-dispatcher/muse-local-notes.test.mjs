import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyMuseNote,readMuseNotes,writeMuseNote,validChatUrl} from './muse-local-notes.mjs';

const now='2026-11-16T20:00:00Z';
const link='https://chatgpt.com/g/g-p-aicafe/c/1234abcd-5678-90ef';
const edit={task_id:'15a',pr_number:488,chat_url:link,stage:'working',
 note:'Continue the existing code review',expected_revision:0};
test('chat links must be exact trusted conversation URLs',()=>{
 assert.equal(validChatUrl(link),true);
 assert.equal(validChatUrl('https://chatgpt.com/c/12345678-1234'),true);
 for(const bad of ['http://chatgpt.com/c/123','https://chatgpt.com.evil.test/c/123',
  'https://chatgpt.com/c/123?token=secret','https://chatgpt.com/g/g-p/xyz',
  'https://chatgpt.com@evil.test/c/123','file:///tmp/foo']){
  assert.equal(validChatUrl(bad),false,bad);
 }
});
test('Muse can write coordination-only fields; not approvals or CI',()=>{
 const state={version:1,entries:{}};
 const updated=applyMuseNote(state,edit,{role:'muse',now});
 assert.equal(updated.entries['15a'].chat_url,link);
 assert.equal(updated.entries['15a'].updated_by,'muse');
 assert.equal(updated.entries['15a'].revision,1);
 assert.equal(state.entries['15a'],undefined);
 assert.throws(()=>applyMuseNote(state,{...edit,ci_state:'success'},{
  role:'muse',now}),/Unsupported note field/);
 assert.throws(()=>applyMuseNote(state,edit,{role:'anonymous',now}),/Authenticated/);
 assert.throws(()=>applyMuseNote(updated,edit,{role:'muse',now}),/conflict/);
});
test('a Muse stage-only update preserves an already saved chat URL and owner note',()=>{
 const before=applyMuseNote({version:1,entries:{}},edit,{role:'owner',now});
 const after=applyMuseNote(before,{task_id:'15a',stage:'ready_review',
  expected_revision:1},{role:'muse',now:'2026-11-16T20:10:00Z'});
 assert.equal(after.entries['15a'].chat_url,link);
 assert.equal(after.entries['15a'].pr_number,488);
 assert.equal(after.entries['15a'].note,edit.note);
 assert.equal(after.entries['15a'].stage,'ready_review');
 assert.throws(()=>applyMuseNote(after,{task_id:'15a',expected_revision:2},
  {role:'muse',now}),/At least one coordination field/);
});
test('malformed owner/auth claims cannot enter local status',()=>{
 for(const change of [
  {stage:'merged'},{stage:'approved'},{chat_url:'https://evil.test/a'},
  {pr_number:-1},{task_id:'../private'},{note:'a\u0000b'},
  {expected_revision:null},{ci_state:'success'}]){
  assert.throws(()=>applyMuseNote({version:1,entries:{}},{...edit,...change},{
   role:'owner',now}));
 }
});
test('local notes survive offline restart, are private and use compare-and-swap',()=>{
 const dir=mkdtempSync(join(tmpdir(),'muse-notes-')),path=join(dir,'private','notes.json');
 try{
  const first=writeMuseNote(path,edit,{role:'muse',now});
  assert.equal(first.entries['15a'].revision,1);
  assert.equal(readMuseNotes(path).entries['15a'].chat_url,link);
  assert.equal(statSync(path).mode&0o777,0o600);
  assert.equal(statSync(join(dir,'private')).mode&0o777,0o700);
  const second=writeMuseNote(path,{...edit,expected_revision:1,
    stage:'waiting_owner',note:'Owner architecture review requested'},{
      role:'owner',now:'2026-11-16T20:10:00Z'});
  assert.equal(second.entries['15a'].stage,'waiting_owner');
  assert.throws(()=>writeMuseNote(path,{...edit,expected_revision:0},{
   role:'muse',now}),/conflict/);
  assert.equal(readMuseNotes(path).entries['15a'].revision,2);
  assert.ok(readFileSync(path,'utf8').includes('waiting_owner'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
