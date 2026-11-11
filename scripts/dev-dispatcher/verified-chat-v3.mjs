// Single, read-only proof of the current ChatGPT destination for a signed
// development task. This does not deliver a prompt or confer scope approval.
// A new URL is reachable ONLY through an accepted Muse receipt that names the
// exact previously authorized chat as continuation_of.
import {validTarget} from './bridge/bridge.mjs';

const CODING_START_TYPES=new Set(['assign','begin_scoped_coding']);
export function verifiedCodingConversation(state,taskId,approvalHash,currentUrl){
  if(typeof taskId!=='string'||!taskId||
    typeof approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(approvalHash)||
    !validTarget('chatgpt',currentUrl))return false;
  const actions=Object.values(state?.actions||{}).filter(a=>{
    const d=a?.delivery,receipt=a?.receipt;
    return a?.task_id===taskId&&a.status==='submitted'&&
      a.delivery_owner==='muse'&&receipt?.courier==='muse'&&
      d?.provider==='chatgpt'&&d.approval_hash===approvalHash&&
      typeof d.prompt_hash==='string'&&d.prompt_hash===receipt.prompt_hash&&
      validTarget('chatgpt',receipt.conversation_url);
  });
  const reached=new Set(actions.filter(a=>CODING_START_TYPES.has(a.type)&&
    (a.delivery.intent==='start_new_chat'&&a.delivery.conversation_url==null||
     a.delivery.intent==='continue_existing_chat'&&
      (a.delivery.conversation_url===a.receipt.conversation_url||
       a.receipt.continuation_of===a.delivery.conversation_url)))
    .map(a=>a.receipt.conversation_url));
  if(!reached.size)return false;
  let changed=true;
  while(changed){
    changed=false;
    for(const a of actions){
      const from=a.delivery.conversation_url,to=a.receipt.conversation_url;
      if(!reached.has(from)||!validTarget('chatgpt',from)||reached.has(to))continue;
      if(a.delivery.intent!=='continue_existing_chat'||
        a.receipt.continuation_of!==from)continue;
      reached.add(to);changed=true;
    }
  }
  return reached.has(currentUrl);
}
