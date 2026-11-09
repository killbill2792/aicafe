// Read-only browser view of the existing GitHub Actions owner-status comment.
// Never request private GitHub data or accept a browser token on this public site.
export const PUBLIC_COMMENT_URL =
  'https://api.github.com/repos/killbill2792/aicafe/issues/comments/6752417190';
export const PRIVATE_QUEUE_URL =
  'https://github.com/killbill2792/dave-task-queue/blob/main/dispatcher/owner-queue.md';
export const REFRESH_INTERVAL_MS = 120000;

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
  if (/failed|failure|findings|blocked|pending|queued|owner decision|not sent|not yet/.test(s)) return 'warn';
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
function render(data) {
  document.querySelector('#heartbeat').textContent=data.checkedAt
    ? new Date(data.checkedAt).toLocaleString() : 'Unknown';
  document.querySelector('#ledger').textContent=data.ledgerAt
    ? new Date(data.ledgerAt).toLocaleString() : 'Unknown';
  const age=freshness(data.checkedAt);
  const pill=document.querySelector('#freshness');
  pill.className=`health ${age}`;
  pill.textContent=age==='current'?'Dispatcher checked recently':'No successful check in 15+ minutes';
  const tasks=document.querySelector('#task-rows');tasks.replaceChildren();
  for(const item of data.tasks) {
    const row=element('tr');
    const name=element('td');name.append(element('strong','',item.id));
    const pr=element('td');addLink(pr,`#${item.pr}`,item.url);
    const stage=element('td');stage.append(badge(item.stage));
    const ci=element('td');ci.append(badge(item.ci));
    const codex=element('td');codex.append(badge(item.codex));
    const muse=element('td','small',item.muse);
    const next=element('td','small',item.next);
    row.append(name,pr,stage,ci,codex,muse,next);tasks.append(row);
  }
  const ask=document.querySelector('#decisions');ask.replaceChildren();
  for(const d of data.decisions) {
    const card=element('article','decision');
    const h=element('h3','',d.task+` · PR #${d.pr}`);
    const p=element('p','',d.text);
    const link=element('p');addLink(link,'Read and answer on GitHub',d.url);
    card.append(h,p,link);ask.append(card);
  }
  document.querySelector('#count-tasks').textContent=String(data.tasks.length);
  document.querySelector('#count-decisions').textContent=String(data.decisions.length);
  document.querySelector('#count-queued').textContent=String(
    data.tasks.filter(t=>/queued|planned|not sent/i.test(t.muse)).length);
  if(!data.decisions.length)ask.append(element('p','empty','No outstanding published owner questions.'));
  const queue=document.querySelector('#private-queue');
  queue.href=PRIVATE_QUEUE_URL;
}
let loading=false;
export async function refresh(fetchFn=fetch) {
  if(loading)return;
  loading=true;
  const line=document.querySelector('#fetch-status');
  line.textContent='Checking GitHub…';
  try {
    const response=await fetchFn(PUBLIC_COMMENT_URL,{headers:{Accept:'application/vnd.github+json'},cache:'no-store'});
    if(!response.ok)throw new Error(`GitHub HTTP ${response.status}`);
    const result=await response.json();
    const data=parseOwnerSnapshot(result.body);
    render(data);
    line.textContent=`Page checked ${new Date().toLocaleTimeString()}. Updates every 2 minutes while this tab is open.`;
  }catch(error){
    const pill=document.querySelector('#freshness');
    pill.className='health stale';
    pill.textContent='Cannot verify current GitHub status';
    line.textContent=`Could not refresh: ${error.message}. Showing the previous snapshot, if any.`;
  }finally{loading=false;}
}
if(typeof document!=='undefined'){
  document.addEventListener('DOMContentLoaded',()=>{
    refresh();
    setInterval(()=>{if(!document.hidden)refresh();},REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  });
}
