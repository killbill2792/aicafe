import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {settings} from './settings.mjs';
export function normalizeExternalPlan(plan,source){
 if(Array.isArray(plan.merged_code_only))return plan;
 if(!Array.isArray(plan.tasks)||!Array.isArray(plan.merge_order)||
    new Set(plan.merge_order).size!==plan.tasks.length||
    plan.merge_order.some(id=>!plan.tasks.some(t=>t.id===id)))
   throw Error('External studio task plan requires unambiguous signed merge_order');
 const tasks=plan.merge_order.map((id,i)=>{
  const t=plan.tasks.find(x=>x.id===id),older=plan.merge_order[i-1];
  const edits=t.allowed_files||t.edits||[];
  if(!Array.isArray(edits)||!Array.isArray(t.acceptance)||!t.acceptance.length)
   throw Error('Incomplete external task '+id);
  const brief='https://github.com/'+source.repo+'/blob/'+source.ref+'/'+source.path+'#task-'+id;
  return {...t,edits,uses:(t.uses||[]).filter(p=>typeof p==='string'&&
   /^[a-zA-Z0-9_.\/-]+$/.test(p)),brief,
   depends_on:[...new Set([...(t.depends_on||[]),...(older?[older]:[])])],
   architecture_approval:t.architecture_approval||{approved:false},
   state:t.state||'proposed'};
 });
 return {...plan,tasks,merged_code_only:[],sequential_edit_overlap:true};
}
export async function loadQueue({github,config=settings,readLocal=readFileSync}={}){
 const source=config.queue;
 if(source.repo===config.repo)return JSON.parse(readLocal(resolve(process.cwd(),source.path),'utf8'));
 const url='https://api.github.com/repos/'+source.repo+'/contents/'+
  source.path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(source.ref);
 const file=await github.request(url);
 if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string')
  throw Error('External queue is missing or not a JSON file: '+source.repo+'/'+source.path);
 const data=Buffer.from(file.content.replace(/\s/g,''),'base64');
 if(data.length>400000)throw Error('External task plan too large');
 const parsed=JSON.parse(data.toString('utf8'));
 if(!Array.isArray(parsed.tasks))throw Error('External queue missing signed tasks');
 return normalizeExternalPlan(parsed,source);
}
