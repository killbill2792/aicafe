import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ownerDashboardHandler} from './owner-dashboard-v3.mjs';
import {applyOwnerDashboardEdit} from './owner-controls-v3.mjs';
import {applyMuseNote} from './muse-local-notes.mjs';
const password='correct-horse-battery-staple';
const state={version:1,updated_at:'2026-11-11T10:00:00Z',
 tasks:{A:{approved:true}},actions:{secret:{delivery:{prompt:'PRIVATE PROMPT DO NOT EXPOSE'}}},
 owner_alerts:{q:{status:'planned'}},lifecycle_v3:{rows:{A:{task_id:'A',current_stage:'APPROVED'}}}};
const auth=(user='owner',secret=password)=>'Basic '+Buffer.from(user+':'+secret).toString('base64');
async function withServer(work){
 let current=structuredClone(state),notes={version:1,entries:{}};
 const handler=ownerDashboardHandler({
  ownerPassword:password,musePassword:'muse-only-password',
  readState:async()=>current,
  readNotes:async()=>notes,
  saveNote:async(edit,opts)=>{notes=applyMuseNote(notes,edit,{...opts,
   now:'2026-11-11T10:00:00Z'});return notes;},
  editState:async(edit,opts)=>{current=applyOwnerDashboardEdit(current,edit,
   {...opts,now:'2026-11-11T10:00:00Z'});return current;}
 });
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try{return await work(url,()=>current);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('private dashboard rejects anonymous access and does not expose raw courier prompts',async()=>{
 await withServer(async url=>{
  assert.equal((await fetch(url+'/api/state')).status,401);
  const r=await fetch(url+'/api/state',{headers:{Authorization:auth()}});
  assert.equal(r.status,200);
  const text=await r.text();
  assert.ok(text.includes('APPROVED'));
  assert.ok(!text.includes('PRIVATE PROMPT DO NOT EXPOSE'));
 });
});
test('Muse can read private status but cannot modify owner controls',async()=>{
 await withServer(async url=>{
  const r=await fetch(url+'/api/state',{headers:{Authorization:auth('muse','muse-only-password')}});
  assert.equal(r.status,200);
  const blocked=await fetch(url+'/api/control',{method:'POST',
   headers:{Authorization:auth('muse','muse-only-password'),'Content-Type':'application/json'},
   body:JSON.stringify({task_id:'A',field:'note',value:'new',expected_revision:0})});
  assert.equal(blocked.status,403);
 });
});
test('owner can edit notes only; CI or authorization fields never accepted',async()=>{
 await withServer(async(url,getState)=>{
  const send=body=>fetch(url+'/api/control',{method:'POST',
   headers:{Authorization:auth(),'Content-Type':'application/json'},
   body:JSON.stringify(body)});
  const r=await send({task_id:'A',field:'note',value:'Investigate PR',expected_revision:0});
  assert.equal(r.status,200);
  assert.equal(getState().owner_controls.per_task.A.note,'Investigate PR');
  assert.equal(getState().tasks.A.approved,true);
  const forbidden=await send({task_id:'A',field:'ci_state',value:'success',expected_revision:1});
  assert.equal(forbidden.status,400);
 });
});
test('cross-origin writes and stale revision edits are refused',async()=>{
 await withServer(async(url)=>{
  const body=JSON.stringify({task_id:'A',field:'note',value:'X',expected_revision:0});
  const headers={Authorization:auth(),'Content-Type':'application/json'};
  const bad=await fetch(url+'/api/control',{method:'POST',
   headers:{...headers,Origin:'https://evil.example'},body});
  assert.equal(bad.status,403);
  assert.equal((await fetch(url+'/api/control',{method:'POST',headers,body})).status,200);
  const stale=await fetch(url+'/api/control',{method:'POST',headers,body});
  assert.equal(stale.status,409);
 });
});

test('Muse can register its known chat URL and note, but cannot edit CI or authorization',async()=>{
 await withServer(async url=>{
  const headers={Authorization:auth('muse','muse-only-password'),
    'Content-Type':'application/json'};
  const edit={task_id:'A',pr_number:488,chat_url:'https://chatgpt.com/c/1234abcd',
    stage:'waiting_owner',note:'Please review architecture',expected_revision:0};
  const saved=await fetch(url+'/api/notes',{method:'POST',headers,
    body:JSON.stringify(edit)});
  assert.equal(saved.status,200);
  const read=await fetch(url+'/api/notes',{headers:{Authorization:headers.Authorization}});
  const notes=await read.json();
  assert.equal(notes.entries.A.chat_url,edit.chat_url);
  assert.equal(notes.entries.A.stage,'waiting_owner');
  const bad=await fetch(url+'/api/notes',{method:'POST',headers,
    body:JSON.stringify({...edit,ci_state:'success',expected_revision:1})});
  assert.equal(bad.status,400);
  const stale=await fetch(url+'/api/notes',{method:'POST',headers,body:JSON.stringify(edit)});
  assert.equal(stale.status,409);
  const forbidden=await fetch(url+'/api/control',{method:'POST',headers,
    body:JSON.stringify({task_id:'A',field:'note',value:'X',expected_revision:0})});
  assert.equal(forbidden.status,403);
 });
});
test('private local coordination notes reject anonymous and hostile-origin edits',async()=>{
 await withServer(async url=>{
  assert.equal((await fetch(url+'/api/notes')).status,401);
  const headers={Authorization:auth('muse','muse-only-password'),
   'Content-Type':'application/json',Origin:'https://evil.test'};
  const r=await fetch(url+'/api/notes',{method:'POST',headers,
   body:JSON.stringify({task_id:'A',stage:'working',expected_revision:0})});
  assert.equal(r.status,403);
 });
});
test('local notes still work when the GitHub-backed ledger cannot be read',async()=>{
 const handler=ownerDashboardHandler({ownerPassword:password,
  musePassword:'muse-only-password',readState:async()=>{throw Error('GitHub unavailable');},
  editState:async()=>{throw Error('not called');},
  readNotes:async()=>({version:1,entries:{A:{task_id:'A',note:'Offline work allowed'}}}),
  saveNote:async()=>({version:1,entries:{}})});
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:auth('muse','muse-only-password')};
  assert.equal((await fetch(url+'/api/state',{headers})).status,503);
  const notes=await fetch(url+'/api/notes',{headers});
  assert.equal(notes.status,200);
  assert.match(await notes.text(),/Offline work allowed/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Muse direct PR monitor is private and works without legacy ledger',async()=>{
 const facts={version:1,observed_at:'2026-11-16T20:00:00Z',
  prs:[{number:488,head_sha:'a'.repeat(40),ci:'observed_green',codex:'clean'}],
  merged_prs:[]};
 const handler=ownerDashboardHandler({ownerPassword:password,
  musePassword:'muse-only-password',readFacts:async()=>facts,
  readState:async()=>{throw Error('No GitHub Actions ledger');},
  editState:async()=>{throw Error('not called');},
  readNotes:async()=>({version:1,entries:{}}),
  saveNote:async()=>({version:1,entries:{}})});
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/api/muse-status')).status,401);
  const r=await fetch(url+'/api/muse-status',{headers:{
   Authorization:auth('muse','muse-only-password')}});
  assert.equal(r.status,200);
  assert.equal((await r.json()).prs[0].number,488);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Muse can inspect pending suggestions locally without GitHub ledger writes',async()=>{
 const handler=ownerDashboardHandler({ownerPassword:password,
  musePassword:'muse-only-password',readState:async()=>{throw Error('Offline');},
  editState:async()=>{throw Error('not called');},
  readActions:async()=>({version:1,events:{
   localEvent:{kind:'continue_chat',pr_number:488,created_at:'2026-11-16T20:00:00Z',
    status:'suggested_unverified',chat_url:'https://chatgpt.com/c/1234'}
  }})});
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/api/muse-actions')).status,401);
  const response=await fetch(url+'/api/muse-actions',{headers:{
   Authorization:auth('muse','muse-only-password')}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.events.length,1);
  assert.equal(body.events[0].kind,'continue_chat');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('private dashboard script remains syntactically valid after adding Muse fields',()=>{
 const html=readFileSync(new URL('./owner-dashboard-v3.html',import.meta.url),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);
 assert.doesNotThrow(()=>new vm.Script(script[1]));
 assert.match(html,/id="muse-chat"/);
 assert.match(html,/id="muse-note"/);
 assert.match(html,/id="muse-prs"/);
});

test('form rejects a concurrent Muse edit instead of silently replacing its new stage and URL',async()=>{
 const html=readFileSync(new URL('./owner-dashboard-v3.html',import.meta.url),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],elements=new Map();
 const el=id=>{if(!elements.has(id)){let value='';const e={textContent:'',innerHTML:''};Object.defineProperty(e,'value',{get:()=>value,set:v=>{value=String(v);}});elements.set(id,e);}return elements.get(id);};
 let note={task_id:'A',revision:1,stage:'working',chat_url:'https://chatgpt.com/c/1234',note:'Owner original',pr_number:488},post=null;
 const fetchMock=async(url,opts={})=>{
  if(url==='/api/notes'&&opts.method==='POST'){
   post=JSON.parse(opts.body);
   return {ok:false,status:409,json:async()=>({error:'Dashboard edit conflict'})};
  }
  const data=url==='/api/notes'?{version:1,entries:{A:note}}:
   url==='/api/state'?{lifecycle:{},owner_controls:{}}:
   url==='/api/muse-status'?{prs:[],merged_prs:[]}:{events:[]};
  return {ok:true,json:async()=>data};
 };
 const ctx=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[]},
  fetch:fetchMock,setInterval:()=>{},alert:()=>{},Date});
 vm.runInContext(script,ctx);await vm.runInContext('refreshNotes()',ctx);
 vm.runInContext('selectMuseNote("A")',ctx);
 note={...note,revision:2,stage:'paused',chat_url:'https://chatgpt.com/c/new'};
 await vm.runInContext('refreshNotes()',ctx);
 await el('muse-save').onclick();
 assert.equal(post.expected_revision,1);
 assert.equal(note.stage,'paused');
 assert.match(el('muse-saved').textContent,/Not saved: Dashboard edit conflict/);
});
