import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {projectEncryptedOwnerView,encryptOwnerView} from './encrypted-owner-payload.mjs';
import {decryptOwnerEnvelope} from '../../docs/encrypted-owner-view.mjs';

const password='correct horse battery staple full random-owner-passphrase-2026';
const fixture=()=>({version:1,updated_at:'2026-11-12T00:42:29Z',
  schedule_health:{last_schedule_at:'2026-11-11T17:26:57Z'},
  tasks:{'8c':{approved:true}},actions:{secretAction:{status:'submitted',
    delivery:{prompt:'PRIVATE PROMPT MUST NOT LEAK'}}},
  owner_alerts:{a:{status:'planned',question:'OWNER SECRET DO NOT LEAK'}},
  lifecycle_v3:{rows:{'8c':{
    product_id:'AI_CAFE',title:'Morning brief',current_stage:'VERIFYING',
    milestones:{approved:'YES',delivered:'UNKNOWN'},
    pr:{number:441,url:'https://github.com/killbill2792/aicafe/pull/441',
      state:'OPEN',head_sha:'a'.repeat(40),last_updated_at:'2026-11-12T00:40:00Z'},
    coding:{last_commit_sha:'a'.repeat(40),last_commit_at:'2026-11-11T23:00:00Z'},
    ci:{status:'GREEN'},codex:{status:'CLEAN',request_status:'CONFIRMED'},
    acceptance:{status:'MISSING'},remaining_dependencies:['8a'],
    merge:{eligible:false},integration:{status:'NOT_APPLICABLE'},
    monitor:{next_actor:'OWNER',next_action:'OWNER_MERGE_REQUIRED',
      next_reason:'privileged_dispatcher_pr'},
    dispatch:{verified_chat_url:'https://chatgpt.com/c/private-chat'}
  }}}});

test('read-only projection exposes only allowlisted lifecycle facts and separate heartbeat',()=>{
 const data=projectEncryptedOwnerView(fixture(),{now:'2026-11-12T00:50:00Z'});
 assert.equal(data.tasks.length,1);
 assert.equal(data.tasks[0].pr.number,441);
 assert.equal(data.tasks[0].stage,'VERIFYING');
 assert.equal(data.owner_notices_pending,1);
 assert.notEqual(data.last_schedule_at,data.ledger_updated_at);
 const plain=JSON.stringify(data);
 assert.doesNotMatch(plain,/PRIVATE PROMPT|OWNER SECRET|private-chat/);
 assert.equal(data.tasks[0].dependencies[0],'8a');
});

test('WebCrypto browser can unlock only correct PBKDF2 + AES-GCM passphrase',async()=>{
 const payload=projectEncryptedOwnerView(fixture());
 const encrypted=encryptOwnerView(payload,password);
 assert.equal(encrypted.kdf.iterations,600000);
 const published=JSON.stringify(encrypted);
 assert.doesNotMatch(published,/Morning brief|private-chat|OWNER SECRET|PRIVATE PROMPT/);
 const out=await decryptOwnerEnvelope(encrypted,password,webcrypto);
 assert.deepEqual(out,payload);
 await assert.rejects(decryptOwnerEnvelope(encrypted,'incorrect-password',webcrypto),
   /Wrong password/);
});

test('modified ciphertext or unauthorised KDF work factor fails closed',async()=>{
 const encrypted=encryptOwnerView(projectEncryptedOwnerView(fixture()),password);
 const body=Buffer.from(encrypted.ciphertext,'base64');body[0]^=1;
 await assert.rejects(decryptOwnerEnvelope({...encrypted,
   ciphertext:body.toString('base64')},password,webcrypto),/Wrong password/);
 await assert.rejects(decryptOwnerEnvelope({...encrypted,kdf:{...encrypted.kdf,
   iterations:1}},password,webcrypto),/Unsupported encrypted snapshot/);
});

test('missing private lifecycle or short passphrase cannot publish',()=>{
 assert.throws(()=>projectEncryptedOwnerView({version:1,tasks:{},actions:{}}),
   /lifecycle snapshot unavailable/);
 assert.throws(()=>encryptOwnerView({tasks:[]},'short'),/24\+ characters/);
});

test('arbitrary injected URLs are excluded even from encrypted projection',()=>{
 const state=fixture();
 state.lifecycle_v3.rows['8c'].pr.url='https://attacker.invalid/private';
 assert.equal(projectEncryptedOwnerView(state).tasks[0].pr.url,null);
});
