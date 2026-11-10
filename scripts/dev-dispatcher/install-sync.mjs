#!/usr/bin/env node
// Install and synchronize independent dispatcher source copies, PR-only.
// Every target has its own settings, ledger, Muse space and ChatGPT account.
import {readFileSync} from 'node:fs';
import {settings as source,validateSettings} from './settings.mjs';
const repoOK=s=>/^[\w.-]+\/[\w.-]+$/.test(s||'');
const safePath=p=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!p.split('/').includes('..');
export function targetSettings(input){
 const mandatory=['repo','ledger_repo','queue_path','project_url','account_label',
  'project_id','project_name','muse_space','owner_login','baseline_check',
  'baseline_workflow','acceptance_workflow','integration_workflow','integration_file'];
 if(mandatory.some(k=>typeof input?.[k]!=='string'||!input[k].trim()))
  throw Error('Missing per-repository installation inputs');
 const t=structuredClone(source),slug=input.repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g,'-');
 delete t.legacy_proof_before; t.repo=input.repo;t.queue={repo:input.repo,path:input.queue_path,ref:'main'};
 t.ledger={repo:input.ledger_repo,path:input.ledger_path||source.ledger.path,
  receipts_path:input.receipts_path||source.ledger.receipts_path,
  owner_view_path:input.owner_view_path||source.ledger.owner_view_path};
 t.chatgpt={project_url:input.project_url,account_label:input.account_label,
  project_id:input.project_id,project_name:input.project_name};
 t.muse={space:input.muse_space,delivery_owner:'muse',retry_seconds:900};
 t.owner={login:input.owner_login,dashboard_issue:Number(input.dashboard_issue||0)};
 t.naming={task_prefix:slug,branch_prefix:'feat/'+slug+'-task-',marker_prefix:slug};
 t.required_checks={baseline:input.baseline_check,baseline_workflow:input.baseline_workflow,
  acceptance_workflow:input.acceptance_workflow,integration_workflow:input.integration_workflow};
 t.workflows={dispatcher:'dispatcher.yml',delayed_wake:'dispatcher-delayed-wake.yml',
  integration:input.integration_file};
 t.auto_merge={coding:input.auto_merge_coding===true,infrastructure:false};
 t.paths.pos_preflight=input.pos_preflight||null;
 if(input.task_brief_root)t.paths.task_brief_root=input.task_brief_root;
 if(!repoOK(t.repo)||!repoOK(t.ledger.repo)||t.ledger.repo===source.ledger.repo||
    t.repo===source.repo||t.chatgpt.project_url===source.chatgpt.project_url||
    t.chatgpt.account_label===source.chatgpt.account_label||
    t.muse.space===source.muse.space||!safePath(t.queue.path))throw Error('Shared or unsafe target runtime');
 return validateSettings(t);
}
export function templatePaths(files){
 return files.filter(x=>x.type==='blob'&&
  (x.path.startsWith('scripts/dev-dispatcher/')&&
   (x.path.endsWith('.mjs')&&!x.path.endsWith('.test.mjs')||
    ['settings.test.mjs','wake.test.mjs'].some(t=>x.path.endsWith('/'+t)))||
   x.path==='.github/workflows/'+source.workflows.dispatcher||
   x.path==='.github/workflows/'+source.workflows.delayed_wake));
}
export function renderDispatcherYaml(content,target){
 return content.replaceAll(source.required_checks.baseline_workflow,target.required_checks.baseline_workflow)
 .replaceAll(source.required_checks.acceptance_workflow,target.required_checks.acceptance_workflow)
 .replaceAll(source.required_checks.integration_workflow,target.required_checks.integration_workflow)
 .replaceAll(source.chatgpt.project_name,target.chatgpt.project_name)
 .replaceAll(source.workflows.integration,target.workflows.integration)
 .replaceAll(source.naming.task_prefix+'-dispatcher',target.naming.task_prefix+'-dispatcher')
 .replaceAll(String(source.owner.dashboard_issue),String(target.owner.dashboard_issue))
 .replace('node --test scripts/dev-dispatcher/*.test.mjs scripts/dev-dispatcher/bridge/bridge.test.mjs',
 'node --test scripts/dev-dispatcher/settings.test.mjs scripts/dev-dispatcher/wake.test.mjs');
}
export function destination(path,target){
 if(path==='.github/workflows/'+source.workflows.dispatcher)
  return '.github/workflows/'+target.workflows.dispatcher;
 if(path==='.github/workflows/'+source.workflows.delayed_wake)
  return '.github/workflows/'+target.workflows.delayed_wake;
 return path;
}
export function makeClient(token,fetchFn=fetch){
 if(!token)throw Error('Target-specific installation token required');
 return async(repo,path,{method='GET',body}={})=>{
  if(!repoOK(repo))throw Error('Invalid repository');
  const r=await fetchFn('https://api.github.com/repos/'+repo+path,{method,
   headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok)throw Error('Template GitHub '+method+' '+repo+' failed: HTTP '+r.status);
  return r.status===204?{}:r.json();
 };
}
async function readBlob(api,repo,sha){
 const b=await api(repo,'/git/blobs/'+sha);
 if(b.encoding!=='base64')throw Error('Unexpected template blob');
 return Buffer.from(b.content.replace(/\s/g,''),'base64').toString('utf8');
}
export async function openUpdatePr({api,sourceRepo=source.repo,target,mode='sync',sourceRef='main'}){
 validateSettings(target,{expectedRepo:target.repo});
 const sourceHead=await api(sourceRepo,'/git/ref/heads/'+sourceRef);
 const srcSha=sourceHead.object.sha;
 const srcCommit=await api(sourceRepo,'/git/commits/'+srcSha);
 const sourceTree=(await api(sourceRepo,'/git/trees/'+srcCommit.tree.sha+'?recursive=1')).tree;
 const selected=templatePaths(sourceTree);
 if(!selected.length||selected.some(x=>!x.sha))throw Error('Template source unavailable');
 const current=await api(target.repo,'/git/ref/heads/main');
 const base=current.object.sha,commit=await api(target.repo,'/git/commits/'+base);
 const entries=[];
 for(const file of selected){
  let text=await readBlob(api,sourceRepo,file.sha);
  if(file.path==='.github/workflows/'+source.workflows.dispatcher)
   text=renderDispatcherYaml(text,target);
  const blob=await api(target.repo,'/git/blobs',{method:'POST',
   body:{content:Buffer.from(text).toString('base64'),encoding:'base64'}});
  entries.push({path:destination(file.path,target),mode:'100644',type:'blob',sha:blob.sha});
 }
 if(mode==='install'){
  const b=await api(target.repo,'/git/blobs',{method:'POST',body:{
   content:Buffer.from(JSON.stringify(target,null,2)+'\n').toString('base64'),encoding:'base64'}});
  entries.push({path:'.dispatcher/settings.json',mode:'100644',type:'blob',sha:b.sha});
 }
 const tree=await api(target.repo,'/git/trees',{method:'POST',
  body:{base_tree:commit.tree.sha,tree:entries}});
 if(tree.sha===commit.tree.sha)return {repo:target.repo,status:'unchanged',source_sha:srcSha};
 const built=await api(target.repo,'/git/commits',{method:'POST',body:{
  message:'chore(dispatcher): '+mode+' independent template',tree:tree.sha,parents:[base]}});
 const branch='dispatcher/template-'+mode+'-'+srcSha.slice(0,12);
 await api(target.repo,'/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha:built.sha}});
 const pr=await api(target.repo,'/pulls',{method:'POST',body:{title:
  'chore(dispatcher): '+mode+' independent repo copy',head:branch,base:'main',draft:true,
  body:'Template source '+sourceRepo+'@'+srcSha+
   '. Independent settings/queue/ledger/Muse/ChatGPT. Owner merge only; exact-head CI and Codex required.'}});
 return {repo:target.repo,pr:pr.html_url,head:built.sha,source_sha:srcSha,files:entries.length};
}
export async function openLedgerWakePr({api,target,sourceRepo=source.repo}){
 const src=await api(sourceRepo,'/contents/.dispatcher/template/ledger-receipt-wake.yml?ref=main');
 if(!src.content)throw Error('Ledger receipt watcher missing');
 const yaml=Buffer.from(src.content,'base64').toString('utf8')
  .replace(/^          TARGET_REPO: .*$/m,"          TARGET_REPO: '"+target.repo+"'")
  .replace('dispatcher/receipts/**',target.ledger.receipts_path+'/**');
 const repo=target.ledger.repo;
 const main=await api(repo,'/git/ref/heads/main'),base=main.object.sha;
 const previous=await api(repo,'/git/commits/'+base);
 const blob=await api(repo,'/git/blobs',{method:'POST',
  body:{content:Buffer.from(yaml).toString('base64'),encoding:'base64'}});
 const tree=await api(repo,'/git/trees',{method:'POST',body:{base_tree:previous.tree.sha,
  tree:[{path:'.github/workflows/dispatcher-ledger-receipt-wake.yml',
   mode:'100644',type:'blob',sha:blob.sha}]}});
 if(tree.sha===previous.tree.sha)return {repo,status:'unchanged'};
 const commit=await api(repo,'/git/commits',{method:'POST',body:{
  message:'chore(dispatcher): wake independent target on receipt commit',
  tree:tree.sha,parents:[base]}});
 const branch='dispatcher/receipt-wake-'+commit.sha.slice(0,12);
 await api(repo,'/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha:commit.sha}});
 const pr=await api(repo,'/pulls',{method:'POST',body:{title:'chore(dispatcher): wake target after Muse receipt',
  head:branch,base:'main',draft:true,body:'Target '+target.repo+
  '. Own ledger only, owner merge. Configure target-scoped DISPATCH_TARGET_WAKE_TOKEN secret.'}});
 return {repo,pr:pr.html_url,head:commit.sha};
}
export async function synchronize({api,manifest,sourceRepo=source.repo}){
 const names=manifest?.repositories;
 if(!Array.isArray(names)||new Set(names).size!==names.length||names.some(x=>!repoOK(x)||x===sourceRepo))
  throw Error('Invalid installation manifest');
 const prs=[];
 for(const repo of names){
  const file=await api(repo,'/contents/.dispatcher/settings.json?ref=main');
  const target=validateSettings(JSON.parse(Buffer.from(file.content,'base64').toString('utf8')),
   {expectedRepo:repo});
  if(target.ledger.repo===source.ledger.repo||
    target.chatgpt.project_url===source.chatgpt.project_url||
    target.muse.space===source.muse.space)throw Error('Cross-repo runtime sharing');
  prs.push(await openUpdatePr({api,sourceRepo,target,mode:'sync'}));
 }
 return prs;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const api=makeClient(process.env.DISPATCH_INSTALL_TOKEN);
 (async()=>process.argv.includes('--install')
  ? (async()=>{const target=targetSettings(JSON.parse(process.env.DISPATCH_INSTALL_INPUTS||'{}'));
    return [await openUpdatePr({api,target,mode:'install'}),await openLedgerWakePr({api,target})];})()
  : process.argv.includes('--sync')
  ? synchronize({api,manifest:JSON.parse(readFileSync(new URL('../../.dispatcher/installations.json',import.meta.url)))})
  : Promise.reject(Error('Specify --install or --sync')))()
 .then(out=>console.log(JSON.stringify(out)))
 .catch(e=>{console.error(e.message);process.exitCode=1;});
}
