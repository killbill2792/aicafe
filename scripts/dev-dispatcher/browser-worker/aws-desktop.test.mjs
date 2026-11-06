import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireLiveApproval, parseGeometry, parseMouse, systemRun, sendOnce, pilotCurrent } from './aws-desktop.mjs';

const action = { id:'aws_demo_1', provider:'chatgpt', conversation_url:'https://chatgpt.com/c/test-1',
  prompt:'Approved small test message', approved:true };
const env = { AICAFE_BROWSER_LIVE_SEND:'1', DISPLAY:':20' };
const geometry = 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\n';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'aws-worker-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'receipts'),{recursive:true});
  await writeFile(path.join(dir,'aws-chrome-editor.json'),
    JSON.stringify({version:1,width:1200,height:800,xOffset:600,yOffset:730}));
  return dir;
}
function fakeDesktop(address = action.conversation_url, { copyWorks = true, focus = '123' } = {}) {
  const calls=[];
  let clipboard='';
  const run=(bin,args,input)=>{
    calls.push({bin,args,input:input ? '<redacted>' : undefined});
    if(bin==='xdotool' && args[0]==='search') return '123';
    if(bin==='xdotool' && args[0]==='getwindowgeometry') return geometry;
    if(bin==='xdotool' && args[0]==='getactivewindow') return focus;
    if(bin==='xdotool' && args[0]==='key' && args.includes('ctrl+c') && copyWorks) clipboard=address;
    if(bin==='xclip' && args.includes('-o')) return clipboard;
    if(bin==='xclip') clipboard=input;
    return '';
  };
  return {run,calls};
}
test('permission gate rejects unsupported Claude, missing display, and unapproved actions',()=>{
  assert.throws(()=>requireLiveApproval({...action,provider:'claude',conversation_url:'https://claude.ai/chat/abc'},env),/Claude/);
  assert.throws(()=>requireLiveApproval(action,{DISPLAY:':20'}),/OFF/);
  assert.throws(()=>requireLiveApproval({...action,approved:false},env),/not approved/);
  assert.throws(()=>requireLiveApproval(action,{AICAFE_BROWSER_LIVE_SEND:'1'}),/DISPLAY/);
});
test('parse window state fails closed on invalid data',()=>{
  assert.deepEqual(parseGeometry(geometry),{x:0,y:0,width:1200,height:800});
  assert.deepEqual(parseMouse('x:600 y:730 screen:0 window:123'),{x:600,y:730});
  assert.throws(()=>parseGeometry('HEIGHT=20'),/geometry/);
  assert.throws(()=>parseMouse('broken'),/coordinates/);
});
test('one approved send targets exact URL and is never replayed',async t=>{
  const dir=await fixture(t),mock=fakeDesktop();
  const result=await sendOnce(action,{baseDir:dir,env,run:mock.run,pause:async()=>{}});
  assert.deepEqual(result,{id:action.id,status:'submitted_unverified'});
  const receipt=JSON.parse(await readFile(path.join(dir,'receipts',action.id+'.json'),'utf8'));
  assert.equal(receipt.status,'submitted_unverified');
  assert.equal(JSON.stringify(receipt).includes(action.prompt),false);
  assert.equal(mock.calls.some(c=>c.bin==='xdotool' && c.args.includes('Return')),true);
  await assert.rejects(sendOnce(action,{baseDir:dir,env,run:mock.run,pause:async()=>{}}),e=>e.code==='EEXIST');
});
test('redirected/login URL prevents editor click and sending',async t=>{
  const dir=await fixture(t),mock=fakeDesktop('https://chatgpt.com/auth/login');
  const result=await sendOnce(action,{baseDir:dir,env,run:mock.run,pause:async()=>{}});
  assert.equal(result.status,'needs_login');
  assert.equal(mock.calls.some(c=>c.bin==='xdotool' && c.args[0]==='click'),false);
  assert.equal(JSON.parse(await readFile(path.join(dir,'receipts',action.id+'.json'),'utf8')).status,'needs_login');
});
test('multiple Chrome windows stop before any editor interaction',async t=>{
  const dir=await fixture(t);
  const fake=fakeDesktop();
  fake.run=(bin,args,input)=>bin==='xdotool' && args[0]==='search' ? '123\n456' : '';
  await assert.rejects(sendOnce(action,{baseDir:dir,env,run:fake.run,pause:async()=>{}}),/Exactly one/);
  assert.equal(JSON.parse(await readFile(path.join(dir,'receipts',action.id+'.json'),'utf8')).status,'not_submitted');
});
test('after editor interaction a failure is uncertain, not silently retried',async t=>{
  const dir=await fixture(t),mock=fakeDesktop();
  let pasted=false;
  const run=(bin,args,input)=>{
    if (bin==='xclip' && input===action.prompt) pasted=true;
    if (pasted && bin==='xdotool' && args[0]==='key') throw new Error('X11 connection failed');
    return mock.run(bin,args,input);
  };
  await assert.rejects(sendOnce(action,{baseDir:dir,env,run,pause:async()=>{}}),/X11 connection failed/);
  assert.equal(JSON.parse(await readFile(path.join(dir,'receipts',action.id+'.json'),'utf8')).status,'uncertain');
});

test('clipboard writes detach inherited pipes; reads retain captured stdout',()=>{
  const seen=[];
  const exec=(exe,args,opts)=>{seen.push(opts.stdio); return opts.stdio[1]==='ignore' ? null : 'ok';};
  // Real Node returns null for an ignored stdout stream, not an empty string.
  assert.equal(systemRun('xclip',['-selection','clipboard'],'safe',exec),'');
  assert.equal(systemRun('xclip',['-selection','clipboard','-o'],undefined,exec),'ok');
  assert.deepEqual(seen,[['pipe','ignore','ignore'],['pipe','pipe','pipe']]);
});
test('stale clipboard cannot impersonate a copied address; Chrome focus is mandatory',async t=>{
  const dir=await fixture(t),bad=fakeDesktop(action.conversation_url,{copyWorks:false});
  const result=await sendOnce(action,{baseDir:dir,env,run:bad.run,pause:async()=>{}});
  assert.equal(result.status,'needs_login');
  assert.equal(bad.calls.some(c=>c.bin==='xdotool' && c.args[0]==='click'),false);
  const other=await fixture(t),blurred=fakeDesktop(action.conversation_url,{focus:'999'});
  await assert.rejects(sendOnce(action,{baseDir:other,env,run:blurred.run,pause:async()=>{}}),/no longer the active/);
  assert.equal(blurred.calls.some(c=>c.bin==='xdotool' && c.args[0]==='click'),false);
});
test('a concurrent send cannot interleave Chrome and clipboard operations',async t=>{
  const dir=await fixture(t),mock=fakeDesktop();
  let entered,release;
  const paused=new Promise(r=>{release=r;});
  const waiting=new Promise(r=>{entered=r;});
  const first=sendOnce(action,{baseDir:dir,env,run:mock.run,pause:async ms=>{
    if(ms===3000){entered();await paused;}
  }});
  await waiting;
  await assert.rejects(sendOnce({...action,id:'aws_demo_2'},
    {baseDir:dir,env,run:mock.run,pause:async()=>{}}),e=>e.code==='EEXIST');
  release();
  assert.equal((await first).status,'submitted_unverified');
  await assert.rejects(readFile(path.join(dir,'aws-desktop-session.lock')),
    e=>e.code==='ENOENT');
});

test('pilot-current uses only exact active chat URL and sends a harmless one-time message',async t=>{
  const dir=await fixture(t),mock=fakeDesktop();
  const result=await pilotCurrent({baseDir:dir,env,run:mock.run,pause:async()=>{}});
  assert.equal(result.status,'submitted_unverified');
  assert.match(result.id,/^pilot_[0-9a-f]{32}$/);
  const receipt=JSON.parse(await readFile(path.join(dir,'receipts',result.id+'.json'),'utf8'));
  assert.equal(receipt.conversation_url,action.conversation_url);
  assert.equal(receipt.status,'submitted_unverified');
});
test('pilot-current rejects current page outside an existing ChatGPT conversation',async t=>{
  const dir=await fixture(t),mock=fakeDesktop('https://chatgpt.com/');
  await assert.rejects(pilotCurrent({baseDir:dir,env,run:mock.run,pause:async()=>{}}),/Conversation URL/);
});
