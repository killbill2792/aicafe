import test from 'node:test'; import assert from 'node:assert/strict';
import {loadSettings,validateSettings} from './settings.mjs'; import {targetSettings,templatePaths,renderDispatcherYaml,openUpdatePr,openLedgerWakePr,synchronize} from './install-sync.mjs';
const source=loadSettings(),input={ repo:'killbill2792/MVPStyli',ledger_repo:'killbill2792/stylit-ledger',
queue_path:'docs/stylit-queue.json',project_url:'https://chatgpt.com/g/g-p-stylit', account_label:'Stylit account',project_id:'stylit',project_name:'Stylit',muse_space:'stylit-space',
owner_login:'killbill2792',baseline_check:'Stylit PR baseline',baseline_workflow:'Stylit CI', acceptance_workflow:'Stylit Acceptance',integration_workflow:'Stylit Integration',
integration_file:'stylit-integration.yml',dashboard_issue:12,
queue_repo:'killbill2792/studio',queue_path:'studio/ideas/stylit-agent/tasks.json',
protected_files:[{owner:'Lakshmi',source_repo:'killbill2792/studio',source_pr:4,paths:['studio/ideas/stylit-agent/**']}]}; if(source.repo===input.repo)input.repo='demo/second-stylit';
if(source.ledger.repo===input.ledger_repo)input.ledger_repo='demo/second-ledger'; if(source.chatgpt.project_url===input.project_url)input.project_url='https://chatgpt.com/g/g-p-second-stylit';
if(source.chatgpt.account_label===input.account_label)input.account_label='Another account'; if(source.chatgpt.project_name===input.project_name)input.project_name='Second Stylit';
if(source.muse.space===input.muse_space)input.muse_space='another-muse'; const target=targetSettings(input),b64=s=>Buffer.from(s).toString('base64');
test('settings validation isolates repository, ledger, Muse space and ChatGPT project',()=>{ assert.equal(validateSettings(source,{expectedRepo:source.repo}),source);
assert.equal(target.repo,input.repo);assert.equal(target.chatgpt.account_label,input.account_label); assert.equal(target.muse.space,input.muse_space);assert.notEqual(target.ledger.repo,source.ledger.repo);
 assert.equal(target.queue.repo,'killbill2792/studio');
assert.throws(()=>validateSettings(target,{expectedRepo:source.repo}),/cross-repository/); assert.throws(()=>targetSettings({...input,ledger_repo:source.ledger.repo}),/Shared/);
assert.throws(()=>targetSettings({...input,muse_space:source.muse.space}),/Shared/); assert.throws(()=>targetSettings({...input,project_url:source.chatgpt.project_url}),/Shared/);
}); test('template excludes runtime queue/ledger and renders target-specific checks',()=>{
const files=[ {path:'scripts/dev-dispatcher/run.mjs',type:'blob',sha:'a'},
{path:'scripts/dev-dispatcher/core.test.mjs',type:'blob',sha:'b'}, {path:'scripts/dev-dispatcher/wake.test.mjs',type:'blob',sha:'c'},
{path:'docs/plans/universal-supervisor-queue.json',type:'blob',sha:'d'}, {path:'.github/workflows/'+source.workflows.dispatcher,type:'blob',sha:'e'}];
assert.deepEqual(templatePaths(files).map(x=>x.sha),['a','b','c','e']); const yaml=renderDispatcherYaml('name: '+source.chatgpt.project_name+
'\nworkflow: '+source.required_checks.baseline_workflow,target); assert.ok(yaml.includes(target.chatgpt.project_name));assert.match(yaml,/Stylit CI/);
}); function fakeApi(){
const calls=[],api=async(repo,path,{method='GET',body}={})=>{ calls.push({repo,path,method,body});
if(path.startsWith('/contents/.dispatcher/settings.json'))return {content:b64(JSON.stringify(target))}; if(path.startsWith('/contents/.dispatcher/template/ledger-receipt-wake.yml'))
return {content:b64('name: wake\n          TARGET_REPO: PLACEHOLDER\n')}; if(path.startsWith('/git/ref/heads/'))return {object:{sha:'a'.repeat(40)}};
if(path.startsWith('/git/commits/')&&method==='GET')return {tree:{sha:'old-tree'}}; if(path.startsWith('/git/trees/')&&method==='GET')return {tree:[
{type:'blob',path:'scripts/dev-dispatcher/run.mjs',sha:'blob-a'}, {type:'blob',path:'.github/workflows/'+source.workflows.dispatcher,sha:'blob-b'}]};
if(path.startsWith('/git/blobs/')&&method==='GET') return {encoding:'base64',content:b64(path.endsWith('blob-b')?'name: '+source.chatgpt.project_name:'export const ok=true;')};
if(path==='/git/blobs'&&method==='POST')return {sha:'blob-'+calls.length}; if(path==='/git/trees'&&method==='POST')return {sha:'new-tree'};
if(path==='/git/commits'&&method==='POST')return {sha:'b'.repeat(40)}; if(path==='/git/refs'&&method==='POST')return {};
if(path==='/pulls'&&method==='POST')return {html_url:'https://github.com/'+repo+'/pull/1'}; throw Error('Unexpected mock GitHub '+repo+path);
}; return {api,calls};
} test('setup creates target and private ledger watcher draft PRs, never merges',async()=>{
const {api,calls}=fakeApi(); const out=await openUpdatePr({api,target,mode:'install'});
const watcher=await openLedgerWakePr({api,target}); assert.equal(out.repo,target.repo);assert.equal(watcher.repo,target.ledger.repo);
const prs=calls.filter(x=>x.path==='/pulls'&&x.method==='POST'); assert.equal(prs.length,2);assert.ok(prs.every(x=>x.body.draft===true));
const blobs=calls.filter(x=>x.path==='/git/blobs'&&x.method==='POST'); assert.ok(blobs.some(x=>Buffer.from(x.body.content,'base64').toString().includes(target.chatgpt.project_url)));
assert.ok(blobs.some(x=>Buffer.from(x.body.content,'base64').toString().includes(target.repo))); assert.ok(!blobs.some(x=>Buffer.from(x.body.content,'base64').toString().includes(source.ledger.repo)));
}); test('sync reads every installed copy settings and opens only a local update PR',async()=>{
const {api,calls}=fakeApi(); const out=await synchronize({api,manifest:{repositories:[target.repo]}});
assert.equal(out.length,1);assert.equal(out[0].repo,target.repo); assert.equal(calls.filter(x=>x.path==='/pulls').length,1);
assert.ok(!calls.some(x=>x.path.includes('/dispatcher/state.json'))); await assert.rejects(synchronize({api,manifest:{repositories:[target.repo,target.repo]}}),/Invalid installation manifest/);
});
