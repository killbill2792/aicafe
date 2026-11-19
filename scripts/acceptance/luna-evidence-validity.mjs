// No-provider-cost first stage of Luna evidence reuse.
// Run from trusted main; input trees must be fetched by the trusted caller
// from GitHub's exact commits, never from candidate-supplied JSON.
// This comparison is NOT authentication of a Luna receipt or merge clearance.
const SHA=/^[a-f0-9]{40}$/;
// Narrow, reviewer-owned list. Never exempt a directory, glob, runtime
// configuration, generated source, test fixture or candidate-provided list.
const DOCUMENTS=new Set([
 'AGENTS.md',
 'docs/rules/acceptance-quality.md',
 'docs/rules/shared-luna-acceptance.md',
 'docs/rules/workflow-and-review.md',
 'docs/plans/muse-lightweight-coordination.md',
 '.github/pull_request_template.md',
 '.claude/skills/aicafe-pr-lifecycle/SKILL.md'
]);
function indexTree(tree){
 if(tree?.truncated!==false||!SHA.test(tree.sha||'')||!Array.isArray(tree.tree))
  throw Error('Complete Git tree required');
 const entries=new Map(),seen=new Set();
 for(const e of tree.tree){
  if(typeof e.path!=='string'||!e.path||e.path.split('/').some(p=>!p||p==='.'||p==='..')||
     /[\x00-\x1f\x7f]/.test(e.path)||seen.has(e.path)||!SHA.test(e.sha||''))
   throw Error('Invalid or duplicate Git tree entry');
  seen.add(e.path);
  if(e.type==='tree'&&e.mode==='040000')continue;
  if(!((e.type==='blob'&&['100644','100755','120000'].includes(e.mode))||
       (e.type==='commit'&&e.mode==='160000')))
   throw Error('Unknown Git tree entry type or mode');
  entries.set(e.path,{mode:e.mode,type:e.type,sha:e.sha});
 }
 return entries;
}
export function compareLunaTrees(tested,candidate){
 let before,after;
 try{before=indexTree(tested);after=indexTree(candidate);}
 catch(e){return {status:'UNKNOWN',reason:String(e.message),changed:[],impact:[]};}
 const paths=[...new Set([...before.keys(),...after.keys()])].sort();
 const changed=[],impact=[];
 for(const path of paths){
  const a=before.get(path),b=after.get(path);
  if(a&&b&&a.sha===b.sha&&a.mode===b.mode&&a.type===b.type)continue;
  changed.push(path);
  // Only content edits to an existing ordinary, explicitly reviewed document.
  // Deletions/additions, symlinks, executable-bit changes and renames are unsafe.
  if(!(DOCUMENTS.has(path)&&a?.mode==='100644'&&b?.mode==='100644'&&
       a.type==='blob'&&b.type==='blob'))impact.push(path);
 }
 return {status:impact.length?'IMPACT_CHANGED':'COMPARISON_ELIGIBLE',
  tested_tree:tested.sha,candidate_tree:candidate.sha,changed,impact,
  reason:impact.length?'Non-exempt code, resource or mode changed; independence not established':
   'No changes outside the narrow reviewed document allowlist'};
}
