import {spawnSync} from 'node:child_process';
const isSha = s => /^[a-f0-9]{40}$/.test(s || '');
export function stablePatchId(files) {
  if(!Array.isArray(files)||!files.length||files.length>=300||
     files.some(f=>!f.filename||typeof f.patch!=='string'||!f.patch.startsWith('@@')))
    return null; // Missing/binary/truncated content cannot prove equality.
  const diff=files.map(f=>{
    const old=f.previous_filename||f.filename;
    return 'diff --git a/'+old+' b/'+f.filename+'\n--- '+
      (f.status==='added'?'/dev/null':'a/'+old)+'\n+++ '+
      (f.status==='removed'?'/dev/null':'b/'+f.filename)+'\n'+f.patch+'\n'; }).join(''); const result=spawnSync('git',['patch-id','--stable'],{
    input:diff,encoding:'utf8',timeout:3000,maxBuffer:1024*1024
  });
  if(result.status!==0||result.error)return null;
  return /^([a-f0-9]{40})\s/.exec(result.stdout||'')?.[1]||null; }
export async function classifyCodexChange({github,previous,current}) {
  const anchor=previous?.codex_clean_head_sha ||
    (previous?.codex_state==='clean' && previous?.codex_reviewed_sha===previous?.head_sha
      ?previous.head_sha:null); const oldBase=previous?.codex_clean_base_sha ||
    (anchor===previous?.head_sha?previous?.base_merge_sha:null); const evidence={case:'A',reason:'PR_commits_or_update_unverified',
    old_patch_id:null,new_patch_id:null,overlapping_files:[],
    prior_clean_head_sha:anchor||null,base_before_sha:oldBase||null,
    base_after_sha:current?.base_sha||null,new_head_sha:current?.head_sha||null,
    verified_gh_update_branch:false,hand_resolved_conflicts:false};
  if(!isSha(anchor)||!isSha(oldBase)||!isSha(current?.head_sha)||
     !isSha(current?.base_sha)||anchor===current.head_sha)return evidence; const update=previous?.codex_branch_update; const verified=update?.old_head_sha===previous?.head_sha &&
    update?.new_base_sha===current.base_sha &&
    update?.status==='accepted_no_conflicts'; const conflict=previous?.codex_branch_conflict?.old_head_sha===previous?.head_sha; evidence.verified_gh_update_branch=Boolean(verified); evidence.hand_resolved_conflicts=Boolean(conflict); try {
    const [before,after,baseDelta]=await Promise.all([
      github.request('/compare/'+oldBase+'...'+anchor),
      github.request('/compare/'+current.base_sha+'...'+current.head_sha),
      github.request('/compare/'+oldBase+'...'+current.base_sha)
    ]); evidence.old_patch_id=stablePatchId(before.files); evidence.new_patch_id=stablePatchId(after.files);
    const owned=new Set((before.files||[]).flatMap(f=>
      [f.filename,f.previous_filename].filter(Boolean))); evidence.overlapping_files=[...new Set((baseDelta.files||[]).flatMap(f=>
      [f.filename,f.previous_filename].filter(x=>x&&owned.has(x))))].sort();
    if(!['ahead','identical'].includes(baseDelta.status) ||
      baseDelta.behind_by!==0 || !Array.isArray(baseDelta.files) ||
      baseDelta.files.length>=300 || !evidence.old_patch_id ||
      !evidence.new_patch_id) {
      evidence.reason='insufficient_patch_or_ancestry_evidence';return evidence; }
    if(conflict){evidence.case='D';evidence.reason='hand_resolved_conflicts';return evidence;}
    if(!verified){evidence.reason='no_verified_no_conflict_update';return evidence;}
    if(evidence.old_patch_id!==evidence.new_patch_id){
      evidence.reason='PR_patch_modified';return evidence; }
    if(evidence.overlapping_files.length){
      evidence.case='C';evidence.reason='main_touches_PR_file';return evidence; } evidence.case='B';evidence.reason='unchanged_patch_no_overlap'; } catch {evidence.reason='compare_unavailable';}
  return evidence; }
export async function verifyLiveCarryOver({github,record,live}) {
  const saved=record?.codex_carried_over;
  if(saved?.case!=='B'||saved.new_head_sha!==live?.head_sha ||
    saved.base_after_sha!==live?.base_sha ||
    !record.codex_branch_update || !record.codex_clean_head_sha ||
    !record.codex_clean_base_sha)return false; const checked=await classifyCodexChange({github,previous:{
    ...record,head_sha:record.codex_branch_update.old_head_sha
  },current:live});
  return checked.case==='B' &&
    checked.old_patch_id===saved.old_patch_id &&
    checked.new_patch_id===saved.new_patch_id &&
    checked.overlapping_files.length===0; }
