import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ownerDashboardHandler} from './owner-dashboard-v3.mjs';
import {applyOwnerDashboardEdit} from './owner-controls-v3.mjs';
const password='correct-horse-battery-staple';
const state={version:1,updated_at:'2026-11-11T10:00:00Z',
 tasks:{A:{approved:true}},actions:{secret:{delivery:{prompt:'PRIVATE PROMPT DO NOT EXPOSE'}}},
 owner_alerts:{q:{status:'planned'}},lifecycle_v3:{rows:{A:{task_id:'A',current_stage:'APPROVED'}}}};
const auth=(user='owner',secret=password)=>'Basic '+Buffer.from(user+':'+secret).toString('base64');
async function withServer(work){
 let current=structuredClone(state);
 const handler=ownerDashboardHandler({
  ownerPassword:password,musePassword:'muse-only-password',
  readState:async()=>current,
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
