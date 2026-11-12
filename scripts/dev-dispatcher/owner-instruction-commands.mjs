// Owner speech relayed by the VERIFIED Muse GitHub courier. The owner has
// explicitly delegated bounded operational commands without hashtags.
// Interpret one unambiguous instruction; never synthesize approval or GitHub facts.
import {settings} from './settings.mjs';
import {applyOwnerDashboardEdit} from './owner-controls-v3.mjs';
import {recordRecoveryEvent,recoveryIdentity} from './recovery-v3.mjs';

const TASK='([A-Za-z0-9][A-Za-z0-9_-]{0,63})';
const taskPattern=new RegExp('(?:task\\s*#?\\s*)'+TASK,'i');
const reasonableText=t=>typeof t==='string'&&t.length>0&&t.length<=2000&&
  !/[\x00-\x08\x0b-\x1f\x7f]/.test(t);
const textBody=t=>t.trim().replace(/[.!?]+$/,'').replace(
  /^(?:(?:the\s+)?owner\s+(?:said|says)(?:\s+that)?\s*[:,-]?\s*)/i,'').trim();
const pickId=s=>s.match(taskPattern)?.[1]||null;
const number=s=>Number(s);
const command=(kind,other={})=>({kind,...other});

export function parseOwnerInstruction(text){
 if(!reasonableText(text))return null;
 const s=textBody(text);
 let m;
 if((m=s.match(/^\s*(?:set|make|change|update)\s+(?:the\s+)?(?:dispatch\s+)?priority\s+(?:of|for)\s+task\s*#?\s*([\w-]+)\s+(?:to|as)\s+(\d{1,3})\s*$/i))||
    (m=s.match(/^\s*(?:set|make|change|update)\s+task\s*#?\s*([\w-]+)\s+(?:dispatch\s+)?priority\s+(?:to|as)\s+(\d{1,3})\s*$/i)))
   return command('control',{task_id:m[1],field:'dispatch_priority',value:number(m[2])});
 if((m=s.match(/^\s*(pause|resume|unpause|restart)\s+(?:new\s+)?(?:dispatch\s+for\s+)?task\s*#?\s*([\w-]+)\s*$/i)))
   return command('control',{task_id:m[2],field:'pause_new_dispatch',value:m[1].toLowerCase()==='pause'});
 if((m=s.match(/^\s*(?:add|save|write|set)\s+(?:an?\s+)?note\s+(?:to|for|on)\s+task\s*#?\s*([\w-]+)\s*[:,-]?\s+([\s\S]+)$/i)))
   return command('control',{task_id:m[1],field:'note',value:m[2].trim()});
 if((m=s.match(/^\s*(?:set|change|update)\s+(?:(?:the|global)\s+)?(stall|escalation)\s+(?:timeout|threshold|timer|time)\s+to\s+(\d{1,4})\s*(?:minutes?|mins?)\s*$/i)))
   return command('control',{task_id:'__global__',field:m[1].toLowerCase()==='stall'?'stall_minutes':'escalation_minutes',value:number(m[2])});
 if(/^(?:refresh|recheck|reconcile|check|update)\s+(?:the\s+)?(?:github\s+)?(?:dispatcher|task\s+queue|dashboard|ledger)(?:\s+(?:status|now))?$/i.test(s))
   return command('recovery',{intent:'RECONCILE',task_id:null});
 if((m=s.match(/^\s*(?:check|recheck|reconcile|refresh|update)\s+(?:the\s+)?(?:status\s+(?:of|for)\s+)?task\s*#?\s*([\w-]+)(?:\s+(?:status|now))?\s*$/i)))
   return command('recovery',{intent:'RECONCILE',task_id:m[1],global:true});
 if((m=s.match(/^\s*(?:(?:please|have\s+github\s+to?)\s+)?(?:request|retry|re-request)\s+(?:a\s+)?codex\s+review\s+(?:on|for)\s+pr\s*#?\s*(\d+)\s*$/i)))
   return command('recovery',{intent:'REQUEST_CODEX_IF_ELIGIBLE',pr_number:number(m[1])});
 if((m=s.match(/^\s*(?:retry|rerun|re-run|restart)\s+(?:the\s+)?ci\s+(?:on|for)\s+pr\s*#?\s*(\d+)\s*$/i)))
   return command('recovery',{intent:'RETRY_CI_IF_SAFE',pr_number:number(m[1])});
 if((m=s.match(/^\s*(?:(?:please|have\s+github\s+to?)\s+)?merge\s+pr\s*#?\s*(\d+)(?:\s+(?:if\s+eligible|if\s+ready|when\s+eligible))?\s*$/i)))
   return command('recovery',{intent:'MERGE_IF_ELIGIBLE',pr_number:number(m[1])});
 if((m=s.match(/^\s*(?:verify|check)\s+(?:the\s+)?integration\s+(?:proof\s+)?(?:for|of)\s+task\s*#?\s*([\w-]+)\s*$/i)))
   return command('recovery',{intent:'VERIFY_INTEGRATION',task_id:m[1]});
 return null;
}
const findTaskByPr=(state,n)=>{
 const ids=Object.entries(state.tasks||{}).filter(([,t])=>t?.pr_number===n);
 return ids.length===1?ids[0][0]:null;
};
const validTarget=(target,kind,parsed)=>{
 if(!target||typeof target!=='object'||Array.isArray(target))return false;
 if(target.task_id!=null&&target.task_id!=='__global__'&&
    parsed.task_id&&target.task_id!==parsed.task_id)return false;
 if(target.pr_number!=null&&parsed.pr_number!=null&&target.pr_number!==parsed.pr_number)return false;
 if(kind==='control'&&target.pr_number!=null)return false;
 return true;
};
// This is reached only after inbox.inspectReceipts verified the GitHub commit
// actor and receiptFilename. 'owner' in the words is not authentication.
export function applyMuseOwnerInstruction(state,receipt,{actor,now=new Date().toISOString()}={}){
 if(!actor||!receipt||!reasonableText(receipt.text)||
   !/^[A-Za-z0-9_-]{1,100}$/.test(receipt.event_id||'')||
   !receipt.target||typeof receipt.target!=='object')
   throw Error('Unverified owner instruction');
 if(state.owner_instruction_events?.[receipt.event_id])return state;
 const next=structuredClone(state);
 next.owner_instruction_events||={};
 const event={target:receipt.target,text:receipt.text.slice(0,400),
   courier:'muse',verified_actor:actor,
   at:receipt.submitted_at||now,status:'BLOCKED',reason:'unsupported_owner_command'};
 next.owner_instruction_events[receipt.event_id]=event;
 const parsed=parseOwnerInstruction(receipt.text);
 if(!parsed)return next;
 event.command_kind=parsed.kind==='control'?parsed.field:parsed.intent;
 if(!validTarget(receipt.target,parsed.kind,parsed)){
   event.reason='target_does_not_match_owner_words';return next;
 }
 if(parsed.kind==='control'){
   if(parsed.task_id!=='__global__'&&!next.tasks?.[parsed.task_id]&&
      !next.lifecycle_v3?.rows?.[parsed.task_id]){
     event.reason='unknown_task';return next;
   }
   try{
     const applied=applyOwnerDashboardEdit(next,{
       task_id:parsed.task_id,field:parsed.field,value:parsed.value,
       expected_revision:next.owner_controls?.revision||0
     },{role:'owner',now});
     applied.owner_instruction_events[receipt.event_id].status='APPLIED';
     applied.owner_instruction_events[receipt.event_id].reason='owner_control_saved';
     applied.owner_instruction_events[receipt.event_id].control_revision=
       applied.owner_controls?.revision||0;
     return applied;
   }catch{
     event.reason='unsupported_or_invalid_control_value';return next;
   }
 }
 // A request is a hint to existing GitHub fact/merge gates. It is NOT a
 // verified PR/CI/Codex fact or permission to merge a blocked PR.
 let taskId=parsed.task_id||null,prNumber=parsed.pr_number||null,head=null;
 if(parsed.global){ // Unlinked tasks require a global GitHub reconcile.
   if(!next.tasks?.[taskId]&&!next.lifecycle_v3?.rows?.[taskId]){
     event.reason='unknown_task';return next;
   }
   taskId=null;
 }else if(taskId||prNumber){
   if(prNumber){
     const found=findTaskByPr(next,prNumber);
     if(!found){event.reason='pr_not_linked_to_task';return next;}
     taskId=found;
   }
   const task=next.tasks?.[taskId];
   if(!task){event.reason='unknown_task';return next;}
   if(task.pr_number!==prNumber&&prNumber!==null){
     event.reason='task_pr_mismatch';return next;
   }
   prNumber=task.pr_number;
   head=task.head_sha;
   if(!Number.isSafeInteger(prNumber)||prNumber<1||
      !/^[a-f0-9]{40}$/.test(head||'')){
     event.reason='current_pr_head_not_verified';return next;
   }
   if(parsed.intent==='MERGE_IF_ELIGIBLE'&&task.github_state==='merged'){
     event.status='REQUESTED';event.reason='already_merged_in_ledger';return next;
   }
 }
 const input={repo:settings.repo,actor,intent:parsed.intent,task_id:taskId,
   pr_number:prNumber,expected_head_sha:head,requested_at:now};
 const request_id=recoveryIdentity(input);
 const accepted=recordRecoveryEvent(next,{
   action:'dispatcher_recovery',sender:{login:actor},
   client_payload:{version:1,intent:parsed.intent,task_id:taskId,
     pr_number:prNumber,expected_head_sha:head,requested_at:now,request_id}
 },{repo:settings.repo,actors:{[actor]:'muse'},owner:settings.owner.login,
   now});
 const request=accepted.recovery_requests?.[request_id];
 if(!request){
   event.reason=accepted.recovery_rejections?.[request_id]?.reason||
     'recovery_request_not_accepted';
   return accepted;
 }
 const saved=accepted.owner_instruction_events[receipt.event_id];
 saved.status='REQUESTED';saved.reason='recovery_queued_for_github_gates';
 saved.recovery_request_id=request_id;saved.recovery_intent=parsed.intent;
 return accepted;
}
