// Lossless private ledger compaction for historical, no-longer-actionable rows.
// The ONE authoritative dispatcher/state.json remains the active source.
// Displaced history is saved as an adjacent PRIVATE Git file in the same CAS commit.
import {createHash} from 'node:crypto';

const TERMINAL=new Set(['resolved','cancelled_no_longer_needed']);
const byteLength=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n','utf8');
const TIME_WINDOW=30*60*1000;
const terminalStub=(n)=>Object.fromEntries([
  'kind','task_id','pr_number','identity','incident_cycle','notice_hash',
  'source_sha','status','created_at','resolved_at','receipt'
].filter(k=>Object.hasOwn(n,k)).map(k=>[k,n[k]]));

export function compactPrivateLedger(source,{now=new Date().toISOString(),
  targetBytes=900_000}={}){
  const stamp=Date.parse(now);
  if(!Number.isFinite(stamp)||!Number.isSafeInteger(targetBytes)||targetBytes<100_000)
    throw Error('Invalid private ledger compaction settings');
  const originalBytes=byteLength(source);
  if(originalBytes<=targetBytes)
    return {state:source,archive:null,before_bytes:originalBytes,after_bytes:originalBytes};
  const state=structuredClone(source);
  const displaced={owner_alerts:{},delayed_wake_history:{},lifecycle_transitions:[]};
  // A delayed self-wake is deduped only for 15 minutes. Keep every recent or
  // malformed timestamp rather than silently losing a potentially live retry.
  for(const [id,v] of Object.entries(state.delayed_wake_history||{})){
    const at=Date.parse(v.requested_at||v.reserved_at||'');
    if(!Number.isFinite(at)||stamp-at<=TIME_WINDOW)continue;
    displaced.delayed_wake_history[id]=v;
    delete state.delayed_wake_history[id];
  }
  // Keep notice identity/status/receipt as a compact tombstone: this preserves
  // dedupe, incident-cycle counters and the ability to requeue withdrawn asks.
  // Planned, claimed, uncertain and submitted notices are never compacted.
  for(const [id,n] of Object.entries(state.owner_alerts||{})){
    if(!TERMINAL.has(n.status))continue;
    const stub=terminalStub(n);
    if(byteLength(stub)>=byteLength(n))continue;
    displaced.owner_alerts[id]=n;
    state.owner_alerts[id]=stub;
  }
  // Lifecycle transitions are derived cache, not signed approval or proof.
  // Preserve every moved transition verbatim in the private archive.
  const log=state.lifecycle_v3;
  if(Array.isArray(log?.transitions)&&log.transitions.length>25){
    displaced.lifecycle_transitions=log.transitions.slice(0,-25);
    log.transitions=log.transitions.slice(-25);
  }
  const count=Object.keys(displaced.owner_alerts).length+
    Object.keys(displaced.delayed_wake_history).length+
    displaced.lifecycle_transitions.length;
  if(!count) return {state:source,archive:null,before_bytes:originalBytes,
    after_bytes:originalBytes};
  const archiveData={version:1,source_updated_at:source.updated_at||null,
    archived_at:now,...displaced};
  const payload=JSON.stringify(archiveData,null,2)+'\n';
  const digest=createHash('sha256').update(payload).digest('hex');
  const path='dispatcher/archives/ledger-history-'+
    now.replace(/[^0-9]/g,'').slice(0,14)+'-'+digest.slice(0,12)+'.json';
  state.ledger_archives||=[];
  state.ledger_archives.push({path,sha256:digest,archived_at:now,
    owner_alerts:Object.keys(displaced.owner_alerts).length,
    delayed_wake_history:Object.keys(displaced.delayed_wake_history).length,
    lifecycle_transitions:displaced.lifecycle_transitions.length});
  const afterBytes=byteLength(state);
  // If still large due to active records, the Git blob reader safely handles
  // it. Never destroy active messages, receipts or approvals to meet a limit.
  return {state,archive:{path,content:payload,sha256:digest},
    before_bytes:originalBytes,after_bytes:afterBytes};
}
