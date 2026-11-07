// Map PRs only through explicit task marker or known branch; never guess ownership.
export function linkPullRequests(state, prs) {
  const next=structuredClone(state);
  const used=new Set();
  for(const [id,rec] of Object.entries(next.tasks)) {
    const matching=prs.filter(pr=>pr.pr_number===rec.pr_number ||
      (!rec.pr_number && ((rec.branch && pr.branch===rec.branch) ||
        (pr.task_marker===id && (!rec.branch || rec.branch===pr.branch)))));
    if(matching.length!==1) continue;
    const pr=matching[0];
    if(used.has(pr.pr_number)) throw new Error('Ambiguous PR mapping');
    used.add(pr.pr_number);
    if(rec.pr_number && rec.pr_number!==pr.pr_number) throw new Error('PR changed');
    rec.pr_number=pr.pr_number;
    rec.branch=pr.branch;
    rec.base_branch=pr.base_branch;
    rec.status=pr.draft?'draft_open':'review_fixing';
  }
  return {state:next,unmapped:prs.filter(pr=>!used.has(pr.pr_number)).map(pr=>pr.pr_number)};
}

export function dependencyBase(task, records) {
  const pending=(task.depends_on||[]).map(id=>records[id]).filter(rec=>rec?.status!=='integrated_proven'&&rec?.status!=='released_proven');
  if(pending.length===0)return {base:'main'};
  if(pending.length===1 && pending[0]?.branch && pending[0]?.github_state==='open')
    return {base:pending[0].branch};
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
