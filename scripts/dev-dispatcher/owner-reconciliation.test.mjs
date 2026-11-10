import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubFacts } from './github.mjs'; const head='b'.repeat(40), base='a'.repeat(40), main='c'.repeat(40);
test('base-current uses live main tip, unresolved P2 threads and owner comments/push',async()=>{
 const calls=[]; const pr={number:422,head:{sha:head,ref:'feat',repo:{full_name:'owner/aicafe'}},base:{sha:base,ref:'main',repo:{full_name:'owner/aicafe'}},
 mergeable:true,mergeable_state:'clean',draft:false,labels:[],user:{login:'coder'},updated_at:'2026-11-10T18:00:00Z'};
 const gh=new GitHubFacts({repo:'owner/aicafe',token:'mock',fetchFn:async(url,options={})=>{
  const p=new URL(url).pathname;calls.push(p);let result;
  if(p==='/graphql')result=JSON.parse(options.body).query.includes('comments(first:10)')
    ?{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[{isResolved:false,comments:{nodes:[{body:'P2 open',url:'https://github.com/comment'}]}}]}}}}}
    :{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[{isResolved:false}]}}}}};
  else if(p.endsWith('/pulls/422'))result=pr;
  else if(p.endsWith('/check-runs'))result={total_count:1,check_runs:[{name:'AI CAFE PR baseline',status:'completed',conclusion:'success'}]};
  else if(p.endsWith('/reviews'))result=[];
  else if(p.endsWith('/commits/'+head))result={commit:{committer:{date:'2026-11-10T17:59:00Z'}},author:{login:'owner'}};
  else if(p.includes('/compare/'))result={behind_by:1,merge_base_commit:{sha:base},files:[]};
  else if(p.endsWith('/issues/422/comments'))result=[{id:7,user:{login:'owner'},author_association:'OWNER',
    body:'approved',created_at:'2026-11-10T18:00:00Z'}];
  else throw Error('Unexpected '+url);
  return {ok:true,status:200,json:async()=>result}; }}); const fact=await gh.one(pr,main); assert.equal(fact.base_current,false);assert.equal(fact.base_merge_sha,base); assert.ok(calls.some(p=>p.includes('/compare/'+main+'...'+head))); assert.equal(fact.unresolved_codex_comments[0].body,'P2 open'); assert.equal(fact.owner_approved,true);assert.equal(fact.owner_direct_push,true); assert.equal(fact.owner_directive,'approved'); });
