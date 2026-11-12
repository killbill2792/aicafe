// Read-only browser view of the existing GitHub Actions owner-status comment.
import { renderPublicExtras, loadVerifiedMerges, MERGE_REFRESH_INTERVAL_MS } from "./owner-dashboard-extras.mjs";
// Never request private GitHub data or accept a browser token on this public site.
export const PUBLIC_COMMENT_URL =
  'https://api.github.com/repos/killbill2792/aicafe/issues/comments/6752417190';
export const REFRESH_INTERVAL_MS = 120000;
export const PUBLIC_SNAPSHOT_URL = './owner-operations-snapshot.json';

const onlyGithubUrl = value => {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'github.com' &&
      !u.username && !u.password && !u.search &&
      (!u.hash || (/^\/killbill2792\/aicafe\/pull\/\d+\/?$/.test(u.pathname) &&
        /^#issuecomment-\d+$/.test(u.hash))) &&
      /^\/(?:killbill2792\/aicafe\/(?:pull|actions\/runs)\/\d+|killbill2792\/dave-task-queue\/blob\/main\/dispatcher\/owner-queue\.md)\/?$/.test(u.pathname)
      ? u.href : null;
  } catch { return null; }
};
const clean = input => String(input || '').replace(/\s+/g,' ').trim();
const getDate = (raw, expression) => {
  const match = raw.match(expression);
  return match && !Number.isNaN(Date.parse(match[1])) ? new Date(match[1]).toISOString() : null;
};
const firstNumber = value => {
  const m = String(value).match(/\[#(\d+)\]\((https:\/\/github\.com\/killbill2792\/aicafe\/pull\/\d+)\)/);
  return m && onlyGithubUrl(m[2]) ? {number:Number(m[1]),url:m[2]} : null;
};
export function parseOwnerSnapshot(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('<!-- aicafe-dispatcher-owner-view:v1 -->'))
    throw new Error('Source is not the trusted public status projection');
  const lines=markdown.split('\n');
  const tasks=[];
  const decisions=[];
  let section='';
  for (const line of lines) {
    if(line.startsWith('### ')){section=line.slice(4);continue;}
    if(section==='What is happening' && line.startsWith('| ')) {
      const cells=line.split('|').slice(1,-1).map(clean);
      if(cells.length!==7 || cells[0]==='Task' || cells[0]==='---')continue;
      const pr=firstNumber(cells[1]);
      if(!pr)continue;
      tasks.push({id:cells[0],pr:pr.number,url:pr.url,stage:cells[2],
        ci:cells[3],codex:cells[4],muse:cells[5],next:cells[6]});
    }
    if(section.startsWith('Needs owner approval') && line.startsWith('- **')) {
      const m=line.match(/^- \*\*(.*?) \[(#\d+)\]\(https:\/\/github\.com\/killbill2792\/aicafe\/pull\/(\d+)\):\*\* (.+)/);
      if(!m)continue;
      const source=m[4].match(/\[Open original GitHub question\]\((https:\/\/github\.com\/[^)]+)\)/);
      const target=source && onlyGithubUrl(source[1]);
      const summary=clean(m[4].replace(/\[Open original GitHub question\]\([^)]+\)/g,'')
        .replace(/\*\*[^*]+\*\*/g,'').replace(/\[[^\]]+\]\([^)]+\)/g,''));
      decisions.push({task:m[1],pr:Number(m[3]),text:summary,url:target||`https://github.com/killbill2792/aicafe/pull/${m[3]}`});
    }
  }
  return {checkedAt:getDate(markdown,/\*\*Last successful GitHub reconciliation shown:\*\*\s*([^\s]+)/),
    ledgerAt:getDate(markdown,/\*\*Private ledger as-of:\*\*\s*([^\s]+)/),
    tasks,decisions};
}
export function statusLevel(value) {
  const s=clean(value).toLowerCase();
  if (/failed|failure|findings|blocked|pending|queued|owner decision|not sent|not yet|missing|unknown|unverified|stale|not_run|not_received|not_confirmed/.test(s)) return 'warn';
  if (/success|clean|merged|integrated|submitted/.test(s)) return 'good';
  return 'neutral';
}
export function freshness(checkedAt, now=Date.now()) {
  const age=Date.parse(checkedAt||'');
  return Number.isFinite(age) && now-age < 900000 ? 'current' : 'stale';
}

const element=(type,cls,text)=>{
  const e=document.createElement(type);
  if(cls)e.className=cls;
  if(text!==undefined)e.textContent=text;
  return e;
};
const addLink=(parent,label,url)=>{
  const link=element('a','inline-link',label);
  if(onlyGithubUrl(url)){link.href=url;link.target='_blank';link.rel='noopener noreferrer';}
  parent.append(link);
};
function badge(value) {
  const e=element('span',`state ${statusLevel(value)}`,value);
  return e;
}
// Same Tasks and handoffs table renders the public fallback and the
// trusted-main published lifecycle snapshot. No second table or decryption.
const MILLIS_MINUTE=60_000;
export function ageLabel(value,now=Date.now()){
 const time=Date.parse(value||'');
 if(!Number.isFinite(time))return 'age unknown';
 const minutes=Math.max(0,Math.floor((now-time)/MILLIS_MINUTE));
 if(minutes<1)return 'just now';
 if(minutes<60)return minutes+'m ago';
 if(minutes<1440)return Math.floor(minutes/60)+'h '+minutes%60+'m ago';
 return Math.floor(minutes/1440)+'d '+Math.floor(minutes%1440/60)+'h ago';
}
export function sortOperations(rows,{by='task',order='desc'}={}){
 const get=(r)=>{
  switch(by){
   case 'commit':return r.coding?.last_commit_at||'';
   case 'codex':return r.codex?.reviewed_at||'';
   case 'codex_requested':return r.codex?.requested_at||'';
   case 'ci_at':return r.ci?.last_checked_at||r.ci?.finished_at||'';
   case 'ci':return r.ci?.status||'';
   case 'pr':return r.pr?.number||0;
   case 'stage':return r.stage||'';
   case 'next':return r.next?.action||'';
   case 'muse':return r.muse?.pending_actions||0;
   default:return r.id||'';
  }
 };
 const dir=order==='asc'?1:-1;
 return [...rows].sort((a,b)=>{const av=get(a),bv=get(b);
  const compare=typeof av==='number'&&typeof bv==='number'?av-bv:
   String(av).localeCompare(String(bv),undefined,{numeric:true});
  return dir*compare||String(a.id).localeCompare(String(b.id),undefined,{numeric:true});
 });
}
const cleanFallback=item=>({id:item.id,stage:item.stage||'UNKNOWN',
 pr:{number:item.pr,url:item.url,state:'PUBLIC'},coding:{last_commit_at:null},
 ci:{status:item.ci||'UNKNOWN'},codex:{status:item.codex||'UNKNOWN'},
 muse:{delivered:item.muse||'UNKNOWN',pending_actions:0,pending_owner_notices:0},
 merge:{eligible:false,blockers:[]},integration:{status:'UNKNOWN'},
 next:{actor:'UNKNOWN',action:item.next||'UNKNOWN'},dependencies:[]});
const view={rows:[],mode:'public-fallback',publishedAt:null};
const dateText=timestamp=>timestamp
 ?new Date(timestamp).toLocaleString():'Not recorded';
const addSmall=(node,text)=>node.append(element('div','small',text));
function renderOperations(){
 const root=document.querySelector('#task-rows');
 if(!root)return;
 const by=document.querySelector('#task-sort')?.value||'task';
 const order=document.querySelector('#task-order')?.value||'desc';
 const filter=(document.querySelector('#task-filter')?.value||'').toLowerCase().trim();
 const items=sortOperations(view.rows,{by,order}).filter(r=>{
  if(!filter)return true;
  return [r.id,r.title,r.stage,r.outcome,r.pr?.number,r.next?.action,
   ...(r.merge?.blockers||[]),...(r.dependencies||[])]
   .some(v=>String(v||'').toLowerCase().includes(filter));
 });
 root.replaceChildren();
 for(const r of items){
  const tr=element('tr');
  const task=element('td');
  task.append(element('strong','',r.id||'Unknown task'));
  addSmall(task,r.title||r.outcome||r.stage||'');
  task.append(badge(r.outcome||r.stage||'UNKNOWN'));
  if(r.plan_state)addSmall(task,'Plan: '+r.plan_state);
  const pr=element('td');
  if(Number.isSafeInteger(r.pr?.number)&&r.pr.number>0){
   addLink(pr,'#'+r.pr.number,r.pr.url);
   addSmall(pr,(r.pr.state||'')+' · '+(r.pr.head_sha||'').slice(0,9));
   if(r.pr.branch)addSmall(pr,r.pr.branch);
  }else pr.append(badge('PR missing in ledger'));
  const commit=element('td');
  commit.append(element('div','',dateText(r.coding?.last_commit_at)));
  addSmall(commit,ageLabel(r.coding?.last_commit_at));
  const ci=element('td');
  ci.append(badge(r.ci?.status||'UNKNOWN'));
  addSmall(ci,'Last checked: '+dateText(r.ci?.last_checked_at||r.ci?.finished_at));
  addSmall(ci,ageLabel(r.ci?.last_checked_at||r.ci?.finished_at));
  if(r.ci?.failed_check)addSmall(ci,'Failed: '+r.ci.failed_check);
  const codex=element('td');
  codex.append(badge(r.codex?.status||'UNKNOWN'));
  addSmall(codex,'Request: '+(r.codex?.request_status||'UNKNOWN'));
  addSmall(codex,'Requested: '+dateText(r.codex?.requested_at));
  addSmall(codex,'Request age: '+ageLabel(r.codex?.requested_at));
  addSmall(codex,'Reviewed: '+dateText(r.codex?.reviewed_at));
  addSmall(codex,'Review age: '+ageLabel(r.codex?.reviewed_at));
  if(r.codex?.open_threads!=null)addSmall(codex,'Open threads: '+r.codex.open_threads);
  const acceptance=element('td');acceptance.append(badge(r.acceptance||'UNKNOWN'));
  const dependencies=element('td','small',(r.dependencies||[]).join(', ')||'None recorded');
  const muse=element('td');
  muse.append(badge(r.muse?.delivered||'UNKNOWN'));
  addSmall(muse,'Pending actions: '+(r.muse?.pending_actions??'?')+
    (r.muse?.action_types?.length?' ('+r.muse.action_types.join(', ')+')':''));
  addSmall(muse,'Owner notices: '+(r.muse?.pending_owner_notices??'?')+
    (r.muse?.notice_kinds?.length?' ('+r.muse.notice_kinds.join(', ')+')':''));
  addSmall(muse,'Receipt: '+dateText(r.muse?.last_receipt_at));
  const owner=r.owner_control;
  if(owner){
   addSmall(muse,'Owner priority: '+(owner.priority==null?'not set':owner.priority)+
     ' · '+(owner.paused?'dispatch paused':'dispatch active'));
   if(owner.note_present)addSmall(muse,'Owner note saved in private ledger');
   if(owner.last_command_status)
     addSmall(muse,'Owner command: '+owner.last_command_status+
       (owner.last_command_reason?' ('+owner.last_command_reason+')':'')+
       ' · '+dateText(owner.last_command_at));
  }
  const merge=element('td');
  merge.append(badge(r.merge?.eligible?'Eligible':'Blocked / not verified'));
  addSmall(merge,(r.merge?.blockers||[]).join(', ')||'No verified blocker detail');
  const integration=element('td');
  integration.append(badge(r.integration?.status||'UNKNOWN'));
  if(r.integration?.verified_at)addSmall(integration,'Proven: '+dateText(r.integration.verified_at));
  const next=element('td');
  next.append(element('strong','',(r.next?.actor||'UNKNOWN')+' · '+(r.next?.action||'UNKNOWN')));
  if(r.next?.reason)addSmall(next,r.next.reason);
  tr.append(task,pr,commit,ci,codex,acceptance,dependencies,muse,merge,integration,next);
  root.append(tr);
 }
 if(!items.length){
  const tr=element('tr'),td=element('td','empty','No matching tasks in the published snapshot');
  td.colSpan=11;tr.append(td);root.append(tr);
 }
 const counter=document.querySelector('#task-row-count');
 if(counter)counter.textContent=items.length+' of '+view.rows.length+' tasks';
 const tasks=document.querySelector('#count-tasks');
 if(tasks)tasks.textContent=String(view.rows.length);
 const queued=document.querySelector('#count-queued');
 if(queued)queued.textContent=String(view.rows.reduce((n,r)=>n+(r.muse?.pending_actions||0),0));
}
function renderPublic(data){
 document.querySelector('#heartbeat').textContent=data.checkedAt
   ?new Date(data.checkedAt).toLocaleString():'Unknown';
 document.querySelector('#ledger').textContent=data.ledgerAt
   ?new Date(data.ledgerAt).toLocaleString():'Unknown';
 view.rows=data.tasks.map(cleanFallback);view.mode='public-fallback';view.publishedAt=null;
 const pill=document.querySelector('#freshness');
 pill.className='health '+freshness(data.checkedAt);
 pill.textContent=freshness(data.checkedAt)==='current'
   ?'Public GitHub status checked recently':'Public GitHub status stale';
 const ask=document.querySelector('#decisions');ask.replaceChildren();
 for(const d of data.decisions){
  const card=element('article','decision');
  const h=element('h3','',d.task+' · PR #'+d.pr);
  const p=element('p','',d.text);
  const anchor=element('p');addLink(anchor,'Read and answer on GitHub',d.url);
  card.append(h,p,anchor);ask.append(card);
 }
 document.querySelector('#count-decisions').textContent=String(data.decisions.length);
 if(!data.decisions.length)ask.append(element('p','empty','No outstanding published owner questions.'));
 renderOperations();
}
export function acceptPublicOperationsSnapshot(data){
 if(data?.version!==2||!Array.isArray(data.tasks)||data.tasks.length>5000||
   !Number.isFinite(Date.parse(data.generated_at||''))||
   !data.tasks.every(r=>/^[A-Za-z0-9_-]{1,64}$/.test(r?.id||'')&&
     typeof r.stage==='string'&&r.pr&&r.ci&&r.codex&&r.muse&&r.next))
  throw Error('Invalid published owner operations projection');
 return data;
}
let loading=false;
export async function refresh(fetchFn=fetch) {
 if(loading)return;
 loading=true;
 const status=document.querySelector('#fetch-status');
 status.textContent='Checking GitHub and published task snapshot…';
 let publicData=null,sourceError=null;
 try{
  try{
   const r=await fetchFn(PUBLIC_COMMENT_URL,{headers:{Accept:'application/vnd.github+json'},cache:'no-store'});
   if(!r.ok)throw Error('GitHub HTTP '+r.status);
   const result=await r.json();
   publicData=parseOwnerSnapshot(result.body);
   renderPublic(publicData);renderPublicExtras(result.body);
  }catch(e){sourceError=String(e.message).slice(0,120);}
  try{
   const r=await fetchFn(PUBLIC_SNAPSHOT_URL,{cache:'no-store'});
   if(!r.ok)throw Error('Published snapshot HTTP '+r.status);
   const snap=acceptPublicOperationsSnapshot(await r.json());
   view.rows=snap.tasks;view.mode='published-ledger';view.publishedAt=snap.generated_at;
   const refreshed=Number.isFinite(Date.parse(snap.generated_at))&&
     Date.now()-Date.parse(snap.generated_at)<=15*60_000;
   const ledgerFresh=Number.isFinite(Date.parse(snap.ledger_updated_at||''))&&
     Date.now()-Date.parse(snap.ledger_updated_at)<=15*60_000;
   const pill=document.querySelector('#freshness');
   pill.className='health '+(refreshed&&ledgerFresh?'current':'stale');
   pill.textContent=refreshed&&ledgerFresh?'Published ledger recent':'Published ledger or projection stale';
   document.querySelector('#heartbeat').textContent=dateText(snap.last_schedule_at);
   document.querySelector('#ledger').textContent=dateText(snap.ledger_updated_at);
   const label=document.querySelector('#operations-source');
   if(label)label.textContent='Published '+dateText(snap.generated_at)+
     ' · Ledger '+dateText(snap.ledger_updated_at)+
     ' · Schedule '+dateText(snap.last_schedule_at)+
     ' · '+snap.owner_notices_pending+' pending owner notices';
   renderOperations();
   status.textContent='One table · '+view.rows.length+' tasks · refreshed '+new Date().toLocaleTimeString()+
     (refreshed&&ledgerFresh?'':' · source may be stale');
  }catch(e){
   if(publicData){
    const label=document.querySelector('#operations-source');
    if(label)label.textContent='Detailed task snapshot unavailable; showing public GitHub fallback';
    status.textContent='Detailed status unavailable: '+String(e.message).slice(0,150)+
     '. Public fallback has '+view.rows.length+' PR-linked rows.';
   }else throw Error(sourceError||e.message);
  }
 }catch(e){
  const pill=document.querySelector('#freshness');
  pill.className='health stale';
  pill.textContent='Cannot verify current GitHub status';
  status.textContent='Could not refresh: '+e.message+'. Showing previous snapshot, if any.';
 }finally{loading=false;}
}
if(typeof document!=='undefined'){
  document.addEventListener('DOMContentLoaded',()=>{
    for(const selector of ['#task-filter','#task-sort','#task-order']){
      const control=document.querySelector(selector);
      if(control)control.addEventListener(selector==='#task-filter'?'input':'change',renderOperations);
    }
    refresh();
    loadVerifiedMerges();
    setInterval(()=>{if(!document.hidden)refresh();},REFRESH_INTERVAL_MS);
    setInterval(()=>{if(!document.hidden)loadVerifiedMerges();},MERGE_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();loadVerifiedMerges();}});
  });
}
