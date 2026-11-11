// Private lifecycle dashboard section generated from the *same* v1 ledger.
// No public Pages code may import this renderer or request the private JSON.
const cell=v=>String(v===undefined||v===null||v===''?'—':v)
  .replace(/[\r\n\t]/g,' ').replace(/[|<>]/g,' ').replace(/\\/g,'')
  .replace(/[\[\]]/g,'').slice(0,210);
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))
  ?new Date(v).toISOString():'—';
const age=(v,at)=>Number.isFinite(Date.parse(v||''))&&Number.isFinite(Date.parse(at||''))
  ?Math.max(0,Math.floor((Date.parse(at)-Date.parse(v))/60000))+'m':'unknown';
const count=(rows,fn)=>rows.filter(fn).length;
const detail=(name,obj)=>{
  if(!obj||typeof obj!=='object')return [];
  const rows=Object.entries(obj).map(([k,v])=>
    '| '+cell(k)+' | '+cell(Array.isArray(v)?v.map(x=>typeof x==='object'?JSON.stringify(x):x).join('; '):
      typeof v==='object'&&v!==null?JSON.stringify(v):v)+' |');
  return ['','#### '+cell(name),'| Field | Recorded value |','|---|---|',...rows];
};
export function renderLifecycleDashboard(state,{repo='killbill2792/aicafe',now=new Date().toISOString()}={}){
  if(!state||state.version!==1)throw Error('Private ledger required');
  if(!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repo))throw Error('Invalid repository');
  const rows=Object.values(state.lifecycle_v3?.rows||{}).sort((a,b)=>
    String(a.product_id).localeCompare(String(b.product_id))||
    String(a.task_id).localeCompare(String(b.task_id)));
  const header=[
    '## Full development lifecycle ledger (v3)',
    '',
    '> **PRIVATE:** derived exclusively from the verified private task ledger and GitHub evidence.',
    '> These are observed milestones, not ChatGPT claims. UNKNOWN never means NO or GREEN.',
    '',
    '**Last private-ledger write:** '+stamp(state.updated_at)+
      ' · **Last GitHub schedule:** '+stamp(state.schedule_health?.last_schedule_at)+
      ' ('+age(state.schedule_health?.last_schedule_at,now)+' ago).',
    '',
    '**Tasks:** '+rows.length+
      ' · **Coding / verification:** '+count(rows,r=>['CODE_SUBMITTED','VERIFYING'].includes(r.current_stage))+
      ' · **Merge-ready:** '+count(rows,r=>r.current_stage==='MERGE_READY')+
      ' · **Merged awaiting proof:** '+count(rows,r=>r.current_stage==='INTEGRATION_PENDING')+
      ' · **Proven:** '+count(rows,r=>r.current_stage==='TASK_COMPLETE'),
    '',
    '### One task per row: all lifecycle gates',
    '| Product / Task | Stage | Muse delivered | PR | Last commit / age | CI | Codex trigger | Codex result | Acceptance | Parents pending | Merge eligible | Integration | Next responsible action |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  ];
  const tab=rows.map(r=>{
    const pr=r.pr.number?'[#'+r.pr.number+'](https://github.com/'+repo+'/pull/'+r.pr.number+') '+r.pr.state:r.pr.state;
    const commit=r.coding.last_commit_sha?cell(r.coding.last_commit_sha.slice(0,8))+' / '+age(r.coding.last_commit_at,now):'—';
    return '| '+cell(r.product_id)+' / '+cell(r.task_id)+' | '+cell(r.current_stage)+
      ' | '+cell(r.milestones.delivered)+' | '+pr+
      ' | '+commit+' | '+cell(r.ci.status)+' | '+cell(r.codex.request_status)+
      ' | '+cell(r.codex.status)+' | '+cell(r.acceptance.status)+
      ' | '+cell(r.remaining_dependencies.join(', ')||'none')+
      ' | '+cell(r.merge.eligible?'YES':'NO')+' | '+cell(r.integration.status)+
      ' | '+cell(r.monitor.next_actor)+' : '+cell(r.monitor.next_action)+' |';
  });
  const perTask=rows.flatMap(r=>[
    '',
    '### '+cell(r.product_id)+' / '+cell(r.task_id)+' — '+cell(r.title),
    '**Milestone:** '+cell(r.current_stage)+' · **Next:** '+cell(r.monitor.next_actor)+' / '+
      cell(r.monitor.next_action)+' · **Reason:** '+cell(r.monitor.next_reason),
    '**Authenticated chat:** '+(r.dispatch.verified_chat_url?
      '[Open saved coding conversation]('+r.dispatch.verified_chat_url+')':'not verified'),
    '**Blockers:** '+cell(r.merge.blockers.join(', ')||'none'),
    ...detail('Task milestone columns',r.milestones),
    ...detail('Dispatch and chat delivery',r.dispatch),
    ...detail('Coding and Git commits',r.coding),
    ...detail('GitHub pull request',r.pr),
    ...detail('Required CI checks',r.ci),
    ...detail('Codex trigger and review',r.codex),
    ...detail('Acceptance evidence',r.acceptance),
    ...detail('Dependencies', {depends_on:r.dependencies,pending:r.remaining_dependencies}),
    ...detail('Merge evidence',r.merge),
    ...detail('Merged-main integration proof',r.integration),
    ...detail('Monitoring and next action',r.monitor)
  ]);
  const requests=Object.values(state.recovery_requests||{}).slice(-100);
  const commandRows=requests.map(x=>'| '+cell(x.request_id?.slice(0,12))+' | '+cell(x.task_id)+
    ' | '+cell(x.intent)+' | '+cell(x.status)+' | '+cell(x.reason)+
    ' | '+stamp(x.requested_at)+' |');
  return [...header,...(tab.length?tab:['| — | No tasks | — | — | — | — | — | — | — | — | — | — | — |']),
    '',
    '### Muse → GitHub recovery request backlog',
    '| Request | Task | Requested action | Status | Last verified outcome | Asked at |',
    '|---|---|---|---|---|---|',
    ...(commandRows.length?commandRows:['| — | — | No requests | — | — | — |']),
    '',
    '> Recovery requests cause fresh GitHub reconciliation only. They cannot approve scope,',
    '> fake a Codex review, bypass CI or directly force a merge.',
    ...perTask,''
  ].join('\n');
}
