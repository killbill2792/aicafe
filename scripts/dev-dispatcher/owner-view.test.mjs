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

test('merged and integrated PRs never request draft coding work from a stale draft flag',()=>{
 const state=structuredClone(ledger);
 state.tasks.POS0e={pr_number:398,github_state:'merged',status:'merged',draft:true,
   ci_state:'success',codex_state:'pending',owner_question:null};
 state.tasks.POS0d={pr_number:378,github_state:'merged',status:'integrated_proven',
   draft:true,owner_question:null};
 const view=renderOwnerView(state,{repo,asOf:now});
 assert.match(view,/Dispatcher verifies merged-main integration proof/);
 assert.match(view,/Integrated; no coder action/);
 assert.doesNotMatch(view,/Coder finishes draft\/proof/);
});

test('released-proven task has no coder next step despite stale draft and private question',()=>{
 const state=structuredClone(ledger);
 state.tasks.POS0e={pr_number:398,github_state:'merged',status:'released_proven',
   draft:true,owner_question:'obsolete private question'};
 const view=renderOwnerView(state,{repo,asOf:now});
 assert.match(view,/Integrated; no coder action/);
 assert.doesNotMatch(view,/Owner decision \\+ coder can continue signed work/);
});


test('renders a live approved-task dependency graph from the one queue and current ledger',()=>{
 const queue={
   merged_code_only:[{id:'5',pr:378}],
   tasks:[
     {id:'POS0a',title:'Approved architecture',architecture_approval:{approved:true},depends_on:[]},
     {id:'POS0e',title:'Shared reader',architecture_approval:{approved:true},depends_on:['POS0a']},
     {id:'POS0b',title:'Labor',architecture_approval:{approved:true},depends_on:['POS0a','POS0e']},
     {id:'POS0f',title:'Integration proof',architecture_approval:{approved:true},depends_on:['POS0e','POS0b']},
     {id:'6',title:'Durable worker',architecture_approval:{approved:true},depends_on:['5','POS0f']},
     {id:'7',title:'Proposed only',state:'proposed',depends_on:['6']}
   ]
 };
 const current=structuredClone(ledger);
 current.tasks.POS0a={pr_number:398,status:'merged',github_state:'merged'};
 current.tasks.POS0b={pr_number:405,draft:true,github_state:'open',ci_state:'failure'};
 current.tasks['5']={pr_number:378,status:'integrated_proven',github_state:'merged'};
 current.tasks['6']={status:'blocked_needs_owner'};
 const view=renderOwnerView(current,{repo,asOf:now,queue});
 assert.match(view,/flowchart TD/);
 assert.match(view,/T_POS0a --> T_POS0e/);
 assert.match(view,/T_POS0e --> T_POS0b/);
 assert.match(view,/T_POS0f --> T_6/);
 assert.match(view,/T_5 --> T_6/);
 assert.match(view,/POS0e - Shared reader/);
 assert.match(view,/PR #404 - Needs owner decision/);
 assert.match(view,/PR #398 - Merged/);
 assert.match(view,/PR #378 - Integrated and proven/);
 assert.match(view,/1 proposed task briefs are not approved/);
 assert.doesNotMatch(view,/T_7|Proposed only/);
 assert.doesNotMatch(view,/private-secret|secret approved private prompt|chatgpt[.]com/);
});

test('approved-task diagram updates with GitHub facts and ignores diagram injection',()=>{
 const queue={merged_code_only:[],tasks:[
   {id:'POS0e',title:'Reader"]\nclick T_POS0e outside',architecture_approval:{approved:true},depends_on:[]}
 ]};
 const current=structuredClone(ledger);
 const first=renderOwnerView(current,{repo,asOf:now,queue});
 assert.match(first,/Needs owner decision/);
 assert.doesNotMatch(first,/Reader"\]/);
 assert.doesNotMatch(first,/\nclick T_POS0e/);
 current.tasks.POS0e.github_owner_question=null;
 current.tasks.POS0e.ci_state='success';
 current.tasks.POS0e.codex_state='clean';
 const second=renderOwnerView(current,{repo,asOf:now,queue});
 assert.match(second,/PR #404 - Draft PR/);
 assert.doesNotMatch(second,/PR #404 - Needs owner decision/);
 const missingQueue=renderOwnerView(current,{repo,asOf:now});
 assert.doesNotMatch(missingQueue,/flowchart TD/);
});


test('public owner view flags Muse receipt repair without leaking action identity or private URL',()=>{
 const s=structuredClone(ledger);
 s.actions={};
 delete s.tasks.POS0e.github_owner_question;
 s.receipt_feedback={'assign:POS0e':{task_id:'POS0e',status:'rejected',
  code:'unattributed_git_actor',first_seen_at:'2026-11-09T20:00:00Z'}};
 s.receipt_scan={complete:false};
 const html=renderOwnerView(s,{repo,asOf:now});
 assert.match(html,/receipt rejected; Muse re-authenticates original/);
 assert.match(html,/Muse repairs signed receipt/);
 assert.match(html,/receipt-authentication hold/);
 assert.match(html,/Courier receipt scan incomplete/);
 assert.doesNotMatch(html,/assign:POS0e|unattributed_git_actor|chatgpt\.com/);
});
