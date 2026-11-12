import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubLedger} from './ledger.mjs';

const sha='a'.repeat(40);
const fixture={version:1,updated_at:'2026-11-11T23:58:00Z',
  tasks:{T:{status:'review_fixing'}},actions:{},
  owner_alerts:{large:{status:'planned',question:'A'.repeat(1_210_000)}}};
const encoded=Buffer.from(JSON.stringify(fixture)).toString('base64');
const mk=fn=>new GitHubLedger({repo:'private/ledger',token:'test-only',fetchFn:fn});

test('private ledger >1 MiB loads by immutable tree/blob without Contents API',async()=>{
  const urls=[];
  const ledger=mk(async url=>{
    urls.push(url);
    if(url.includes('/git/trees/main?recursive=1'))return {ok:true,status:200,
      json:async()=>({truncated:false,tree:[{path:'dispatcher/state.json',type:'blob',sha}]})};
    if(url.includes('/git/blobs/'+sha))return {ok:true,status:200,
      json:async()=>({encoding:'base64',content:encoded,size:Buffer.byteLength(JSON.stringify(fixture))})};
    throw Error('Unexpected URL '+url);
  });
  const result=await ledger.load();
  assert.equal(result.sha,sha);
  assert.equal(result.state.owner_alerts.large.question.length,1_210_000);
  assert.equal(urls.length,2);
  assert.ok(urls.every(url=>!url.includes('/contents/')));
});

test('missing Git tree ledger path preserves clean empty-ledger behavior',async()=>{
  const ledger=mk(async()=>({ok:true,status:200,json:async()=>({tree:[],truncated:false})}));
  const result=await ledger.load();
  assert.equal(result.sha,null);
  assert.deepEqual(result.state.tasks,{});
});

test('partial/truncated Git tree never mistakes missing private ledger for empty',async()=>{
  const ledger=mk(async()=>({ok:true,status:200,
    json:async()=>({truncated:true,tree:[]})}));
  await assert.rejects(ledger.load(),/Ledger Git tree invalid/);
});

test('invalid blob response has safe shape diagnostics, not source contents',async()=>{
  const ledger=mk(async url=>({ok:true,status:200,json:async()=>url.includes('/git/trees/')
    ? {truncated:false,tree:[{path:'dispatcher/state.json',type:'blob',sha}]}
    : {encoding:'none',content:'secret-private-data'}}));
  await assert.rejects(ledger.load(),err=>
    /Ledger Git blob invalid/.test(err.message) && /encoding: none/.test(err.message) &&
    !err.message.includes('secret-private-data'));
});

test('Git blob API HTTP failure retains status and never prints private body',async()=>{
  const ledger=mk(async url=>url.includes('/git/trees/')
    ? {ok:true,status:200,json:async()=>({tree:[{path:'dispatcher/state.json',type:'blob',sha}]})}
    : {ok:false,status:403,headers:{get:()=>null},text:async()=>'',json:async()=>({message:'Forbidden'})});
  await assert.rejects(ledger.load(),/Ledger HTTP 403/);
});
