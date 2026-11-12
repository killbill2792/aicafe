#!/usr/bin/env node
// Muse host: persist one authenticated recovery command via Git, not REST.
// Paste no credentials into a chat, PR, issue or command JSON.
import {readFileSync} from 'node:fs';
import {settings} from './settings.mjs';
import {recoveryIdentity} from './recovery-v3.mjs';
import {pushMuseGitRecovery} from './git-recovery-transport.mjs';
function main(){
 const raw=JSON.parse(readFileSync(0,'utf8'));
 const actor=process.env.DISPATCH_MUSE_ACTOR;
 if(!actor||raw.actor&&raw.actor!==actor||raw.repo&&raw.repo!==settings.repo)
   throw Error('Muse recovery actor or repository not configured');
 const request={version:1,repo:settings.repo,actor,
  intent:raw.intent,task_id:raw.task_id??null,
  pr_number:raw.pr_number??null,
  expected_head_sha:raw.expected_head_sha??null,
  requested_at:raw.requested_at||new Date().toISOString()};
 const request_id=recoveryIdentity(request);
 if(raw.request_id&&raw.request_id!==request_id)
   throw Error('Provided Muse recovery request identity is inconsistent');
 const result=pushMuseGitRecovery({
  request:{...request,request_id},
  secret:process.env.DISPATCH_MUSE_RECOVERY_KEY,
  token:process.env.MUSE_PRIVATE_GIT_TOKEN
 });
 // Print only the durable request identifier and private relative path.
 console.log(JSON.stringify(result));
}
try{main();}
catch(error){
 console.error('Muse Git recovery submission not verified: '+
  String(error.message||'unavailable').slice(0,160));
 process.exitCode=1;
}
