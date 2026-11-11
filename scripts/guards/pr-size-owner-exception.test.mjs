import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerApproved427} from './pr-size.mjs';
const repo='killbill2792/aicafe',sha='a'.repeat(40),p={number:427,head:{sha,repo:{full_name:repo},
 ref:'feat/dispatcher-per-repo-event-driven-20261110'}};
test('size exception is only authenticated PR 427 in the exact repository and branch',()=>{
 assert.equal(ownerApproved427({pull_request:p},repo,sha),true);
 assert.equal(ownerApproved427({pull_request:{...p,number:428}},repo,sha),false);
 assert.equal(ownerApproved427({pull_request:{...p,head:{...p.head,ref:'feat/unrelated'}}},repo,sha),false);
 assert.equal(ownerApproved427({pull_request:p},'other/repo',sha),false);
 assert.equal(ownerApproved427({pull_request:{...p,head:{...p.head,repo:{full_name:'other/repo'}}}},repo,sha),false);
 assert.equal(ownerApproved427({pull_request:null},repo,sha),false);
 assert.equal(ownerApproved427({pull_request:p},repo,'HEAD'),false);
 assert.equal(ownerApproved427({pull_request:p},repo,'b'.repeat(40)),false);
});
