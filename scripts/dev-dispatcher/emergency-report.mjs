#!/usr/bin/env node
import {publishEmergencyViaGit} from './git-operations.mjs';
import {settings} from './settings.mjs';
const id='run:'+String(process.env.GITHUB_RUN_ID||'unknown')+':failure';
const url='https://github.com/'+(process.env.GITHUB_REPOSITORY||settings.repo)+
  '/actions/runs/'+String(process.env.GITHUB_RUN_ID||'unknown');
try{
 const r=publishEmergencyViaGit({
   token:process.env.DISPATCH_LEDGER_TOKEN,identity:id,
   message:'Dispatcher workflow failed; GitHub API may be unavailable. '+url,
   needs:'Muse deliver owner notice; inspect original workflow failure'});
 console.log('Emergency Muse notice '+r.status+'; delivery unconfirmed until Muse receipt');
}catch(error){
 console.error('EMERGENCY MUSE DELIVERY UNCONFIRMED: '+String(error.message).slice(0,160));
 process.exitCode=1;
}
