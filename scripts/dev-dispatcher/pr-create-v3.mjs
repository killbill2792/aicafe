// Trusted-main early draft PR creation after authenticated Muse delivery.
// Never infer coding completion, invent a branch, or create a PR from unsigned
// scope. Uses a separate installation token so new PR CI events are triggered.
import {settings} from './settings.mjs';
import {approvalMatches,validConversationUrl} from './delivery.mjs';
import {editableFiles,resolveTaskBase,approved} from './core.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function ensureApprovedDraftPr({github,writer,task,record,records={},
  queueRepo=settings.repo,branchPrefix=settings.naming.branch_prefix}={}){
 if(!github||!writer||!task||!record)return {status:'blocked',reason:'missing_evidence'};
 const id=task.id,branch=branchPrefix+id;
 if(!approved(task)||record.approved!==true||record.task_id!==id||
   !approvalMatches(task,record.approval_hash)||
   !record.conversation_ref||!validConversationUrl('chatgpt',record.conversation_ref)||
   record.branch!==branch||record.repo_mismatch||record.sensitive_owner_block||
   record.protected_file_violation?.length)
   return {status:'blocked',reason:'signed_scope_or_chat_unverified'};
 if(Number.isInteger(record.pr_number)||record.github_state==='merged')
   return {status:'already_linked'};
 const base=resolveTaskBase(task,records);
 if(base.blocked||record.base_branch!==base.base_branch||
   (base.prerequisite_pr||null)!==(record.prerequisite_pr||null))
   return {status:'blocked',reason:'wrong_or_unverified_parent_base'};
 const changed=editableFiles(task);
 if(!changed.length)return {status:'blocked',reason:'no_signed_edit_paths'};
 let ref;
 try{ref=await github.request('/git/ref/heads/'+encodeURIComponent(branch));}
 catch(error){
  if(error.status===404)return {status:'blocked',reason:'branch_missing'};
  throw error;
 }
 const head=ref?.object?.sha;
 if(!SHA.test(head||''))return {status:'blocked',reason:'head_not_verified'};
 if(record.head_sha&&record.head_sha!==head)
   return {status:'blocked',reason:'new_head_not_reconciled'};
 const existing=await github.request('/pulls?state=all&head='+
   encodeURIComponent(queueRepo.split('/')[0]+':'+branch)+'&per_page=100');
 const match=Array.isArray(existing)?existing.find(p=>p.head?.ref===branch):null;
 if(match)return {status:'existing_pr_needs_link',pr_number:match.number,
   github_state:match.merged_at?'merged':match.state,draft:match.draft,head_sha:match.head?.sha};
 const comparison=await github.request('/compare/'+encodeURIComponent(base.base_branch)+'...'+head);
 if(!(comparison?.ahead_by>0)||!Array.isArray(comparison.files)||
   comparison.files.length===0||comparison.files.length>=300)
   return {status:'blocked',reason:'no_verified_complete_changed_file_list'};
 const allowed=new Set(changed);
 const unauthorized=comparison.files.map(f=>f.filename).filter(path=>!allowed.has(path));
 if(unauthorized.length)return {status:'blocked',reason:'branch_contains_unsigned_edits',
   files:unauthorized.slice(0,10)};
 // A branch may change during the read. Never open against an unverified head.
 const latest=await github.request('/git/ref/heads/'+encodeURIComponent(branch));
 if(latest?.object?.sha!==head)return {status:'blocked',reason:'head_changed_during_preflight'};
 try{
  const created=await writer.request('/pulls',{method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({
    title:task.title||'Approved task '+id,
    head:branch,base:base.base_branch,draft:true,
    body:'<!-- '+settings.naming.marker_prefix+'-task-id '+id+' -->\n'+
      'Approved signed development task '+id+'. Draft opened automatically after authenticated Muse chat delivery. '+
      'No coding completion is claimed. See the approved task queue and current-head checks.'
   })
  });
  if(created?.state!=='open'||created?.draft!==true||!Number.isInteger(created.number)||
    created.head?.sha!==head)
    return {status:'uncertain',reason:'PR_write_not_fully_verified'};
  return {status:'created',pr_number:created.number,head_sha:head,
    base_branch:base.base_branch};
 }catch(error){
  // A timed-out POST could have succeeded. Never blindly replay it.
  return {status:'uncertain',reason:'PR_create_effect_unverified'};
 }
}
