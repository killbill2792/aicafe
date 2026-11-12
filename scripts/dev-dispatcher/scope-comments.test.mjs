import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchScopeComments} from './scope-comments.mjs';

test('scope issue pagination sees valid early and late plans beyond 100 comments',async()=>{
 const all=Array.from({length:225},(_,i)=>({id:i+1,body:i===7||i===208
  ? '<!-- aicafe-scope-plan:v1 {} -->':'other'}));
 const pages=[];
 const github={request:async path=>{
  const page=Number(new URL('https://api.github.test'+path).searchParams.get('page'));
  pages.push(page);
  return all.slice((page-1)*100,page*100);
 }};
 const result=await fetchScopeComments(github,411);
 assert.equal(result.length,225);
 assert.deepEqual(pages,[1,2,3]);
 assert.equal(result.filter(c=>c.body.includes('aicafe-scope-plan')).length,2);
});

test('scope issue read fails closed on duplicate pages, invalid metadata or GitHub 500',async()=>{
 const first=Array.from({length:100},(_,i)=>({id:i+1,body:'other'}));
 const loop={request:async()=>first};
 await assert.rejects(fetchScopeComments(loop,411),/Repeated or invalid/);
 const bad={request:async()=>[{id:0}]};
 await assert.rejects(fetchScopeComments(bad,411),/Repeated or invalid/);
 await assert.rejects(fetchScopeComments({request:async()=>{throw Error('HTTP 500')}},411),/HTTP 500/);
 await assert.rejects(fetchScopeComments(loop,0),/Invalid scope issue/);
});
