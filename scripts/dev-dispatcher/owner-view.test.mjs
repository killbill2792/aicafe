import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOwnerView,publishOwnerView,OWNER_VIEW_MARKER} from './owner-view.mjs';

const repo='example/aicafe';
const now='2026-11-09T21:15:00Z';
const ledger={version:1,updated_at:'2026-11-09T21:14:00Z',
  tasks:{POS0e:{pr_number:404,github_state:'open',draft:true,ci_state:'failure',
    codex_state:'findings',github_owner_question:'May two tests be edited?',
    github_owner_question_url:'https://github.com/example/aicafe/pull/404#issuecomment-7',
    conversation_ref:'https://chatgpt.com/c/private-secret'},
    POS0d:{pr_number:407,github_state:'open',draft:true,ci_state:'failure',
      codex_state:'clean',head_sha:'a'.repeat(40)}},
  actions:{'private-action-id':{task_id:'POS0d',type:'repair_ci',status:'planned',
    delivery_owner:'muse',created_at:'2026-11-09T20:59:00Z',
    delivery:{prompt:'secret approved private prompt',prompt_hash:'h'.repeat(64),
      conversation_url:'https://chatgpt.com/c/private-secret'}}},
  owner_alerts:{one:{kind:'owner_decision',task_id:'POS0e',pr_number:404,
    status:'planned',question:'secret https://chatgpt.com/c/private-secret'}}};

test('owner control center shows PR, source, CI/Codex, pending Muse and check time without private details',()=>{
 const result=renderOwnerView(ledger,{repo,asOf:now,
   runUrl:'https://github.com/example/aicafe/actions/runs/444'});
 assert.match(result,/May two tests be edited/);
 assert.match(result,/issuecomment-7/);
 assert.match(result,/POS0d/);
 assert.match(result,/Codex/);
 assert.match(result,/clean/);
 assert.match(result,/queued \(not sent\)/);
 assert.match(result,/2026-11-09T21:14:00.000Z/);
 assert.match(result,/Earliest planned-action recheck/);
 assert.doesNotMatch(result,/private-secret|secret approved private prompt|private-action-id|hhhhhhhh/);
 assert.doesNotMatch(result,/chatgpt\.com/);
 assert.match(result,/2026-11-09T21:15:00.000Z/);
});

test('dashboard never exposes private-only question or unsafe source URL',()=>{
 const state=structuredClone(ledger);
 delete state.tasks.POS0e.github_owner_question;
 state.tasks.POS0e.owner_question='Sensitive https://chatgpt.com/c/secret';
 state.tasks.POS0e.github_owner_question_url='https://evil.example/fake';
 const result=renderOwnerView(state,{repo,asOf:now});
 assert.doesNotMatch(result,/Sensitive|evil\.example|chatgpt\.com/);
 assert.match(result,/Owner scope decision requested on this PR/);
 assert.match(result,/https:\/\/github\.com\/example\/aicafe\/pull\/404/);
});

test('owner view publisher creates one bot-owned comment, edits it, and never overwrites human comments',async()=>{
 const sent=[];
 const gh={request:async(path,options)=>{
   sent.push({path,options});
   if(path.endsWith('/comments?per_page=100'))
     return [{id:12,user:{login:'repo-owner'},body:OWNER_VIEW_MARKER+' human'}];
   if(path==='/issues/411/comments'&&options.method==='POST')return{id:45};
   throw Error('Unexpected '+path);
 }};
 const body=OWNER_VIEW_MARKER+'\nLive owner status';
 const result=await publishOwnerView({github:gh,issue:411,body});
 assert.deepEqual(result,{status:'created',id:45});
 assert.equal(sent[1].options.method,'POST');
 assert.equal(JSON.parse(sent[1].options.body).body,body);
 const edited=[];
 const gh2={request:async(path,options)=>{
   edited.push({path,options});
   if(path.endsWith('/comments?per_page=100'))
     return [{id:45,user:{login:'github-actions[bot]'},body:OWNER_VIEW_MARKER+' prior'}];
   if(path==='/issues/comments/45'&&options.method==='PATCH')return{id:45};
   throw Error('Unexpected '+path);
 }};
 assert.deepEqual(await publishOwnerView({github:gh2,issue:411,body}),{status:'updated',id:45});
 assert.equal(edited[1].options.method,'PATCH');
 const unchanged={request:async path=>{
   if(path.endsWith('/comments?per_page=100'))
     return [{id:45,user:{login:'github-actions[bot]'},body}];
   throw Error('Unexpected write');
 }};
 assert.deepEqual(await publishOwnerView({github:unchanged,issue:411,body}),
   {status:'unchanged',id:45});
});
test('dashboard refuses ambiguous or invalid destination and unverified pagination',async()=>{
 const body=OWNER_VIEW_MARKER+'\nPublic status';
 await assert.rejects(publishOwnerView({github:{request:async()=>Array.from({length:100},()=>({}))},
   issue:411,body}),/pagination/);
 await assert.rejects(publishOwnerView({github:{request:async()=>[
   {id:1,user:{login:'github-actions[bot]'},body},
   {id:2,user:{login:'github-actions[bot]'},body}
 ]},issue:411,body}),/Duplicate/);
 await assert.rejects(publishOwnerView({github:{request:async()=>[]},
   issue:411,body:'Arbitrary prompt'}),/Invalid/);
});
