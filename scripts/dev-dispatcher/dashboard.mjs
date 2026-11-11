#!/usr/bin/env node
// Owner-only read-only projection. Each installation owns its runtime and credentials.
import {readFileSync} from 'node:fs';
import {settings as source} from './settings.mjs';
import {makeClient} from './install-sync.mjs';
export async function combinedDashboard({api,manifest}){
 if(!Array.isArray(manifest?.repositories))throw Error('Invalid installation manifest');
 const rows=[];
 for(const repo of [source.repo,...manifest.repositories]){
  const config=repo===source.repo?source:
   JSON.parse(Buffer.from((await api(repo,'/contents/.dispatcher/settings.json?ref=main')).content,'base64').toString('utf8'));
  if(config.repo!==repo)throw Error('Cross-repo dashboard settings mismatch');
  const ledger=await api(config.ledger.repo,'/contents/'+config.ledger.path+'?ref=main');
  const state=JSON.parse(Buffer.from(ledger.content,'base64').toString('utf8'));
  const tasks=Object.values(state.tasks||{});
  rows.push({repo,ledger:config.ledger.repo,project:config.chatgpt.project_name,
   merged:tasks.filter(t=>t.status==='merged').length,
   proven:tasks.filter(t=>['integrated_proven','released_proven'].includes(t.status)).length,
   blocked:tasks.filter(t=>t.status==='blocked_needs_owner').length,
   notices:Object.values(state.owner_alerts||{}).filter(n=>n.status==='planned').length});
 }
 return rows;
}
export function renderDashboard(rows){
 return '# Project dispatcher owner dashboard (read-only)\n\n'+
 '| Repository | ChatGPT project | Ledger | Merged, unproven | Proven | Blocked | Muse notices |\n'+
 '| --- | --- | --- | ---: | ---: | ---: | ---: |\n'+
 rows.map(r=>'| '+r.repo+' | '+r.project+' | '+r.ledger+' | '+r.merged+
 ' | '+r.proven+' | '+r.blocked+' | '+r.notices+' |').join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const api=makeClient(process.env.DISPATCH_INSTALL_TOKEN);
 const manifest=JSON.parse(readFileSync(new URL('../../.dispatcher/installations.json',import.meta.url),'utf8'));
 combinedDashboard({api,manifest}).then(rows=>console.log(renderDashboard(rows)))
  .catch(e=>{console.error('Dashboard incomplete: '+e.message);process.exitCode=1;});
}
