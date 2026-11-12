import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubFacts} from './github.mjs';

const repo='killbill2792/aicafe';
const ok={ok:true,status:200,json:async()=>({status:'ok'})};
const fail=(status,message='upstream unavailable')=>({
 ok:false,status,json:async()=>({message}),headers:{get:()=>null}
});

test('GitHub transient 500/502 read errors retry twice without changing authority',async()=>{
 let calls=0;
 const delays=[];
 const gh=new GitHubFacts({repo,token:'test',sleepFn:async n=>delays.push(n),
  fetchFn:async()=>{calls++;return calls===1?fail(500):
    calls===2?fail(502):ok;}});
 assert.deepEqual(await gh.request('/issues/411'),{status:'ok'});
 assert.equal(calls,3);
 assert.deepEqual(delays,[150,300]);
});

test('uncertain POST/PUT writes and 429 rate limits are never replayed',async()=>{
 for(const method of ['POST','PUT','PATCH','DELETE']){
  let calls=0;
  const gh=new GitHubFacts({repo,token:'test',sleepFn:async()=>{},
   fetchFn:async()=>{calls++;return fail(500);}});
  await assert.rejects(gh.request('/issues/411',{method}),/status=500/);
  assert.equal(calls,1);
 }
 let calls=0;
 const gh=new GitHubFacts({repo,token:'test',sleepFn:async()=>{},
  fetchFn:async()=>{calls++;return fail(429,'secondary rate limit');}});
 await assert.rejects(gh.request('/issues/411'),/status=429/);
 assert.equal(calls,1);
});

test('transient network faults retry only safe GET and expose permanent outage',async()=>{
 let attempts=0;
 const gh=new GitHubFacts({repo,token:'test',sleepFn:async()=>{},
  fetchFn:async()=>{attempts++;throw Error('transport');}});
 await assert.rejects(gh.request('/issues/411'),/status=network/);
 assert.equal(attempts,3);
 attempts=0;
 await assert.rejects(gh.request('/pulls/1',{method:'POST'}),/status=network/);
 assert.equal(attempts,1);
});
