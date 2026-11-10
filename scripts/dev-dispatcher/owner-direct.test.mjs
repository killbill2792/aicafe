import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileGithub,decideNudge} from './core.mjs'; const head='b'.repeat(40); const prior={version:1,tasks:{x:{task_id:'x',pr_number:422,approved:true,
 agent:'chatgpt',status:'review_fixing',github_state:'open',head_sha:'a'.repeat(40),
 latest_owner_comment_at:'2026-11-10T18:00:00Z',
 conversation_ref:'https://chatgpt.com/c/coding-1'}},
 actions:{old:{task_id:'x',status:'planned',head_sha:'a'.repeat(40),type:'codex_comments'}}};
test('owner merge immediately supersedes stale coding prompt and records exact merge SHA',()=>{
 const merged=reconcileGithub(prior,[],{422:{merged:true,merge_sha:head}}); assert.equal(merged.tasks.x.status,'merged'); assert.equal(merged.tasks.x.merge_sha,head); assert.equal(merged.actions.old.status,'cancelled_owner_state_changed'); });
test('owner comment approval and direct push win over a stale planned prompt',()=>{
 const live=[{pr_number:422,head_sha:head,base_sha:'c'.repeat(40),base_current:false,
  github_state:'open',draft:false,ci_state:'pending',codex_state:'pending',
  last_commit_at:'2026-11-10T19:00:00Z',owner_direct_push:true,last_commit_actor:'owner',
  owner_approved:true,owner_directive:'approved',owner_directive_id:7,
  latest_owner_comment:'approved',latest_owner_comment_at:'2026-11-10T19:01:00Z'}]; const copy=reconcileGithub(prior,live); assert.equal(copy.actions.old.status,'cancelled_stale_head'); assert.equal(copy.tasks.x.owner_direct_action.head_sha,head); assert.equal(copy.tasks.x.owner_directive_record.kind,'approved'); assert.equal(copy.tasks.x.base_current,false); assert.equal(decideNudge(copy.tasks.x).kind,'hold'); });
test('unresolved current-head Codex findings stay actionable without idle prompts',()=>{
 const rec={task_id:'x',approved:true,pr_number:422,github_state:'open',
  conversation_ref:'https://chatgpt.com/c/coding-1',codex_state:'findings',
  head_sha:head,codex_review_at:'2026-11-10T18:00:00Z',ci_state:'success'}; const proposal=decideNudge(rec); assert.equal(proposal.action,'codex_comments'); const delivered=decideNudge({...rec,last_action_key:proposal.key,submission_state:'submitted'}); assert.equal(delivered.kind,'hold'); assert.equal(decideNudge({...rec,codex_state:'clean'}).reason,'no_coder_work'); });
