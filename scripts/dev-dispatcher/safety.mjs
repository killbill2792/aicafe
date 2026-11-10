import {settings} from './settings.mjs';
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sha=/^[a-f0-9]{40}$/;
// PR markers diagnose; signed task facts own repository identity.
const REPO_MARKER=/^\s*<!--\s*repo:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+task:\s*([^\s>]+)\s*-->\s*$/gm;
export function validateRepo(body='',actualRepo='') {
  const matches=[...body.matchAll(REPO_MARKER)];
  if(!matches.length)return {status:'warning',message:'No <!-- repo: owner/name task: id --> marker; warning only.'};
  if(matches.some(m=>m[1]!==matches[0][1]))
    return {status:'failure',message:'Conflicting repository markers in PR body.'};
  if(matches[0][1].toLowerCase()!==actualRepo.toLowerCase())
    return {status:'failure',message:'This PR says it belongs to '+matches[0][1]+' but is in '+actualRepo};
  return {status:'success',message:'PR repository matches '+actualRepo+' (task '+matches[0][2]+').'};
}
export function parseChatUrl(body='') {
  return body.match(/<!--\s*aicafe-chat-url\s+(https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9_-]+|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+))\s*-->/)?.[1]||null;
}
export const STALL_PROMPT = "No new commit arrived. If GitHub returned 403 'Resource not accessible by integration', report it in one line.";
export const stallMinutes = value => {
  if (value == null || value === '') return 20;
  const n=Number(value);
  return Number.isInteger(n) && n>=1 && n<=1440 ? n : 20;
};
export function expectedTaskRepo(task,record,dispatcherRepo) {
  const declared=task?.repository || task?.repo || record?.repository || record?.repo;
  return REPO.test(declared || '') ? declared : dispatcherRepo;
}
export function applySafetySignals(state,{queue=[],repo,now=new Date().toISOString(),minutes=20}={}) {
  const next=structuredClone(state);
  const tasks=new Map(queue.map(t=>[t.id,t]));
  const clock=Date.parse(now);
  for(const [id,rec] of Object.entries(next.tasks || {})) {
    const expected=expectedTaskRepo(tasks.get(id),rec,repo);
    rec.repo_mismatch=rec.github_state==='open' && expected.toLowerCase()!==repo.toLowerCase()
      ? {expected,actual:repo,pr_number:rec.pr_number} : null;
    const head=rec.head_sha;
    const headMoved=Boolean(rec.stall_head && rec.stall_head!==head);
    if(rec.stall_head!==head) {
      rec.stall_head=head;
      rec.stall_count=0;
      rec.stall_seen=null;
      rec.stall_pending=null;
      rec.stall_escalate=false;
      rec.stall_nudged_at=null;
    }
    const needsFix=rec.ci_state==='failure'||rec.codex_state==='findings'||rec.mergeable===false;
    if(headMoved || rec.github_state!=='open'||!sha.test(head||'')||
        !needsFix||!rec.approved||!rec.conversation_ref||rec.repo_mismatch) {
      rec.stall_pending=null;
      continue;
    }
    const delivered=Date.parse(rec.last_submission_at||'');
    const committed=Date.parse(rec.last_commit_at||'');
    const advanced=sha.test(rec.last_prompt_head_sha||'')
      ? rec.last_prompt_head_sha!==head
      : Number.isFinite(committed)&&committed>delivered;
    if(!Number.isFinite(delivered)||!Number.isFinite(clock) ||
       clock-delivered < minutes*60000 || advanced) {
      rec.stall_pending=null;
      continue;
    }
    const identity=head+':'+rec.last_submission_at;
    if(rec.stall_count>=1) {
      if(clock-Date.parse(rec.stall_nudged_at||rec.last_submission_at||'')>=minutes*60000){
        rec.stall_pending=null;rec.stall_escalate=true;
      }
      continue;
    }
    rec.stall_seen=identity;rec.stall_count=1;rec.stall_nudged_at=now;
    rec.safety_event={kind:'no_push_after_prompt',head_sha:head,pr_number:rec.pr_number,count:1,at:now};
    rec.stall_pending='stall:'+encodeURIComponent(id)+':'+head+':1';
  }
  return next;
}

export function landingFailureForMerge(comments, mergeSha) {
  if (!sha.test(mergeSha||'') || !Array.isArray(comments)) return null;
  const prefix='<!-- landing-check-failure sha:'+mergeSha+' -->';
  const match=comments.find(c=>c.user?.login==='github-actions[bot]' &&
    typeof c.body==='string' && c.body.startsWith(prefix));
  return match ? match.body.slice(0,4500) : null;
}
export function reportedConnector403(comments, prAuthor) {
  return Array.isArray(comments) && comments.some(c=>
    (c.user?.login===prAuthor || c.author_association==='OWNER' ||
     c.user?.login==='chatgpt-codex-connector[bot]') &&
    /403.{0,80}Resource not accessible by integration|Resource not accessible by integration.{0,80}403/i.test(c.body||''));
}
export function failureInstruction(annotations=[]) {
  const line=annotations.map(x=>String(x.message||'')).find(x=>
    /aicafe-chat-url|vision.{0,30}version/i.test(x));
  if(!line)return null;
  const exact=line.replace(/[\r\n]+/g,' ').slice(0,800);
  const fix=/aicafe-chat-url/i.test(exact)
    ? 'Fix: use <!-- aicafe-chat-url https://chatgpt.com/c/<real-chat-id> --> with your actual chat URL, or the real /g/<project>/c/<id> path.'
    : 'Fix: update the vision version to the exact value the failing check expects, then rerun the check.';
  return exact+'\n'+fix;
}

export function protectedChanges(files,guards=settings.protected_files){
 const matches=[];
 for(const guard of guards||[])for(const path of guard.paths||[]){
  const prefix=path.endsWith('/**')?path.slice(0,-2):path;
  for(const f of files||[])if(typeof f.filename==='string'&&
   (path.endsWith('/**')?f.filename.startsWith(prefix):f.filename===prefix))
   matches.push({file:f.filename,owner:guard.owner,source_pr:guard.source_pr});
 }
 return matches;
}
