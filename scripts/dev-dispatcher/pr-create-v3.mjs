// Trusted-main early draft PR creation after authenticated Muse delivery.
// Never infer coding completion, invent a branch, or create a PR from unsigned
// scope. Uses a separate installation token so new PR CI events are triggered.
import {settings} from './settings.mjs';
import {approvalMatches,validConversationUrl} from './delivery.mjs';
import {editableFiles,resolveTaskBase,approved} from './core.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function ensureApprovedDraftPr({github,writer,task,record,records={},
  verifiedDelivery=false,queueRepo=settings.repo,branchPrefix=settings.naming.branch_prefix}={}){
 if(!github||!writer||!task||!record)return {status:'blocked',reason:'missing_evidence'};
 const id=task.id,branch=branchPrefix+id;
 if(!verifiedDelivery||!approved(task)||record.approved!==true||record.task_id!==id||
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
 // A POST may have committed despite a transport timeout or GitHub HTTP 5xx.
 // Re-observe the branch/PR on every tick, but NEVER replay the POST merely
 // because discovery is empty. A sticky ledger hold survives later non-write
 // observations and stays in force until GitHub verifies a PR or an explicit
 // owner-authorized manual recovery creates one.
 if(record.pr_creation_uncertain_hold||
    record.github_effects?.CREATE_DRAFT_PR?.status==='uncertain')
   return {status:'uncertain',reason:'previous_pr_creation_write_unverified'};
 const comparison=await github.request('/compare/'+encodeURIComponent(base.base_branch)+'...'+head);
 if(!(comparison?.ahead_by>0)||!Array.isArray(comparison.files)||
   comparison.files.length===0||comparison.files.length>=300)
   return {status:'blocked',reason:'no_verified_complete_changed_file_list'};
 const allowed=new Set(changed);
 // GitHub rename records expose both the created destination and removed
 // source. An unsigned removal is not authorized by an approved destination.
 const touched=[];
 for(const file of comparison.files){
   if(typeof file?.filename!=='string'||!file.filename)
     return {status:'blocked',reason:'no_verified_complete_changed_file_list'};
   touched.push(file.filename);
   if(file.status==='renamed'&&
       (typeof file.previous_filename!=='string'||!file.previous_filename))
     return {status:'blocked',reason:'no_verified_complete_changed_file_list'};
   if(file.previous_filename)touched.push(file.previous_filename);
 }
 const unauthorized=[...new Set(touched.filter(path=>!allowed.has(path)))];
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
      '<!-- '+settings.naming.marker_prefix+'-chat-url '+record.conversation_ref+' -->\n'+
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
  // A confirmed credential rejection is a visible BLOCKER, not a timed-out
  // write. GitHub 429 is throttling, not an owner approval or review failure.
  if(error?.code==='RATE_LIMIT')
    return {status:'blocked',reason:'github_rate_limited'};
  if(/status=(?:401|403)\b/.test(String(error?.message||'')))
    return {status:'blocked',reason:'pr_creator_permission_denied'};
  // Transport, HTTP 5xx and ambiguous validation may have committed.
  // Never blindly replay an uncertain PR creation side effect.
  return {status:'uncertain',reason:'PR_create_effect_unverified'};
 }
}
