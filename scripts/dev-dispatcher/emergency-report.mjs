#!/usr/bin/env node
import {publishEmergencyViaGit} from './git-operations.mjs';
import {settings} from './settings.mjs';
// A trusted workflow_run observer reports the FAILED run, not its own ID.
// A Git fallback from the failed workflow and an observer of that same run
// use the same incident identity, so they cannot duplicate owner notices.
const failedId=String(process.env.DISPATCH_FAILED_RUN_ID||process.env.GITHUB_RUN_ID||'unknown');
if(!/^\d+$/.test(failedId))throw Error('Invalid failed workflow run ID');
const id='run:'+failedId+':failure';
const url='https://github.com/'+(process.env.GITHUB_REPOSITORY||settings.repo)+
  '/actions/runs/'+failedId;
try{
 const r=publishEmergencyViaGit({
   token:process.env.DISPATCH_LEDGER_TOKEN,identity:id,
   message:String(process.env.DISPATCH_FAILED_WORKFLOW||process.env.GITHUB_WORKFLOW||'Dispatcher workflow')+
    ' failed or was cancelled; GitHub API may be unavailable. '+url,
   needs:'Muse deliver owner notice; inspect original workflow failure'});
 console.log('Emergency Muse notice '+r.status+'; delivery unconfirmed until Muse receipt');
}catch(error){
 console.error('EMERGENCY MUSE DELIVERY UNCONFIRMED: '+String(error.message).slice(0,160));
 process.exitCode=1;
}
