// Public-only visualization of already published GitHub facts. No credentials,
// private ledgers, new scheduler, or permission to execute/approve anything.
export const MERGE_REFRESH_INTERVAL_MS=600000;
export const MERGED_PULLS_URL=
  'https://api.github.com/repos/killbill2792/aicafe/pulls?state=closed&sort=updated&direction=desc&per_page=20';
const repo='https://github.com/killbill2792/aicafe';
const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
export function parsePublicExtras(markdown){
  if(typeof markdown!=='string' || !markdown.startsWith('<!-- aicafe-dispatcher-owner-view:v1 -->'))
    throw Error('Not a trusted public dispatcher snapshot');
  const graph={nodes:[],edges:[]}, history=[];
  let section='',mermaid=false;
  for(const line of markdown.split('\n')){
    if(line.startsWith('### ')){section=line.slice(4);mermaid=false;continue;}
    if(section==='Approved architecture to implementation map'){
      if(line.trim()===String.fromCharCode(96,96,96)+'mermaid'){mermaid=true;continue;}
      if(line.trim()===String.fromCharCode(96,96,96)){mermaid=false;continue;}
      if(mermaid){
        const node=line.match(/^\s*T_([A-Za-z0-9_]{1,64})\["([^"\r\n]{1,240})"\]$/);
        const edge=line.match(/^\s*T_([A-Za-z0-9_]{1,64})\s+-->\s+T_([A-Za-z0-9_]{1,64})$/);
        if(node && graph.nodes.length<25){
          const parts=node[2].split('<br/>');
          graph.nodes.push({id:node[1],title:clean(parts[0]),detail:clean(parts.slice(1).join(' '))});
        }else if(edge && graph.edges.length<90)graph.edges.push({from:edge[1],to:edge[2]});
      }
    }
    if(section==='Recent dispatcher history'&&line.startsWith('| ')&&history.length<12){
      const cells=line.split('|').slice(1,-1).map(clean);
      if(cells.length===4&&cells[0]!=='Task'&&cells[0]!=='---')
        history.push({task:cells[0],action:cells[1],status:cells[2],at:cells[3]});
    }
  }
  const runMatch=markdown.match(/\[Open dispatcher execution\]\(https:\/\/github\.com\/killbill2792\/aicafe\/actions\/runs\/(\d+)\)/);
  return {graph,history,runUrl:runMatch?repo+'/actions/runs/'+runMatch[1]:null};
}
export function parseRecentMerges(pulls){
  if(!Array.isArray(pulls))throw Error('Invalid GitHub PR response');
  return pulls.filter(p=>Number.isSafeInteger(p?.number)&&p.number>0 &&
    p.html_url===repo+'/pull/'+p.number && p.merged_at &&
    !Number.isNaN(Date.parse(p.merged_at)))
    .sort((a,b)=>Date.parse(b.merged_at)-Date.parse(a.merged_at)).slice(0,10)
    .map(p=>({pr:p.number,url:p.html_url,title:clean(p.title).slice(0,150),
      when:new Date(p.merged_at).toISOString(),
      sha:/^[a-f0-9]{40}$/.test(p.merge_commit_sha||'')?p.merge_commit_sha.slice(0,9):null}));
}
const el=(type,cls,value)=>{
  const e=document.createElement(type);if(cls)e.className=cls;
  if(value!==undefined)e.textContent=value;return e;
};
const link=(label,url)=>{
  const a=el('a','inline-link',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;
};
function showGraph(graph){
  const root=document.querySelector('#architecture-map');root.replaceChildren();
  if(!graph.nodes.length){root.append(el('p','empty','No approved map in this snapshot.'));return;}
  const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const edges=graph.edges.filter(e=>nodes.has(e.from)&&nodes.has(e.to)&&e.from!==e.to);
  const levels=new Map(graph.nodes.map(n=>[n.id,0]));
  for(let i=0;i<graph.nodes.length;i++){
    let changed=false;
    for(const edge of edges){
      const value=levels.get(edge.from)+1;
      if(value>levels.get(edge.to)&&value<graph.nodes.length){levels.set(edge.to,value);changed=true;}
    }
    if(!changed)break;
  }
  const columns=new Map();
  for(const n of graph.nodes){
    const level=levels.get(n.id);
    if(!columns.has(level))columns.set(level,[]);
    columns.get(level).push(n);
  }
  const track=el('div','architecture-track');
  for(const [level,group] of [...columns].sort((a,b)=>a[0]-b[0])){
    const column=el('section','architecture-stage');
    column.append(el('h3','','Stage '+(level+1)));
    for(const n of group){
      const card=el('article','architecture-card');
      card.append(el('strong','',n.title),el('span','state',n.detail||'Unknown'));
      const pr=n.detail.match(/\bPR #(\d+)\b/);
      if(pr){const p=el('p','small');p.append(link('View PR #'+pr[1],repo+'/pull/'+pr[1]));card.append(p);}
      const deps=edges.filter(e=>e.to===n.id).map(e=>e.from);
      if(deps.length)card.append(el('p','small','Depends on: '+deps.join(', ')));
      column.append(card);
    }
    track.append(column);
  }
  root.append(track);
}
export function renderPublicExtras(markdown){
  const data=parsePublicExtras(markdown);
  showGraph(data.graph);
  const list=document.querySelector('#recent-actions');list.replaceChildren();
  for(const h of data.history){
    const row=el('article','record');
    row.append(el('strong','',h.task+' · '+h.action),
      el('span','state',h.status),el('div','small',h.at));
    list.append(row);
  }
  if(!data.history.length)list.append(el('p','empty','No history in this snapshot.'));
  if(data.runUrl)document.querySelector('#dispatcher-run').href=data.runUrl;
}
let busy=false;
export async function loadVerifiedMerges(fetchFn=fetch){
  if(busy)return;
  busy=true;
  const status=document.querySelector('#merge-status');
  try{
    const response=await fetchFn(MERGED_PULLS_URL,{headers:{Accept:'application/vnd.github+json'},cache:'no-store'});
    if(!response.ok)throw Error('GitHub HTTP '+response.status);
    const merges=parseRecentMerges(await response.json());
    const root=document.querySelector('#merged-prs');root.replaceChildren();
    for(const m of merges){
      const row=el('article','record');
      const heading=el('div');
      heading.append(link('PR #'+m.pr+' · '+m.title,m.url));
      row.append(heading,el('div','small','Merged '+new Date(m.when).toLocaleString()+(m.sha?' · '+m.sha:'')));
      root.append(row);
    }
    if(!merges.length)root.append(el('p','empty','No verified merges returned by GitHub.'));
    status.textContent='Verified '+new Date().toLocaleTimeString();
  }catch(error){status.textContent='Merge check unavailable: '+error.message;}
  finally{busy=false;}
}
