import {settings} from './settings.mjs';
import { createHash } from 'node:crypto';
// Adopt only open, same-repo, human-authored PRs with a validated chat marker.
// Queue tasks retain exclusive ownership of their signed delivery flow.
export function adoptAdhocPullRequests(state, prs, _queueIds = []) {
  const next = structuredClone(state);
  // PR-body task markers are optional hints, never authority.
  const used = new Set(Object.values(next.tasks).map(r => r.pr_number).filter(Number.isInteger));
  const skipped = [];
  for (const pr of prs) {
    if (used.has(pr.pr_number) ||
        (pr.branch || '').startsWith(settings.naming.branch_prefix)) continue;
    if (!pr.same_repo || pr.bot_author) continue;
    const chat=next.branch_chat_links?.[pr.branch]?.conversation_url||pr.chat_marker;
    if (!chat) { skipped.push(pr.pr_number); continue; }
    const id = 'ADHOC-' + pr.pr_number;
    const prev = next.tasks[id];
    if (prev && prev.pr_number !== pr.pr_number) continue;
    next.tasks[id] = {
      ...prev, task_id:id, pr_number:pr.pr_number, branch:pr.branch,
      base_branch:pr.base_branch, agent:'chatgpt', approved:true,
      adhoc:true, conversation_ref:chat,
      approval_hash:createHash('sha256').update(settings.naming.task_prefix+':adhoc:' + pr.pr_number + ':' + chat).digest('hex'),
      prompt_version:'v2', prerequisite_pr:null,
      status:pr.draft ? 'draft_open':'review_fixing'
    };
    used.add(pr.pr_number);
  }
  return {state:next,skipped};
}

// Link existing PR numbers first; for unlinked tasks, trust verified PR task markers
// before a uniquely matching unmarked branch. Never guess ambiguous ownership.
export function linkPullRequests(state, prs) {
  const next=structuredClone(state);
  const entries=Object.entries(next.tasks);
  const recorded=new Set(entries.map(([,rec])=>rec.pr_number).filter(n=>n!=null));
  const candidates=new Map(entries.map(([id,rec])=>{
    if(rec.pr_number!=null)
      return [id,prs.filter(pr=>pr.pr_number===rec.pr_number)];
    const available=prs.filter(pr=>!recorded.has(pr.pr_number));
    const marked=available.filter(pr=>pr.task_marker===id);
    return [id,marked.length ? marked : available.filter(pr=>
      !pr.task_marker && rec.branch &&
      (pr.branch===rec.branch || pr.branch?.startsWith(rec.branch+'-')))];
  }));
  // Two tasks claiming the same unmarked PR are ambiguous even if each has
  // only one candidate; reject both before mutating the copied state.
  const claims=new Map();
  for(const matching of candidates.values()) {
    if(matching.length!==1) continue;
    const number=matching[0].pr_number;
    claims.set(number,(claims.get(number)||0)+1);
  }
  const used=new Set();
  for(const [id,rec] of entries) {
    const matching=candidates.get(id);
    if(matching.length!==1) continue;
    const pr=matching[0];
    if(claims.get(pr.pr_number)!==1) continue;
    used.add(pr.pr_number);
    if(rec.pr_number!=null && rec.pr_number!==pr.pr_number) throw new Error('PR changed');
    rec.pr_number=pr.pr_number;
    rec.branch=pr.branch;
    const linked=next.branch_chat_links?.[pr.branch];
    if(linked?.conversation_url && (!rec.conversation_ref||rec.conversation_ref!==linked.conversation_url))
      rec.conversation_ref=rec.conversation_url=linked.conversation_url;
    if(rec.conversation_ref){
      next.pr_chat_links||={};
      next.pr_chat_links[String(pr.pr_number)]={task_id:id,branch:pr.branch,
        conversation_url:rec.conversation_ref,head_sha:pr.head_sha,updated_at:linked?.updated_at||new Date().toISOString()};
    }
    rec.base_branch=pr.base_branch;
    rec.status=pr.draft?'draft_open':'review_fixing';
  }
  return {state:next,unmapped:prs.filter(pr=>!used.has(pr.pr_number) && !pr.infrastructure_pr).map(pr=>pr.pr_number)};
}

export function dependencyBase(task, records) {
  const pending=(task.depends_on||[])
    .filter(id=>!['integrated_proven','released_proven'].includes(records[id]?.status))
    .map(id=>({id,...records[id]}));
  if(pending.length===0)return {base:'main'};
  const selected=pending.length===1 ? pending[0] :
    pending.find(rec=>rec.id===task.stack_base_task);
  if(selected?.branch && selected.github_state==='open')
    return {base:selected.branch};
  return {blocked:true,reason:'unproven_or_ambiguous_dependencies'};
}

// A retarget is allowed only when the upstream branch has actually merged.
// The dependent PR must be rechecked on the new base; never silently force push/rebase.
export function retargetDecision({dependent, predecessor, predecessorMerged, currentBase}) {
  if(!dependent?.pr_number||!predecessor?.branch||!predecessorMerged)
    return {allowed:false,reason:'predecessor_not_verified_merged'};
  if(currentBase!==predecessor.branch)
    return {allowed:false,reason:'unexpected_current_base'};
  return {allowed:true,new_base:'main'};
}
