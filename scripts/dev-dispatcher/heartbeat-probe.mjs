// Independent, read-only liveness contract for a Muse-side host.
// This probe reads the existing private ledger from a locally fetched file.
// It performs NO GitHub Actions/API calls and NEVER sends browser prompts.
// Muse must schedule it outside GitHub; repository code alone cannot do so.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function assessDispatcherHeartbeat(state,{
 now=new Date().toISOString(),scheduleGapMinutes=15
}={}) {
 const clock=Date.parse(now);
 if(!Number.isFinite(clock)||!Number.isFinite(scheduleGapMinutes)||
    scheduleGapMinutes<=0)throw Error('Invalid heartbeat observation');
 const timestamp=state?.schedule_health?.last_schedule_at;
 const last=Date.parse(timestamp||'');
 if(!Number.isFinite(last))
  return {status:'unverified',kind:'missing_schedule_heartbeat',
   message:'No successful GitHub schedule heartbeat is recorded'};
 if(last>clock+5*60000)
  return {status:'unverified',kind:'schedule_clock_skew',
   message:'Recorded schedule heartbeat is in the future'};
 const minutes=Math.max(0,Math.floor((clock-last)/60000));
 if(clock-last>scheduleGapMinutes*60000)
  return {status:'stale',kind:'missed_schedule',last_schedule_at:timestamp,
   gap_minutes:minutes,message:'No verified schedule heartbeat within the configured gap'};
 return {status:'healthy',last_schedule_at:timestamp,gap_minutes:minutes};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  if(process.argv.length!==3)throw Error('Usage: node heartbeat-probe.mjs <local-private-ledger.json>');
  const state=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const result=assessDispatcherHeartbeat(state);
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status!=='healthy')process.exitCode=2;
 }catch{
  process.stderr.write('Cannot verify private dispatcher heartbeat\n');
  process.exitCode=2;
 }
}
