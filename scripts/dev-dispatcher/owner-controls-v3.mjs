// Restricted owner edits to the private lifecycle ledger.
// These controls can change presentation, dispatch priority or alert timing;
// they NEVER alter signed task scope, review/CI facts, permissions or merge gates.
const VALID_ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const KEYS=new Set(['note','dispatch_priority','pause_new_dispatch','stall_minutes','escalation_minutes']);
export function validateDashboardEdit(edit){
 if(!edit||typeof edit!=='object'||Array.isArray(edit)||!KEYS.has(edit.field))
   throw Error('Unsupported dashboard control');
 if(!VALID_ID.test(edit.task_id||'')&&edit.task_id!=='__global__')
   throw Error('Invalid task identifier');
 if(edit.field==='note'){
   if(edit.task_id==='__global__'||typeof edit.value!=='string'||edit.value.length>1200||
     /[\x00-\x08\x0b-\x1f\x7f]/.test(edit.value))throw Error('Invalid owner note');
 }else if(edit.field==='pause_new_dispatch'){
   if(edit.task_id==='__global__'||typeof edit.value!=='boolean')throw Error('Invalid dispatch pause');
 }else if(edit.field==='dispatch_priority'){
   if(edit.task_id==='__global__'||!Number.isInteger(edit.value)||edit.value<0||edit.value>100)
     throw Error('Invalid dispatch priority');
 }else if(edit.field==='stall_minutes'||edit.field==='escalation_minutes'){
   const lo=edit.field==='stall_minutes'?5:15,hi=edit.field==='stall_minutes'?180:1440;
   if(edit.task_id!=='__global__'||!Number.isInteger(edit.value)||edit.value<lo||edit.value>hi)
     throw Error('Invalid observation threshold');
 }
 return true;
}
export function applyOwnerDashboardEdit(state,edit,{role,now=new Date().toISOString()}={}){
 if(role!=='owner')throw Error('Owner authentication required');
 validateDashboardEdit(edit);
 if(state?.version!==1||!state.tasks||!state.actions)throw Error('Invalid dispatcher ledger');
 if(!Number.isFinite(Date.parse(now)))throw Error('Invalid timestamp');
 if(!Number.isSafeInteger(edit.expected_revision)||edit.expected_revision<0)
   throw Error('Expected control revision required');
 const next=structuredClone(state);
 next.owner_controls||={revision:0,per_task:{},monitoring:{}};
 const ctl=next.owner_controls;
 if(ctl.revision!==edit.expected_revision)throw Error('Dashboard edit conflict: refresh and retry');
 const target=edit.task_id==='__global__'?ctl.monitoring:(ctl.per_task[edit.task_id]||={});
 const old=target[edit.field];
 if(old===edit.value)return next;
 target[edit.field]=edit.value;
 ctl.revision++;
 ctl.last_updated_at=now;
 ctl.history||=[];
 ctl.history.push({task_id:edit.task_id,field:edit.field,from:old??null,
   to:edit.value,actor:'authenticated_owner',at:now});
 if(ctl.history.length>300)ctl.history=ctl.history.slice(-300);
 return next;
}
export function dispatchPreferences(state={}){
 const ctl=state?.owner_controls||{};
 const perTask=ctl.per_task||{};
 return {priority:Object.fromEntries(Object.entries(perTask)
   .filter(([,v])=>Number.isInteger(v.dispatch_priority))
   .map(([id,v])=>[id,v.dispatch_priority])),
  paused:new Set(Object.entries(perTask)
    .filter(([,v])=>v.pause_new_dispatch===true).map(([id])=>id)),
  stall_minutes:ctl.monitoring?.stall_minutes??null,
  escalation_minutes:ctl.monitoring?.escalation_minutes??null};
}
