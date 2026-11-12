#!/usr/bin/env node
// Muse host: write one durable recovery command by ordinary Git, no REST.
import {readFileSync} from 'node:fs';
import {pushMuseGitRecovery} from './git-recovery-transport.mjs';
function main(){
 const request=JSON.parse(readFileSync(0,'utf8'));
 const result=pushMuseGitRecovery({
  request,secret:process.env.DISPATCH_MUSE_RECOVERY_KEY,
  token:process.env.MUSE_PRIVATE_GIT_TOKEN
 });
 // Never print credentials or entire private command payload.
 console.log(JSON.stringify(result));
}
try{main();}
catch(error){
 console.error('Muse Git recovery submission not verified: '+
  String(error.message||'unavailable').slice(0,160));
 process.exitCode=1;
}
